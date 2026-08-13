import { afterEach, describe, expect, test } from "bun:test";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  type AgentRepositoryKeyCleanupCheckpoint,
  AgentRepositoryKeyCleanupError,
  type AgentRepositoryTemporaryIdentity,
  cleanupAgentRepositoryKeyTemporary,
} from "./agent-run-repository-key-cleanup";

const QUARANTINE_PREFIX = ".haksulsomoim-agent-repository-cleanup.";
const roots: string[] = [];
const replacementKinds: ReadonlyArray<"directory" | "file" | "symlink"> = [
  "file",
  "symlink",
  "directory",
];

type Fixture = Readonly<{
  identity: AgentRepositoryTemporaryIdentity;
  moved: string;
  parent: string;
  repository: string;
  source: string;
  staged: string;
}>;

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function fixture(label: string): Promise<Fixture> {
  const parent = await mkdtemp(join(tmpdir(), `haksul-cleanup-${label}-`));
  roots.push(parent);
  const repository = join(parent, "repository");
  const source = join(parent, ".haksulsomoim-agent-repository-key.owned.tmp");
  await mkdir(repository, { mode: 0o700 });
  const file = await open(source, "wx", 0o600);
  let identity: AgentRepositoryTemporaryIdentity;
  try {
    await file.writeFile(`owned-${label}`, "utf8");
    const metadata = await file.stat();
    identity = { dev: metadata.dev, ino: metadata.ino };
  } finally {
    await file.close();
  }
  return {
    identity,
    moved: join(parent, "owned-moved"),
    parent,
    repository,
    source,
    staged: join(parent, "attacker-staged"),
  };
}

async function cleanupFailure(operation: Promise<void>): Promise<AgentRepositoryKeyCleanupError> {
  try {
    await operation;
  } catch (error) {
    if (error instanceof AgentRepositoryKeyCleanupError) return error;
    throw error;
  }
  throw new Error("expected typed cleanup failure");
}

function quarantinePath(error: AgentRepositoryKeyCleanupError): string {
  if (error.quarantinePath === undefined) throw new Error("expected reported quarantine path");
  return error.quarantinePath;
}

