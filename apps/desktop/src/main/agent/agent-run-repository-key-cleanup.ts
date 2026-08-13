import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, rmdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

const QUARANTINE_PREFIX = ".haksulsomoim-agent-repository-cleanup.";
const QUARANTINE_ENTRY = "entry";
const MAX_QUARANTINE_ATTEMPTS = 8;
const TOKEN_PATTERN = /^[a-f0-9]{32}$/u;

export type AgentRepositoryTemporaryIdentity = Readonly<{ dev: number; ino: number }>;

export type AgentRepositoryKeyCleanupCheckpoint = Readonly<{
  phase: "before-entry-capture" | "before-no-replace-capture" | "after-entry-captured";
  sourcePath: string;
  quarantinePath: string;
}>;

export type AgentRepositoryKeyCleanupControl = Readonly<{
  checkpoint?: (checkpoint: AgentRepositoryKeyCleanupCheckpoint) => Promise<void>;
  token?: () => string;
}>;

type Quarantine = Readonly<{ directory: string; entry: string }>;

type AgentRepositoryKeyCleanupPlatform = Readonly<{
  captureNoReplace(sourcePath: string, destinationPath: string): Promise<void>;
}>;

const hardLinkCleanupPlatform: AgentRepositoryKeyCleanupPlatform = {
  captureNoReplace: link,
};

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export class AgentRepositoryKeyCleanupError extends Error {
  readonly code = "AGENT_REPOSITORY_KEY_MARKER_CLEANUP_FAILED";
  readonly quarantinePath: string | undefined;

  constructor(message: string, quarantinePath?: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AgentRepositoryKeyCleanupError";
    this.quarantinePath = quarantinePath;
  }
}

function cleanupError(
  message: string,
  quarantinePath: string,
  cause?: unknown,
): AgentRepositoryKeyCleanupError {
  const options = cause === undefined ? undefined : { cause };
  return new AgentRepositoryKeyCleanupError(message, quarantinePath, options);
}

async function createQuarantine(
  sourcePath: string,
  control: AgentRepositoryKeyCleanupControl,
): Promise<Quarantine> {
  const parent = dirname(sourcePath);
  for (let attempt = 0; attempt < MAX_QUARANTINE_ATTEMPTS; attempt += 1) {
    const token = control.token?.() ?? randomBytes(16).toString("hex");
    if (!TOKEN_PATTERN.test(token)) {
      throw new AgentRepositoryKeyCleanupError("Agent repository cleanup token is invalid");
    }
    const directory = join(parent, `${QUARANTINE_PREFIX}${token}`);
    try {
      await mkdir(directory, { mode: 0o700 });
      return { directory, entry: join(directory, QUARANTINE_ENTRY) };
    } catch (error) {
      if (isNodeError(error, "EEXIST")) continue;
      throw cleanupError("Agent repository cleanup quarantine creation failed", directory, error);
    }
  }
  throw new AgentRepositoryKeyCleanupError("Agent repository cleanup quarantine allocation failed");
}

async function captureEntryNoReplace(
  sourcePath: string,
  quarantine: Quarantine,
  control: AgentRepositoryKeyCleanupControl,
): Promise<void> {
  await control.checkpoint?.({
    phase: "before-entry-capture",
    sourcePath,
    quarantinePath: quarantine.entry,
  });
  await control.checkpoint?.({
    phase: "before-no-replace-capture",
    sourcePath,
    quarantinePath: quarantine.entry,
  });
  try {
    await hardLinkCleanupPlatform.captureNoReplace(sourcePath, quarantine.entry);
  } catch (error) {
    throw cleanupError(
      "Agent repository temporary no-replace capture failed",
      quarantine.entry,
      error,
    );
  }
}

function matchesOwnedFile(
  metadata: Awaited<ReturnType<typeof lstat>>,
  identity: AgentRepositoryTemporaryIdentity,
): boolean {
  return metadata.isFile() && metadata.dev === identity.dev && metadata.ino === identity.ino;
}

async function openCapturedOwnedEntry(
  quarantine: Quarantine,
  identity: AgentRepositoryTemporaryIdentity,
): Promise<Awaited<ReturnType<typeof open>>> {
  let file: Awaited<ReturnType<typeof open>>;
  try {
    file = await open(quarantine.entry, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    throw cleanupError(
      "Agent repository quarantined temporary is not a safe file",
      quarantine.entry,
      error,
    );
  }
  try {
    const [opened, linked] = await Promise.all([file.stat(), lstat(quarantine.entry)]);
    if (!matchesOwnedFile(opened, identity) || !matchesOwnedFile(linked, identity)) {
      throw cleanupError("Agent repository quarantined temporary is not owned", quarantine.entry);
    }
    return file;
  } catch (error) {
    await file.close();
    if (error instanceof AgentRepositoryKeyCleanupError) throw error;
    throw cleanupError(
      "Agent repository quarantined temporary identity check failed",
      quarantine.entry,
      error,
    );
  }
}

async function removeCapturedOwnedEntry(
  sourcePath: string,
  quarantine: Quarantine,
  identity: AgentRepositoryTemporaryIdentity,
  control: AgentRepositoryKeyCleanupControl,
): Promise<void> {
  const file = await openCapturedOwnedEntry(quarantine, identity);
  try {
    await unlink(sourcePath);
    await control.checkpoint?.({
      phase: "after-entry-captured",
      sourcePath,
      quarantinePath: quarantine.entry,
    });
    const linked = await lstat(quarantine.entry);
    if (!matchesOwnedFile(linked, identity)) {
      throw cleanupError(
        "Agent repository quarantined temporary identity changed",
        quarantine.entry,
      );
    }
    await unlink(quarantine.entry);
  } catch (error) {
    if (error instanceof AgentRepositoryKeyCleanupError) throw error;
    throw cleanupError(
      "Agent repository quarantined temporary removal failed",
      quarantine.entry,
      error,
    );
  } finally {
    await file.close();
  }
  try {
    await rmdir(quarantine.directory);
  } catch (error) {
    throw cleanupError(
      "Agent repository cleanup quarantine removal failed",
      quarantine.entry,
      error,
    );
  }
}

export async function cleanupAgentRepositoryKeyTemporary(
  sourcePath: string,
  identity: AgentRepositoryTemporaryIdentity,
  control: AgentRepositoryKeyCleanupControl = {},
): Promise<void> {
  const quarantine = await createQuarantine(sourcePath, control);
  await captureEntryNoReplace(sourcePath, quarantine, control);
  await removeCapturedOwnedEntry(sourcePath, quarantine, identity, control);
}
