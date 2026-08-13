import { closeSync, constants, fchmodSync, fstatSync, fsyncSync } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const VERIFIER_PREFIX = "verifier-";
const VERIFIER_PATTERN = /^[a-f0-9]{64}$/u;
const require = createRequire(import.meta.url);

export type AgentRepositoryKeyPublicationCheckpoint = Readonly<{
  phase: "before-source-capture" | "after-source-proof" | "after-verifier-captured";
  sourcePath: string;
  verifierPath: string;
}>;

export type AgentRepositoryKeyPublicationControl = Readonly<{
  checkpoint?: (checkpoint: AgentRepositoryKeyPublicationCheckpoint) => Promise<void>;
}>;

type NativeOpenResult = Readonly<{ fd: number }>;
type NativeBinding = Readonly<{
  openBeneath(rootFd: number, relativePath: string, flags: number): NativeOpenResult;
}>;

let loadedNativeBinding: NativeBinding | undefined;

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function isNativeBinding(value: unknown): value is NativeBinding {
  return (
    typeof value === "object" &&
    value !== null &&
    "openBeneath" in value &&
    typeof value.openBeneath === "function"
  );
}

function nativeBinding(): NativeBinding {
  if (loadedNativeBinding !== undefined) return loadedNativeBinding;
  const packageRoot = dirname(require.resolve("@openclaw/fs-safe/package.json"));
  const loader: unknown = require(join(packageRoot, "dist/native.js"));
  if (
    typeof loader !== "object" ||
    loader === null ||
    !("requireNativeBinding" in loader) ||
    typeof loader.requireNativeBinding !== "function"
  ) {
    throw new Error("Agent repository native filesystem helper is invalid");
  }
  const binding: unknown = loader.requireNativeBinding();
  if (!isNativeBinding(binding)) {
    throw new Error("Agent repository native filesystem binding is invalid");
  }
  loadedNativeBinding = binding;
  return binding;
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
  markerPath: string,
  verifier: string,
  control: AgentRepositoryKeyPublicationControl = {},
): Promise<"contended" | "published"> {
  const verifierPath = join(markerPath, agentRepositoryKeyVerifierEntry(verifier));
  await control.checkpoint?.({
    phase: "before-source-capture",
    sourcePath: markerPath,
    verifierPath,
  });
  try {
    await mkdir(markerPath, { mode: 0o700 });
  } catch (error) {
    if (isNodeError(error, "EEXIST")) return "contended";
    throw new AgentRepositoryKeyPublicationError(
      "Agent repository key marker capture failed",
      markerPath,
      { cause: error },
    );
  }

  let directory: Awaited<ReturnType<typeof open>>;
  try {
    directory = await open(
      markerPath,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
  } catch (error) {
    throw new AgentRepositoryKeyPublicationError(
      "Agent repository key marker source is not a safe directory",
      markerPath,
      { cause: error },
    );
  }
  try {
    const [opened, linked] = await Promise.all([directory.stat(), lstat(markerPath)]);
    if (
      !opened.isDirectory() ||
      !linked.isDirectory() ||
      linked.isSymbolicLink() ||
      opened.dev !== linked.dev ||
      opened.ino !== linked.ino
    ) {
      throw new AgentRepositoryKeyPublicationError(
        "Agent repository key marker source identity changed",
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
      verifierFd = nativeBinding().openBeneath(
        directory.fd,
        agentRepositoryKeyVerifierEntry(verifier),
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
    syncBestEffort(directory.fd);
    return "published";
  } catch (error) {
    if (error instanceof AgentRepositoryKeyPublicationError) throw error;
    throw new AgentRepositoryKeyPublicationError(
      "Agent repository key verifier publication failed",
      markerPath,
      { cause: error },
    );
  } finally {
    await directory.close();
  }
}
