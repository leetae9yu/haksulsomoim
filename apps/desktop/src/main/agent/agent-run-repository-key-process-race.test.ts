import { afterEach, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import { AgentRunRepository } from "./agent-run-repository";

const MARKER = ".agent-repository-key";
const roots: string[] = [];
const readySchema = z.strictObject({ kind: z.literal("ready") });
const receiptSchema = z.strictObject({
  keyByte: z.number().int(),
  kind: z.literal("result"),
  status: z.string(),
});

type ChildReceipt = z.infer<typeof receiptSchema>;
type Participant = Readonly<{ child: ChildProcess; ready: Promise<unknown> }>;

function nextMessage(child: ChildProcess): Promise<unknown> {
  const signal = AbortSignal.timeout(5_000);
  return new Promise((resolve, reject) => {
    const finish = (outcome: () => void): void => {
      signal.removeEventListener("abort", aborted);
      child.off("error", failed);
      child.off("exit", exited);
      child.off("message", received);
      outcome();
    };
    const aborted = (): void => finish(() => reject(signal.reason));
    const failed = (error: Error): void => finish(() => reject(error));
    const exited = (code: number | null): void =>
      finish(() => reject(new Error(`Marker race child exited before IPC receipt: ${code}`)));
    const received = (message: unknown): void => finish(() => resolve(message));
    signal.addEventListener("abort", aborted, { once: true });
    child.once("error", failed);
    child.once("exit", exited);
    child.once("message", received);
  });
}

function childExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve();
  const signal = AbortSignal.timeout(5_000);
  return new Promise((resolve, reject) => {
    const finish = (outcome: () => void): void => {
      signal.removeEventListener("abort", aborted);
      child.off("error", failed);
      child.off("exit", exited);
      outcome();
    };
    const aborted = (): void => finish(() => reject(signal.reason));
    const failed = (error: Error): void => finish(() => reject(error));
    const exited = (): void => finish(resolve);
    signal.addEventListener("abort", aborted, { once: true });
    child.once("error", failed);
    child.once("exit", exited);
  });
}

function participant(directory: string, keyByte: number): Participant {
  const moduleUrl = pathToFileURL(
    join(dirname(fileURLToPath(import.meta.url)), "agent-run-repository.ts"),
  ).href;
  const source = `
    import { AgentRunRepository } from ${JSON.stringify(moduleUrl)};
    const keyByte = ${JSON.stringify(keyByte)};
    const repository = new AgentRunRepository({
      directory: ${JSON.stringify(directory)},
      encryptionKey: new Uint8Array(32).fill(keyByte),
    });
    process.send?.({ kind: "ready" });
    process.once("message", async (message) => {
      if (message !== "go") process.exit(2);
      let status = "ok";
      try {
        await repository.activeRunId("process-race-case");
      } catch (error) {
        status = error instanceof Error && "code" in error && typeof error.code === "string"
          ? error.code
          : "UNKNOWN";
      }
      process.send?.({ kind: "result", keyByte, status });
      process.disconnect?.();
    });
  `;
  const child = spawn(process.execPath, ["-e", source], {
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  return { child, ready: nextMessage(child) };
}

async function runRace(directory: string, keyBytes: readonly number[]): Promise<ChildReceipt[]> {
  const participants = keyBytes.map((keyByte) => participant(directory, keyByte));
  try {
    const ready = await Promise.all(participants.map((current) => current.ready));
    for (const message of ready) readySchema.parse(message);
    const receipts = participants.map((current) => nextMessage(current.child));
    const exits = participants.map((current) => childExit(current.child));
    for (const current of participants) current.child.send("go");
    const parsed = (await Promise.all(receipts)).map((receipt) => receiptSchema.parse(receipt));
    await Promise.all(exits);
    return parsed;
  } finally {
    for (const current of participants) {
      if (current.child.exitCode === null) current.child.kill();
    }
  }
}

async function repositoryRoot(): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), "haksul-agent-key-process-race-"));
  roots.push(parent);
  const directory = join(parent, "repository");
  await mkdir(directory, { mode: 0o700 });
  return directory;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Agent repository marker process races", () => {
  test("coordinates a same-key first-open race without observing partial publication", async () => {
    const directory = await repositoryRoot();
    const receipts = await runRace(directory, [54, 54]);

    expect(receipts.map((receipt) => receipt.status)).toEqual(["ok", "ok"]);
    expect(await readdir(directory)).toEqual([MARKER]);
  });

  test("allows exactly one key across a different-key first-open race", async () => {
    const directory = await repositoryRoot();
    const receipts = await runRace(directory, [55, 56]);
    const winner = receipts.find((receipt) => receipt.status === "ok");
    const loser = receipts.find((receipt) => receipt.status !== "ok");
    if (winner === undefined || loser === undefined) throw new Error("expected one marker winner");

    expect(loser.status).toBe("AGENT_REPOSITORY_KEY_MISMATCH");
    const winnerRepository = new AgentRunRepository({
      directory,
      encryptionKey: new Uint8Array(32).fill(winner.keyByte),
    });
    const loserRepository = new AgentRunRepository({
      directory,
      encryptionKey: new Uint8Array(32).fill(loser.keyByte),
    });
    expect(await winnerRepository.activeRunId("winner-check")).toBeUndefined();
    await expect(loserRepository.activeRunId("loser-check")).rejects.toMatchObject({
      code: "AGENT_REPOSITORY_KEY_MISMATCH",
    });
    expect(await readdir(directory)).toEqual([MARKER]);
  });
});
