import { afterEach, describe, expect, test } from "bun:test";
import { lstat, mkdtemp, open, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentRepositoryKeyCleanupCheckpoint,
  type AgentRepositoryTemporaryIdentity,
  cleanupAgentRepositoryKeyTemporary,
} from "./agent-run-repository-key-cleanup";

const roots: string[] = [];

type Barrier = Readonly<{
  reached: Promise<void>;
  release: () => void;
  wait: () => Promise<void>;
}>;

function barrier(): Barrier {
  let markReached = (): void => undefined;
  let release = (): void => undefined;
  const reached = new Promise<void>((resolve) => {
    markReached = resolve;
  });
  const continuation = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    reached,
    release,
    wait: async () => {
      markReached();
      await continuation;
    },
  };
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return false;
    throw error;
  }
}

async function ownedTemporary(
  path: string,
  payload: string,
): Promise<AgentRepositoryTemporaryIdentity> {
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(payload, "utf8");
    const metadata = await file.stat();
    return { dev: metadata.dev, ino: metadata.ino };
  } finally {
    await file.close();
  }
}

async function swapAtCapturedEntry(round: number): Promise<void> {
  const parent = await mkdtemp(join(tmpdir(), `haksul-cleanup-toctou-${round}-`));
  roots.push(parent);
  const source = join(parent, "owned.tmp");
  const movedOwned = join(parent, "owned-moved.tmp");
  const stagedAttacker = join(parent, "attacker-staged.tmp");
  const identity = await ownedTemporary(source, `owned-${round}`);
  await writeFile(stagedAttacker, `attacker-${round}`, { mode: 0o600 });
  const gate = barrier();
  const cleanup = cleanupAgentRepositoryKeyTemporary(source, identity, {
    checkpoint: async (checkpoint: AgentRepositoryKeyCleanupCheckpoint) => {
      if (checkpoint.phase === "after-entry-captured") await gate.wait();
    },
  });

  await gate.reached;
  try {
    try {
      await rename(source, movedOwned);
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
    }
    await rename(stagedAttacker, source);
  } finally {
    gate.release();
  }
  await cleanup;

  expect(await readFile(source, "utf8")).toBe(`attacker-${round}`);
  expect(await exists(movedOwned)).toBe(false);
  expect(await readdir(parent)).toEqual(["owned.tmp"]);
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Agent repository key temporary cleanup", () => {
  test("does not delete a replacement swapped after entry identity observation", async () => {
    await swapAtCapturedEntry(0);
  }, 10_000);

  test("binds cleanup to the owned inode across 64 deterministic barrier rounds", async () => {
    for (let round = 1; round <= 64; round += 1) await swapAtCapturedEntry(round);
  }, 30_000);
});
