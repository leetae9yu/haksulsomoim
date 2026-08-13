import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, writeSync } from "node:fs";
import { open } from "node:fs/promises";
import { agentRepositoryKeyNativeBinding } from "./agent-run-repository-key-native";
import {
  AGENT_REPOSITORY_KEY_MARKER,
  agentRepositoryKeyMarkerPath,
  type CanonicalAgentRepositoryDirectory,
} from "./agent-run-repository-key-path";

const MARKER_PREFIX = Buffer.from("haksulsomoim-agent-repository-key:v1:", "ascii");
const MARKER_SUFFIX = Buffer.from("\n", "ascii");
const VERIFIER_PATTERN = /^[a-f0-9]{64}$/u;

export const AGENT_REPOSITORY_KEY_MARKER_BYTES =
  MARKER_PREFIX.byteLength + 64 + MARKER_SUFFIX.byteLength;

export type AgentRepositoryKeyPublicationCheckpoint = Readonly<{
  phase: "before-source-capture" | "after-source-created" | "after-source-written";
  sourcePath: string;
}>;

export type AgentRepositoryKeyPublicationControl = Readonly<{
  checkpoint?: (checkpoint: AgentRepositoryKeyPublicationCheckpoint) => Promise<void>;
}>;

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function syncBestEffort(fd: number): void {
  try {
    fsyncSync(fd);
  } catch (error) {
    if (!isNodeError(error, "EPERM")) throw error;
  }
}

function writeAll(fd: number, data: Uint8Array): void {
  let offset = 0;
  while (offset < data.byteLength) {
    const written = writeSync(fd, data, offset, data.byteLength - offset);
    if (written <= 0) {
      throw Object.assign(new Error("Marker write made no progress"), { code: "EIO" });
    }
    offset += written;
  }
}

export class AgentRepositoryKeyPublicationError extends Error {
  readonly code = "AGENT_REPOSITORY_KEY_MARKER_PUBLICATION_FAILED";
  readonly markerPath: string;

  constructor(message: string, markerPath: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AgentRepositoryKeyPublicationError";
    this.markerPath = markerPath;
  }
}

export function serializeAgentRepositoryKeyMarker(verifier: string): Buffer {
  if (!VERIFIER_PATTERN.test(verifier)) {
    throw new AgentRepositoryKeyPublicationError("Agent repository key verifier is invalid", "");
  }
  return Buffer.concat([MARKER_PREFIX, Buffer.from(verifier, "ascii"), MARKER_SUFFIX]);
}

export function parseAgentRepositoryKeyMarker(data: Uint8Array): string | undefined {
  const marker = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (
    marker.byteLength !== AGENT_REPOSITORY_KEY_MARKER_BYTES ||
    !marker.subarray(0, MARKER_PREFIX.byteLength).equals(MARKER_PREFIX) ||
    !marker.subarray(-MARKER_SUFFIX.byteLength).equals(MARKER_SUFFIX)
  ) {
    return undefined;
  }
  const verifierBytes = marker.subarray(MARKER_PREFIX.byteLength, -MARKER_SUFFIX.byteLength);
  const verifier = verifierBytes.toString("ascii");
  return VERIFIER_PATTERN.test(verifier) && Buffer.from(verifier, "ascii").equals(verifierBytes)
    ? verifier
    : undefined;
}

/**
 * Publishes one fixed marker inode. A crash after exclusive creation deliberately leaves a
 * permanent fail-closed partial marker; publication never repairs or rolls back pathnames.
 */
export async function publishAgentRepositoryKeyMarker(
  canonical: CanonicalAgentRepositoryDirectory,
  verifier: string,
  control: AgentRepositoryKeyPublicationControl = {},
): Promise<"contended" | "published"> {
  const markerPath = agentRepositoryKeyMarkerPath(canonical.path);
  const markerData = serializeAgentRepositoryKeyMarker(verifier);
  let parent: Awaited<ReturnType<typeof open>> | undefined;
  try {
    parent = await open(
      canonical.path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const metadata = await parent.stat();
    if (
      !metadata.isDirectory() ||
      metadata.dev !== canonical.dev ||
      metadata.ino !== canonical.ino
    ) {
      throw new AgentRepositoryKeyPublicationError(
        "Agent repository key marker parent identity changed",
        markerPath,
      );
    }
  } catch (error) {
    await parent?.close().catch(() => undefined);
    if (error instanceof AgentRepositoryKeyPublicationError) throw error;
    throw new AgentRepositoryKeyPublicationError(
      "Agent repository key marker parent is not a safe directory",
      markerPath,
      { cause: error },
    );
  }

  try {
    await control.checkpoint?.({ phase: "before-source-capture", sourcePath: markerPath });
    const binding = agentRepositoryKeyNativeBinding();
    let markerFd: number;
    try {
      markerFd = binding.openBeneath(
        parent.fd,
        AGENT_REPOSITORY_KEY_MARKER,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      ).fd;
    } catch (error) {
      if (isNodeError(error, "EEXIST")) return "contended";
      throw new AgentRepositoryKeyPublicationError(
        "Agent repository key marker capture failed",
        markerPath,
        { cause: error },
      );
    }

    try {
      await control.checkpoint?.({ phase: "after-source-created", sourcePath: markerPath });
      fchmodSync(markerFd, 0o600);
      const created = fstatSync(markerFd);
      if (
        !created.isFile() ||
        created.size !== 0 ||
        created.nlink !== 1 ||
        (created.mode & 0o777) !== 0o600
      ) {
        throw new AgentRepositoryKeyPublicationError(
          "Agent repository key marker capture is invalid",
          markerPath,
        );
      }
      writeAll(markerFd, markerData);
      syncBestEffort(markerFd);
      await control.checkpoint?.({ phase: "after-source-written", sourcePath: markerPath });

      let pathFd: number | undefined;
      try {
        pathFd = binding.openBeneath(
          parent.fd,
          AGENT_REPOSITORY_KEY_MARKER,
          constants.O_RDONLY | constants.O_NOFOLLOW,
        ).fd;
        const [written, linked] = [fstatSync(markerFd), fstatSync(pathFd)];
        if (
          !written.isFile() ||
          written.size !== markerData.byteLength ||
          written.nlink !== 1 ||
          (written.mode & 0o777) !== 0o600 ||
          !linked.isFile() ||
          linked.dev !== written.dev ||
          linked.ino !== written.ino ||
          linked.size !== written.size ||
          linked.nlink !== 1 ||
          (linked.mode & 0o777) !== 0o600
        ) {
          throw new AgentRepositoryKeyPublicationError(
            "Agent repository key marker path identity changed",
            markerPath,
          );
        }
      } catch (error) {
        if (error instanceof AgentRepositoryKeyPublicationError) throw error;
        throw new AgentRepositoryKeyPublicationError(
          "Agent repository key marker path identity changed",
          markerPath,
          { cause: error },
        );
      } finally {
        if (pathFd !== undefined) closeSync(pathFd);
      }
    } catch (error) {
      if (error instanceof AgentRepositoryKeyPublicationError) throw error;
      throw new AgentRepositoryKeyPublicationError(
        "Agent repository key marker publication failed",
        markerPath,
        { cause: error },
      );
    } finally {
      closeSync(markerFd);
    }
    try {
      syncBestEffort(parent.fd);
    } catch (error) {
      throw new AgentRepositoryKeyPublicationError(
        "Agent repository key marker parent sync failed",
        markerPath,
        { cause: error },
      );
    }
    return "published";
  } finally {
    await parent.close();
  }
}
