import { afterEach, describe, expect, test } from "bun:test";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentRepositoryKeyCleanupError,
  type AgentRepositoryTemporaryIdentity,
  cleanupAgentRepositoryKeyTemporary,
} from "./agent-run-repository-key-cleanup";

const roots: string[] = [];
const entryKinds: ReadonlyArray<"directory" | "file" | "hardlink" | "symlink"> = [
  "file",
  "hardlink",
  "symlink",
  "directory",
];

type Barrier = Readonly<{
  reached: Promise<void>;
  release: () => void;
  wait: () => Promise<void>;
}>;

type Fixture = Readonly<{
  identity: AgentRepositoryTemporaryIdentity;
  moved: string;
  parent: string;
  source: string;
  staged: string;
}>;

type EntryReceipt = Readonly<{
  dev: number;
  ino: number;
  kind: "directory" | "file" | "symlink";
  value: string;
}>;

function barrier(): Barrier {
  let reached = (): void => undefined;
  let release = (): void => undefined;
  const reachedPromise = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const continuation = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    reached: reachedPromise,
    release,
    wait: async () => {
      reached();
      await continuation;
    },
  };
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

async function fixture(label: string): Promise<Fixture> {
  const parent = await mkdtemp(join(tmpdir(), `haksul-cleanup-noreplace-${label}-`));
  roots.push(parent);
  const source = join(parent, "owned.tmp");
  return {
    identity: await ownedTemporary(source, `owned-${label}`),
    moved: join(parent, "owned-moved"),
    parent,
    source,
    staged: join(parent, "attacker-staged"),
  };
}

async function createEntry(
  kind: (typeof entryKinds)[number],
  path: string,
  parent: string,
  label: string,
): Promise<EntryReceipt> {
  if (kind === "directory") {
    await mkdir(path, { mode: 0o700 });
    await writeFile(join(path, "payload"), `attacker-${label}`, { mode: 0o600 });
  } else if (kind === "symlink") {
    const target = join(parent, `target-${label}`);
    await writeFile(target, `attacker-${label}`, { mode: 0o600 });
    await symlink(target, path);
  } else if (kind === "hardlink") {
    const target = join(parent, `target-${label}`);
    await writeFile(target, `attacker-${label}`, { mode: 0o600 });
    await link(target, path);
  } else {
    await writeFile(path, `attacker-${label}`, { mode: 0o600 });
  }
  return entryReceipt(path);
}

async function entryReceipt(path: string): Promise<EntryReceipt> {
  const metadata = await lstat(path);
  if (metadata.isDirectory()) {
    return {
      dev: metadata.dev,
      ino: metadata.ino,
      kind: "directory",
      value: await readFile(join(path, "payload"), "utf8"),
    };
  }
  if (metadata.isSymbolicLink()) {
    return { dev: metadata.dev, ino: metadata.ino, kind: "symlink", value: await readlink(path) };
  }
  return {
    dev: metadata.dev,
    ino: metadata.ino,
    kind: "file",
    value: await readFile(path, "utf8"),
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

function reportedPath(error: AgentRepositoryKeyCleanupError): string {
  if (error.quarantinePath === undefined) throw new Error("expected quarantine path");
  return error.quarantinePath;
}

async function destinationInsertionRound(round: number): Promise<void> {
  const current = await fixture(`round-${round}`);
  const gate = barrier();
  let quarantinePath = "";
  const cleanup = cleanupAgentRepositoryKeyTemporary(current.source, current.identity, {
    checkpoint: async (checkpoint) => {
      if (checkpoint.phase !== "before-no-replace-capture") return;
      quarantinePath = checkpoint.quarantinePath;
      await gate.wait();
    },
  });

  await gate.reached;
  const attacker = await createEntry("file", quarantinePath, current.parent, `round-${round}`);
  gate.release();
  const error = await cleanupFailure(cleanup);

  expect(error.code).toBe("AGENT_REPOSITORY_KEY_MARKER_CLEANUP_FAILED");
  expect(error.cause).toMatchObject({ code: "EEXIST" });
  expect(reportedPath(error)).toBe(quarantinePath);
  expect(await entryReceipt(quarantinePath)).toEqual(attacker);
  expect(await readFile(current.source, "utf8")).toBe(`owned-round-${round}`);
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Agent repository cleanup no-replace capture", () => {
  test("preserves a destination inserted after the empty check", async () => {
    await destinationInsertionRound(0);
  });

  test("preserves destination insertions across 64 deterministic barrier rounds", async () => {
    for (let round = 1; round <= 64; round += 1) await destinationInsertionRound(round);
  }, 30_000);

  test("removes both owned links after an uncontended capture", async () => {
    const current = await fixture("normal");

    await cleanupAgentRepositoryKeyTemporary(current.source, current.identity);

    expect(await readdir(current.parent)).toEqual([]);
  });

  for (const kind of entryKinds) {
    test(`preserves a colliding quarantine ${kind}`, async () => {
      const current = await fixture(`destination-${kind}`);
      let attacker: EntryReceipt | undefined;
      const error = await cleanupFailure(
        cleanupAgentRepositoryKeyTemporary(current.source, current.identity, {
          checkpoint: async (checkpoint) => {
            if (checkpoint.phase !== "before-no-replace-capture") return;
            attacker = await createEntry(
              kind,
              checkpoint.quarantinePath,
              current.parent,
              `destination-${kind}`,
            );
          },
        }),
      );
      if (attacker === undefined) throw new Error("attacker insertion checkpoint not reached");

      expect(await entryReceipt(reportedPath(error))).toEqual(attacker);
      expect(await readFile(current.source, "utf8")).toBe(`owned-destination-${kind}`);
    });

    test(`preserves an owned source and ${kind} replacement before capture`, async () => {
      const current = await fixture(`source-${kind}`);
      const attacker = await createEntry(kind, current.staged, current.parent, `source-${kind}`);
      const error = await cleanupFailure(
        cleanupAgentRepositoryKeyTemporary(current.source, current.identity, {
          checkpoint: async (checkpoint) => {
            if (checkpoint.phase !== "before-entry-capture") return;
            await rename(current.source, current.moved);
            await rename(current.staged, current.source);
          },
        }),
      );

      const movedOwned = await lstat(current.moved);
      expect(await entryReceipt(current.source)).toEqual(attacker);
      expect({ dev: movedOwned.dev, ino: movedOwned.ino }).toEqual(current.identity);
      expect(await readFile(current.moved, "utf8")).toBe(`owned-source-${kind}`);
      if (kind !== "directory") expect(await entryReceipt(reportedPath(error))).toEqual(attacker);
    });
  }
});
