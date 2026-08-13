import { closeSync, constants, fchmodSync, fstatSync, fsyncSync } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { agentRepositoryKeyNativeBinding } from "./agent-run-repository-key-native";
import {
  AGENT_REPOSITORY_KEY_MARKER,
  agentRepositoryKeyMarkerPath,
  type CanonicalAgentRepositoryDirectory,
} from "./agent-run-repository-key-path";

const VERIFIER_PREFIX = "verifier-";
const VERIFIER_PATTERN = /^[a-f0-9]{64}$/u;

export type AgentRepositoryKeyPublicationCheckpoint = Readonly<{
  phase:
    | "before-source-capture"
    | "after-source-created"
    | "after-source-proof"
    | "after-verifier-captured";
  sourcePath: string;
  verifierPath: string;
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

export class AgentRepositoryKeyPublicationError extends Error {
  readonly code = "AGENT_REPOSITORY_KEY_MARKER_PUBLICATION_FAILED";
  readonly markerPath: string;

  constructor(message: string, markerPath: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AgentRepositoryKeyPublicationError";
    this.markerPath = markerPath;
  }
}

export function agentRepositoryKeyVerifierEntry(verifier: string): string {
  if (!VERIFIER_PATTERN.test(verifier)) {
    throw new AgentRepositoryKeyPublicationError("Agent repository key verifier is invalid", "");
  }
  return `${VERIFIER_PREFIX}${verifier}`;
}

export function parseAgentRepositoryKeyVerifierEntry(entry: string): string | undefined {
  if (!entry.startsWith(VERIFIER_PREFIX)) return undefined;
  const verifier = entry.slice(VERIFIER_PREFIX.length);
  return VERIFIER_PATTERN.test(verifier) ? verifier : undefined;
}

export async function publishAgentRepositoryKeyMarker(
  canonical: CanonicalAgentRepositoryDirectory,
  verifier: string,
  control: AgentRepositoryKeyPublicationControl = {},
): Promise<"contended" | "published"> {
  const markerPath = agentRepositoryKeyMarkerPath(canonical.path);
  const verifierEntry = agentRepositoryKeyVerifierEntry(verifier);
  const verifierPath = join(markerPath, verifierEntry);
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
    await control.checkpoint?.({
      phase: "before-source-capture",
      sourcePath: markerPath,
      verifierPath,
    });

    const binding = agentRepositoryKeyNativeBinding();
    let directoryFd: number;
    try {
      directoryFd = binding.createDirectoryBeneath(
        parent.fd,
        AGENT_REPOSITORY_KEY_MARKER,
        0o700,
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
      await control.checkpoint?.({
        phase: "after-source-created",
        sourcePath: markerPath,
        verifierPath,
      });
      fchmodSync(directoryFd, 0o700);
      const directory = fstatSync(directoryFd);
      if (!directory.isDirectory()) {
        throw new AgentRepositoryKeyPublicationError(
          "Agent repository key marker source is not a safe directory",
          markerPath,
        );
      }
      await control.checkpoint?.({
        phase: "after-source-proof",
        sourcePath: markerPath,
        verifierPath,
      });

      let verifierFd: number | undefined;
      try {
        verifierFd = binding.openBeneath(
          directoryFd,
          verifierEntry,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        ).fd;
        fchmodSync(verifierFd, 0o600);
        const metadata = fstatSync(verifierFd);
        if (!metadata.isFile() || metadata.size !== 0) {
          throw new AgentRepositoryKeyPublicationError(
            "Agent repository key verifier capture is invalid",
            markerPath,
          );
        }
        syncBestEffort(verifierFd);
        await control.checkpoint?.({
          phase: "after-verifier-captured",
          sourcePath: markerPath,
          verifierPath,
        });
      } finally {
        if (verifierFd !== undefined) closeSync(verifierFd);
      }
      syncBestEffort(directoryFd);
      syncBestEffort(parent.fd);
      return "published";
    } catch (error) {
      if (error instanceof AgentRepositoryKeyPublicationError) throw error;
      throw new AgentRepositoryKeyPublicationError(
        "Agent repository key verifier publication failed",
        markerPath,
        { cause: error },
      );
    } finally {
      closeSync(directoryFd);
    }
  } finally {
    await parent.close();
  }
}