async function replaceBeforeCapture(kind: "directory" | "file" | "symlink"): Promise<void> {
  const current = await fixture(kind);
  if (kind === "directory") {
    await mkdir(current.staged, { mode: 0o700 });
    await writeFile(join(current.staged, "payload"), "attacker-directory", { mode: 0o600 });
  } else if (kind === "symlink") {
    const target = join(current.parent, "attacker-target");
    await writeFile(target, "attacker-symlink", { mode: 0o600 });
    await symlink(target, current.staged);
  } else {
    await writeFile(current.staged, "attacker-file", { mode: 0o600 });
  }
  const attacker = await lstat(current.staged);
  const error = await cleanupFailure(
    cleanupAgentRepositoryKeyTemporary(current.source, current.identity, {
      checkpoint: async (checkpoint: AgentRepositoryKeyCleanupCheckpoint) => {
        if (checkpoint.phase !== "before-entry-capture") return;
        await rename(current.source, current.moved);
        await rename(current.staged, current.source);
      },
    }),
  );
  const quarantined = quarantinePath(error);

  expect(error.code).toBe("AGENT_REPOSITORY_KEY_MARKER_CLEANUP_FAILED");
  expect(await readFile(current.moved, "utf8")).toBe(`owned-${kind}`);
  expect(relative(current.repository, quarantined).startsWith("..")).toBe(true);
  if (kind === "directory") {
    expect(await exists(quarantined)).toBe(false);
    expect(await readFile(join(current.source, "payload"), "utf8")).toBe("attacker-directory");
  } else if (kind === "symlink") {
    const preserved = await lstat(quarantined);
    expect({ dev: preserved.dev, ino: preserved.ino }).toEqual({
      dev: attacker.dev,
      ino: attacker.ino,
    });
    expect(await readlink(quarantined)).toBe(join(current.parent, "attacker-target"));
  } else {
    const preserved = await lstat(quarantined);
    expect({ dev: preserved.dev, ino: preserved.ino }).toEqual({
      dev: attacker.dev,
      ino: attacker.ino,
    });
    expect(await readFile(quarantined, "utf8")).toBe("attacker-file");
  }
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Agent repository key cleanup adversarial substitutions", () => {
  for (const kind of replacementKinds) {
    test(`quarantines a ${kind} replacement swapped before atomic capture`, async () => {
      await replaceBeforeCapture(kind);
    });
  }

  test("preserves an attacker that replaces the quarantined entry after capture", async () => {
    const current = await fixture("quarantine-swap");
    await writeFile(current.staged, "attacker-quarantine", { mode: 0o600 });
    const attacker = await lstat(current.staged);
    const error = await cleanupFailure(
      cleanupAgentRepositoryKeyTemporary(current.source, current.identity, {
        checkpoint: async (checkpoint) => {
          if (checkpoint.phase !== "after-entry-captured") return;
          await rename(checkpoint.quarantinePath, current.moved);
          await rename(current.staged, checkpoint.quarantinePath);
        },
      }),
    );
    const quarantined = quarantinePath(error);
    const preserved = await lstat(quarantined);

    expect({ dev: preserved.dev, ino: preserved.ino }).toEqual({
      dev: attacker.dev,
      ino: attacker.ino,
    });
    expect(await readFile(quarantined, "utf8")).toBe("attacker-quarantine");
    expect(await readFile(current.moved, "utf8")).toBe("owned-quarantine-swap");
  });

  test("fails closed when the owned source is moved away before capture", async () => {
    const current = await fixture("missing-source");
    const error = await cleanupFailure(
      cleanupAgentRepositoryKeyTemporary(current.source, current.identity, {
        checkpoint: async (checkpoint) => {
          if (checkpoint.phase === "before-entry-capture") {
            await rename(current.source, current.moved);
          }
        },
      }),
    );

    expect(error.code).toBe("AGENT_REPOSITORY_KEY_MARKER_CLEANUP_FAILED");
    expect(await readFile(current.moved, "utf8")).toBe("owned-missing-source");
    expect(await exists(current.source)).toBe(false);
    expect(await exists(quarantinePath(error))).toBe(false);
  });

  test("does not overwrite a pre-existing entry in a fresh quarantine", async () => {
    const current = await fixture("occupied-quarantine");
    let attackerPath = "";
    const error = await cleanupFailure(
      cleanupAgentRepositoryKeyTemporary(current.source, current.identity, {
        checkpoint: async (checkpoint) => {
          if (checkpoint.phase !== "before-entry-capture") return;
          attackerPath = checkpoint.quarantinePath;
          await writeFile(attackerPath, "attacker-preexisting", { mode: 0o600 });
        },
      }),
    );

    expect(quarantinePath(error)).toBe(attackerPath);
    expect(await readFile(attackerPath, "utf8")).toBe("attacker-preexisting");
    expect(await readFile(current.source, "utf8")).toBe("owned-occupied-quarantine");
  });

  test("retries a colliding quarantine name and removes all owned residue", async () => {
    const current = await fixture("quarantine-collision");
    const first = "a".repeat(32);
    const second = "b".repeat(32);
    const collision = join(current.parent, `${QUARANTINE_PREFIX}${first}`);
    await mkdir(collision, { mode: 0o700 });
    await writeFile(join(collision, "attacker"), "preserve-me", { mode: 0o600 });
    const collisionIdentity = await lstat(collision);
    let tokenIndex = 0;
    const tokens = [first, second];
    await cleanupAgentRepositoryKeyTemporary(current.source, current.identity, {
      token: () => tokens[tokenIndex++] ?? second,
    });

    const preservedCollision = await lstat(collision);
    expect(await readFile(join(collision, "attacker"), "utf8")).toBe("preserve-me");
    expect({ dev: preservedCollision.dev, ino: preservedCollision.ino }).toEqual({
      dev: collisionIdentity.dev,
      ino: collisionIdentity.ino,
    });
    expect(await exists(current.source)).toBe(false);
    expect(await exists(join(current.parent, `${QUARANTINE_PREFIX}${second}`))).toBe(false);
  });
});
