import { createHmac, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  AgentRepositoryKeyPublicationError,
  parseAgentRepositoryKeyVerifierEntry,
  publishAgentRepositoryKeyMarker,
} from "./agent-run-repository-key-cleanup";
import {
  AGENT_REPOSITORY_KEY_MARKER,
  AgentRepositoryDirectoryPin,
  agentRepositoryKeyMarkerPath,
  type CanonicalAgentRepositoryDirectory,
} from "./agent-run-repository-key-path";
import { withAgentRepositoryKeyProcessLock } from "./agent-run-repository-key-process-lock";

export { AGENT_REPOSITORY_KEY_MARKER } from "./agent-run-repository-key-path";

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
      await withAgentRepositoryKeyProcessLock(directory.path, async () => {
        await this.#assertPinnedDirectory(directory);
        await this.#verifyOrInitialize(directory);
        await this.#assertPinnedDirectory(directory);
      });
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
    let verifier: string;
    try {
      verifier = await this.#readMarker(directory);
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
    const expected = Buffer.from(this.#verifier(), "hex");
    const actual = Buffer.from(verifier, "hex");
    if (!timingSafeEqual(actual, expected)) throw new AgentRepositoryKeyMismatchError();
  }

  async #readMarker(directory: CanonicalAgentRepositoryDirectory): Promise<string> {
    const markerPath = agentRepositoryKeyMarkerPath(directory.path);
    const marker = await open(
      markerPath,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      const metadata = await marker.stat();
      if (!metadata.isDirectory() || (metadata.mode & 0o777) !== 0o700) {
        throw new AgentRepositoryKeyMarkerError(
          "Agent repository key marker is not a safe directory",
        );
      }
      const entries = await readdir(markerPath);
      const [entryName] = entries;
      if (entryName === undefined || entries.length !== 1) {
        throw new AgentRepositoryKeyMarkerError("Agent repository key marker layout is invalid");
      }
      const verifier = parseAgentRepositoryKeyVerifierEntry(entryName);
      if (verifier === undefined) {
        throw new AgentRepositoryKeyMarkerError("Agent repository key verifier is invalid");
      }
      const entryPath = join(markerPath, entryName);
      const entry = await open(entryPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const [openedEntry, linkedEntry, linkedMarker] = await Promise.all([
          entry.stat(),
          lstat(entryPath),
          lstat(markerPath),
        ]);
        if (
          !openedEntry.isFile() ||
          openedEntry.size !== 0 ||
          openedEntry.nlink !== 1 ||
          (openedEntry.mode & 0o777) !== 0o600 ||
          !linkedEntry.isFile() ||
          linkedEntry.dev !== openedEntry.dev ||
          linkedEntry.ino !== openedEntry.ino ||
          !linkedMarker.isDirectory() ||
          linkedMarker.dev !== metadata.dev ||
          linkedMarker.ino !== metadata.ino
        ) {
          throw new AgentRepositoryKeyMarkerError("Agent repository key marker identity changed");
        }
      } finally {
        await entry.close();
      }
      return verifier;
    } finally {
      await marker.close();
    }
  }

  async #publish(directory: CanonicalAgentRepositoryDirectory): Promise<void> {
    try {
      const result = await publishAgentRepositoryKeyMarker(directory, this.#verifier());
      if (result === "published") await this.#syncDirectory(directory);
    } catch (error) {
      if (error instanceof AgentRepositoryKeyPublicationError) {
        throw new AgentRepositoryKeyMarkerError("Agent repository key marker publication failed", {
          cause: error,
        });
      }
      throw error;
    }
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
