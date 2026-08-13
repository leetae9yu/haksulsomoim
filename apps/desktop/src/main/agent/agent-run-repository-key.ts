import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, readdir } from "node:fs/promises";
import { z } from "zod";
import {
  type AgentRepositoryTemporaryIdentity,
  cleanupAgentRepositoryKeyTemporary,
} from "./agent-run-repository-key-cleanup";
import {
  AGENT_REPOSITORY_KEY_MARKER,
  AgentRepositoryDirectoryPin,
  agentRepositoryKeyPublicationPaths,
  type CanonicalAgentRepositoryDirectory,
} from "./agent-run-repository-key-path";

export { AGENT_REPOSITORY_KEY_MARKER } from "./agent-run-repository-key-path";

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
  readonly #directory: AgentRepositoryDirectoryPin;
  readonly #key: Uint8Array;

  constructor(directory: string, key: Uint8Array) {
    this.#directory = new AgentRepositoryDirectoryPin(directory);
    this.#key = Uint8Array.from(key);
  }

  async verify(): Promise<void> {
    let directory: CanonicalAgentRepositoryDirectory;
    try {
      directory = await this.#directory.resolve();
    } catch (error) {
      throw new AgentRepositoryKeyMarkerError(
        "Agent repository directory cannot be canonicalized",
        { cause: error },
      );
    }
    await this.#assertPinnedDirectory(directory);
    await this.#serialize(directory.path, async () => {
      await this.#assertPinnedDirectory(directory);
      await this.#verifyOrInitialize(directory);
      await this.#assertPinnedDirectory(directory);
    });
  }

  async #verifyOrInitialize(directory: CanonicalAgentRepositoryDirectory): Promise<void> {
    try {
      await this.#readAndVerify(directory);
      return;
    } catch (error) {
      if (!(error instanceof AgentRepositoryKeyMarkerError) || error.cause !== "missing") {
        throw error;
      }
    }
    const entries = await readdir(directory.path);
    if (entries.includes(AGENT_REPOSITORY_KEY_MARKER)) {
      await this.#readAndVerify(directory);
      return;
    }
    if (entries.length > 0) {
      throw new AgentRepositoryKeyMarkerError(
        "Agent repository key marker is missing from a nonempty repository",
      );
    }
    await this.#publish(directory);
    await this.#readAndVerify(directory);
  }

  async #readAndVerify(directory: CanonicalAgentRepositoryDirectory): Promise<void> {
    let serialized: string;
    try {
      serialized = await this.#readMarker(directory);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        throw new AgentRepositoryKeyMarkerError("Agent repository key marker is missing", {
          cause: "missing",
        });
      }
      if (error instanceof AgentRepositoryKeyMarkerError) throw error;
      throw new AgentRepositoryKeyMarkerError("Agent repository key marker is invalid", {
        cause: error,
      });
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

  async #readMarker(directory: CanonicalAgentRepositoryDirectory): Promise<string> {
    const { marker } = agentRepositoryKeyPublicationPaths(directory.path, "read");
    const file = await open(marker, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const metadata = await file.stat();
      if (!metadata.isFile() || (metadata.mode & 0o777) !== 0o600) {
        throw new AgentRepositoryKeyMarkerError("Agent repository key marker is not a safe file");
      }
      const serialized = await file.readFile("utf8");
      const linked = await lstat(marker);
      if (!linked.isFile() || linked.dev !== metadata.dev || linked.ino !== metadata.ino) {
        throw new AgentRepositoryKeyMarkerError("Agent repository key marker identity changed");
      }
      return serialized;
    } finally {
      await file.close();
    }
  }

  async #publish(directory: CanonicalAgentRepositoryDirectory): Promise<void> {
    const serialized = JSON.stringify({ version: 1, verifier: this.#verifier() });
    const paths = agentRepositoryKeyPublicationPaths(
      directory.path,
      randomBytes(12).toString("hex"),
    );
    let identity: AgentRepositoryTemporaryIdentity | undefined;
    let failure: Readonly<{ error: unknown }> | undefined;
    let published = false;
    try {
      const file = await open(paths.temporary, "wx", 0o600);
      try {
        const metadata = await file.stat();
        identity = { dev: metadata.dev, ino: metadata.ino };
        await file.writeFile(serialized, "utf8");
        await file.sync();
      } finally {
        await file.close();
      }
      try {
        await link(paths.temporary, paths.marker);
        published = true;
      } catch (error) {
        if (!isNodeError(error, "EEXIST")) throw error;
      }
    } catch (error) {
      failure = { error };
    }
    if (identity !== undefined) {
      try {
        await cleanupAgentRepositoryKeyTemporary(paths.temporary, identity);
      } catch (cleanupError) {
        if (failure === undefined) throw cleanupError;
        throw new AggregateError(
          [failure.error, cleanupError],
          "Agent repository key marker publication cleanup failed",
        );
      }
    }
    if (failure !== undefined) throw failure.error;
    if (published) await this.#syncDirectory(directory);
  }

  #verifier(): string {
    return createHmac("sha256", this.#key)
      .update("haksulsomoim:agent-repository-key:v1\0")
      .digest("hex");
  }

  async #assertPinnedDirectory(directory: CanonicalAgentRepositoryDirectory): Promise<void> {
    if (!(await this.#directory.matches(directory))) {
      throw new AgentRepositoryKeyMarkerError("Agent repository canonical directory changed");
    }
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

  async #syncDirectory(canonical: CanonicalAgentRepositoryDirectory): Promise<void> {
    const directory = await open(canonical.path, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
}
