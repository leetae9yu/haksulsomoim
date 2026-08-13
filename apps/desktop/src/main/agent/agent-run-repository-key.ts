import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { link, mkdir, open, readdir, readFile, realpath, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

export const AGENT_REPOSITORY_KEY_MARKER = ".agent-repository-key";
const TEMPORARY_MARKER_PREFIX = `${AGENT_REPOSITORY_KEY_MARKER}.`;
const markerSchema = z.strictObject({
  version: z.literal(1),
  verifier: z.string().regex(/^[a-f0-9]{64}$/u),
});
const verificationTails = new Map<string, Promise<void>>();

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export class AgentRepositoryKeyMismatchError extends Error {
  readonly code = "AGENT_REPOSITORY_KEY_MISMATCH";

  constructor() {
    super("Agent repository encryption key does not match");
    this.name = "AgentRepositoryKeyMismatchError";
  }
}

export class AgentRepositoryKeyMarkerError extends Error {
  readonly code = "AGENT_REPOSITORY_KEY_MARKER_INVALID";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AgentRepositoryKeyMarkerError";
  }
}

export class AgentRepositoryKeyVerifier {
  readonly #directory: string;
  readonly #key: Uint8Array;

  constructor(directory: string, key: Uint8Array) {
    this.#directory = directory;
    this.#key = Uint8Array.from(key);
  }

  async verify(): Promise<void> {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const lockKey = await realpath(this.#directory);
    await this.#serialize(lockKey, () => this.#verifyOrInitialize());
  }

  async #verifyOrInitialize(): Promise<void> {
    try {
      await this.#readAndVerify();
      return;
    } catch (error) {
      if (!(error instanceof AgentRepositoryKeyMarkerError) || error.cause !== "missing") {
        throw error;
      }
    }
    const entries = await readdir(this.#directory);
    if (entries.includes(AGENT_REPOSITORY_KEY_MARKER)) {
      await this.#readAndVerify();
      return;
    }
    const unexpected = entries.filter((name) => !name.startsWith(TEMPORARY_MARKER_PREFIX));
    if (unexpected.length > 0) {
      throw new AgentRepositoryKeyMarkerError(
        "Agent repository key marker is missing from a nonempty repository",
      );
    }
    await this.#publish();
    await this.#readAndVerify();
  }

  async #readAndVerify(): Promise<void> {
    let serialized: string;
    try {
      serialized = await readFile(this.#path(), "utf8");
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        throw new AgentRepositoryKeyMarkerError("Agent repository key marker is missing", {
          cause: "missing",
        });
      }
      throw error;
    }
    let verifier: string;
    try {
      verifier = markerSchema.parse(JSON.parse(serialized)).verifier;
    } catch (error) {
      throw new AgentRepositoryKeyMarkerError("Agent repository key marker is invalid", {
        cause: error,
      });
    }
    const expected = Buffer.from(this.#verifier(), "hex");
    const actual = Buffer.from(verifier, "hex");
    if (!timingSafeEqual(actual, expected)) throw new AgentRepositoryKeyMismatchError();
  }

  async #publish(): Promise<void> {
    const serialized = JSON.stringify({ version: 1, verifier: this.#verifier() });
    const temporaryPath = join(
      this.#directory,
      `${TEMPORARY_MARKER_PREFIX}${randomBytes(12).toString("hex")}.tmp`,
    );
    let published = false;
    try {
      const file = await open(temporaryPath, "wx", 0o600);
      try {
        await file.writeFile(serialized, "utf8");
        await file.sync();
      } finally {
        await file.close();
      }
      try {
        await link(temporaryPath, this.#path());
        published = true;
      } catch (error) {
        if (!isNodeError(error, "EEXIST")) throw error;
      }
      await unlink(temporaryPath);
      if (published) await this.#syncDirectory();
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  #verifier(): string {
    return createHmac("sha256", this.#key)
      .update("haksulsomoim:agent-repository-key:v1\0")
      .digest("hex");
  }

  #path(): string {
    return join(this.#directory, AGENT_REPOSITORY_KEY_MARKER);
  }

  async #serialize(lockKey: string, operation: () => Promise<void>): Promise<void> {
    const previous = verificationTails.get(lockKey) ?? Promise.resolve();
    let release = (): void => undefined;
    const turn = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => turn);
    verificationTails.set(lockKey, tail);
    await previous;
    try {
      await operation();
    } finally {
      release();
      if (verificationTails.get(lockKey) === tail) verificationTails.delete(lockKey);
    }
  }

  async #syncDirectory(): Promise<void> {
    const directory = await open(this.#directory, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
}
