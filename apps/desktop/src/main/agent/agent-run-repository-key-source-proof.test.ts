import { afterEach, describe, expect, test } from "bun:test";
import {
  link,
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
import { dirname, join } from "node:path";
import {
  AgentRepositoryKeyCleanupError,
  type AgentRepositoryTemporaryIdentity,
  cleanupAgentRepositoryKeyTemporary,
} from "./agent-run-repository-key-cleanup";

const roots: string[] = [];
const kinds: ReadonlyArray<"directory" | "file" | "hardlink" | "symlink"> = [
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

async function owned(path: string, payload: string): Promise<AgentRepositoryTemporaryIdentity> {
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
  const parent = await mkdtemp(join(tmpdir(), `haksul-source-proof-${label}-`));
  roots.push(parent);
  const source = join(parent, "owned.tmp");
  return {
    identity: await owned(source, `owned-${label}`),
    moved: join(parent, "owned-moved"),
    parent,
    source,
    staged: join(parent, "attacker-staged"),
  };
}

async function createReplacement(kind: (typeof kinds)[number], current: Fixture): Promise<void> {
  if (kind === "directory") {
    await mkdir(current.staged, { mode: 0o700 });
    await writeFile(join(current.staged, "payload"), `attacker-${kind}`, { mode: 0o600 });
  } else if (kind === "symlink") {
    const target = join(current.parent, "attacker-target");
    await writeFile(target, `attacker-${kind}`, { mode: 0o600 });
    await symlink(target, current.staged);
  } else if (kind === "hardlink") {
    const target = join(current.parent, "attacker-target");
    await writeFile(target, `attacker-${kind}`, { mode: 0o600 });
    await link(target, current.staged);
  } else {
    await writeFile(current.staged, `attacker-${kind}`, { mode: 0o600 });
  }
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
  if (error.quarantinePath === undefined) throw new Error("missing quarantine path");
  return error.quarantinePath;
}

async function fileSwapRound(round: number): Promise<void> {
  const current = await fixture(`round-${round}`);
  await writeFile(current.staged, `attacker-${round}`, { mode: 0o600 });
  const attacker = await lstat(current.staged);
  const gate = barrier();
  const cleanup = cleanupAgentRepositoryKeyTemporary(current.source, current.identity, {
    checkpoint: async (checkpoint) => {
      if (checkpoint.phase === "before-source-release") await gate.wait();
    },
  });

  await gate.reached;
  await rename(current.source, current.moved);
  await rename(current.staged, current.source);
  gate.release();
  const error = await cleanupFailure(cleanup);
  const proof = await lstat(join(dirname(quarantinePath(error)), "source-proof"));
  const captured = await lstat(quarantinePath(error));
  const moved = await lstat(current.moved);

  expect({ dev: proof.dev, ino: proof.ino }).toEqual({ dev: attacker.dev, ino: attacker.ino });
  expect({ dev: captured.dev, ino: captured.ino }).toEqual(current.identity);
  expect({ dev: moved.dev, ino: moved.ino }).toEqual(current.identity);
  expect(await readFile(current.source, "utf8")).toBe(`attacker-${round}`);
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Agent repository cleanup source identity proof", () => {
  test("preserves source swaps across 64 deterministic barrier rounds", async () => {
    for (let round = 1; round <= 64; round += 1) await fileSwapRound(round);
  }, 30_000);

  for (const kind of kinds) {
    test(`preserves a ${kind} source replacement before release`, async () => {
      const current = await fixture(kind);
      await createReplacement(kind, current);
      const attacker = await lstat(current.staged);
      const error = await cleanupFailure(
        cleanupAgentRepositoryKeyTemporary(current.source, current.identity, {
          checkpoint: async (checkpoint) => {
            if (checkpoint.phase !== "before-source-release") return;
            await rename(current.source, current.moved);
            await rename(current.staged, current.source);
          },
        }),
      );
      const captured = await lstat(quarantinePath(error));
      const moved = await lstat(current.moved);

      expect({ dev: captured.dev, ino: captured.ino }).toEqual(current.identity);
      expect({ dev: moved.dev, ino: moved.ino }).toEqual(current.identity);
      if (kind === "directory") {
        expect(await readFile(join(current.source, "payload"), "utf8")).toBe("attacker-directory");
      } else {
        const proof = await lstat(join(dirname(quarantinePath(error)), "source-proof"));
        expect({ dev: proof.dev, ino: proof.ino }).toEqual({
          dev: attacker.dev,
          ino: attacker.ino,
        });
        if (kind === "symlink") expect(await readlink(current.source)).not.toBe("");
        else expect(await readFile(current.source, "utf8")).toBe(`attacker-${kind}`);
      }
    });
  }

  test("preserves a colliding source-proof destination", async () => {
    const current = await fixture("proof-collision");
    let proofPath = "";
    const error = await cleanupFailure(
      cleanupAgentRepositoryKeyTemporary(current.source, current.identity, {
        checkpoint: async (checkpoint) => {
          if (checkpoint.phase !== "before-source-release") return;
          proofPath = join(dirname(checkpoint.quarantinePath), "source-proof");
          await writeFile(proofPath, "attacker-proof", { mode: 0o600 });
        },
      }),
    );

    expect(error.cause).toMatchObject({ code: "EEXIST" });
    expect(await readFile(proofPath, "utf8")).toBe("attacker-proof");
    expect(await readFile(current.source, "utf8")).toBe("owned-proof-collision");
  });
});
