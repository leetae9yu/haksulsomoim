import { createHmac, timingSafeEqual } from "node:crypto";
import { closeSync, constants, fstatSync, readSync } from "node:fs";
import { open, readdir } from "node:fs/promises";
import { agentRepositoryKeyNativeBinding } from "./agent-run-repository-key-native";
import {
  AGENT_REPOSITORY_KEY_MARKER,
  AgentRepositoryDirectoryPin,
  type CanonicalAgentRepositoryDirectory,
} from "./agent-run-repository-key-path";
import { withAgentRepositoryKeyProcessLock } from "./agent-run-repository-key-process-lock";
import {
  AGENT_REPOSITORY_KEY_MARKER_BYTES,
  AgentRepositoryKeyPublicationError,
  parseAgentRepositoryKeyMarker,
  publishAgentRepositoryKeyMarker,
} from "./agent-run-repository-key-publication";

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
    const parent = await open(
      directory.path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      const parentMetadata = await parent.stat();
      if (
        !parentMetadata.isDirectory() ||
        parentMetadata.dev !== directory.dev ||
        parentMetadata.ino !== directory.ino
      ) {
        throw new AgentRepositoryKeyMarkerError("Agent repository key marker parent changed");
      }

      const binding = agentRepositoryKeyNativeBinding();
      const markerFd = binding.openBeneath(
        parent.fd,
        AGENT_REPOSITORY_KEY_MARKER,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      ).fd;
      try {
        const opened = fstatSync(markerFd);
        if (
          !opened.isFile() ||
          opened.size !== AGENT_REPOSITORY_KEY_MARKER_BYTES ||
          opened.nlink !== 1 ||
          (opened.mode & 0o777) !== 0o600
        ) {
          throw new AgentRepositoryKeyMarkerError("Agent repository key marker is not a safe file");
        }

        const bounded = Buffer.alloc(AGENT_REPOSITORY_KEY_MARKER_BYTES + 1);
        let bytesRead = 0;
        while (bytesRead < bounded.byteLength) {
          const count = readSync(
            markerFd,
            bounded,
            bytesRead,
            bounded.byteLength - bytesRead,
            null,
          );
          if (count === 0) break;
          bytesRead += count;
        }
        if (bytesRead !== AGENT_REPOSITORY_KEY_MARKER_BYTES) {
          throw new AgentRepositoryKeyMarkerError("Agent repository key marker length is invalid");
        }

        const afterRead = fstatSync(markerFd);
        let pathFd: number | undefined;
        try {
          pathFd = binding.openBeneath(
            parent.fd,
            AGENT_REPOSITORY_KEY_MARKER,
            constants.O_RDONLY | constants.O_NOFOLLOW,
          ).fd;
          const linked = fstatSync(pathFd);
          if (
            !afterRead.isFile() ||
            afterRead.dev !== opened.dev ||
            afterRead.ino !== opened.ino ||
            afterRead.size !== AGENT_REPOSITORY_KEY_MARKER_BYTES ||
            afterRead.nlink !== 1 ||
            (afterRead.mode & 0o777) !== 0o600 ||
            !linked.isFile() ||
            linked.dev !== opened.dev ||
            linked.ino !== opened.ino ||
            linked.size !== AGENT_REPOSITORY_KEY_MARKER_BYTES ||
            linked.nlink !== 1 ||
            (linked.mode & 0o777) !== 0o600
          ) {
            throw new AgentRepositoryKeyMarkerError("Agent repository key marker identity changed");
          }
        } catch (error) {
          if (error instanceof AgentRepositoryKeyMarkerError) throw error;
          throw new AgentRepositoryKeyMarkerError("Agent repository key marker identity changed", {
            cause: error,
          });
        } finally {
          if (pathFd !== undefined) closeSync(pathFd);
        }

        const verifier = parseAgentRepositoryKeyMarker(bounded.subarray(0, bytesRead));
        if (verifier === undefined) {
          throw new AgentRepositoryKeyMarkerError("Agent repository key marker is malformed");
        }
        return verifier;
      } finally {
        closeSync(markerFd);
      }
    } finally {
      await parent.close();
    }
  }

  async #publish(directory: CanonicalAgentRepositoryDirectory): Promise<void> {
    try {
      await publishAgentRepositoryKeyMarker(directory, this.#verifier());
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
}
