import { afterEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";
import { AgentRunRepository } from "./agent-run-repository";

const MARKER = ".agent-repository-key";
const execFileAsync = promisify(execFile);
const roots: string[] = [];
const key = new Uint8Array(32).fill(51);
const childReceiptSchema = z.strictObject({
  status: z.string(),
  keyByte: z.number().int(),
});

type ChildReceipt = z.infer<typeof childReceiptSchema>;

async function root(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "haksul-agent-key-marker-"));
  roots.push(directory);
  return directory;
}

async function childOpen(directory: string, keyByte: number): Promise<ChildReceipt> {
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
    let status = "ok";
    try {
      await repository.activeRunId("process-race-case");
    } catch (error) {
      status = error instanceof Error && "code" in error && typeof error.code === "string"
        ? error.code
        : "UNKNOWN";
    }
    console.log(JSON.stringify({ status, keyByte }));
  `;
  const { stdout } = await execFileAsync(process.execPath, ["-e", source], {
    encoding: "utf8",
  });
  return childReceiptSchema.parse(JSON.parse(stdout));
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Agent repository key marker", () => {
  test("creates one fixed mode-0600 marker shared by same-key instances", async () => {
    const directory = await root();
    const left = new AgentRunRepository({ directory, encryptionKey: key });
    const right = new AgentRunRepository({ directory, encryptionKey: key });

    expect(
      await Promise.all([left.activeRunId("case-left"), right.activeRunId("case-right")]),
    ).toEqual([undefined, undefined]);
    expect(await readdir(directory)).toEqual([MARKER]);
    expect((await stat(join(directory, MARKER))).mode & 0o777).toBe(0o600);
    const marker = await readFile(join(directory, MARKER), "utf8");
    expect(marker).not.toContain("case-left");
    expect(marker).not.toContain("case-right");
  });

  test("allows exactly one key to initialize a same-process first-open race", async () => {
    const directory = await root();
    const left = new AgentRunRepository({
      directory,
      encryptionKey: new Uint8Array(32).fill(52),
    });
    const right = new AgentRunRepository({
      directory,
      encryptionKey: new Uint8Array(32).fill(53),
    });
    const settled = await Promise.allSettled([
      left.activeRunId("race-case"),
      right.activeRunId("race-case"),
    ]);

    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(settled.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(settled.find((result) => result.status === "rejected")).toMatchObject({
      reason: { code: "AGENT_REPOSITORY_KEY_MISMATCH" },
    });
    expect(await readdir(directory)).toEqual([MARKER]);
  });

  test("allows exactly one key across a child-process first-open race", async () => {
    const directory = await root();
    const receipts = await Promise.all([childOpen(directory, 54), childOpen(directory, 55)]);
    const winner = receipts.find((receipt) => receipt.status === "ok");
    const loser = receipts.find((receipt) => receipt.status !== "ok");
    if (winner === undefined || loser === undefined) throw new Error("expected one marker winner");

    expect(loser.status).toBe("AGENT_REPOSITORY_KEY_MISMATCH");
    expect((await childOpen(directory, winner.keyByte)).status).toBe("ok");
    expect((await childOpen(directory, loser.keyByte)).status).toBe(
      "AGENT_REPOSITORY_KEY_MISMATCH",
    );
    expect(await readdir(directory)).toEqual([MARKER]);
  });

  for (const corruption of [
    { name: "truncated", payload: "{", code: "AGENT_REPOSITORY_KEY_MARKER_INVALID" },
    {
      name: "malformed",
      payload: JSON.stringify({ version: 1 }),
      code: "AGENT_REPOSITORY_KEY_MARKER_INVALID",
    },
    {
      name: "tampered",
      payload: JSON.stringify({ version: 1, verifier: "0".repeat(64) }),
      code: "AGENT_REPOSITORY_KEY_MISMATCH",
    },
  ]) {
    test(`rejects a ${corruption.name} marker without overwriting it`, async () => {
      const directory = await root();
      const repository = new AgentRunRepository({ directory, encryptionKey: key });
      await repository.activeRunId("marker-case");
      await writeFile(join(directory, MARKER), corruption.payload, "utf8");

      await expect(repository.activeRunId("marker-case")).rejects.toMatchObject({
        code: corruption.code,
      });
      expect(await readFile(join(directory, MARKER), "utf8")).toBe(corruption.payload);
    });
  }

  test("does not initialize a missing marker over a nonempty repository", async () => {
    const directory = await root();
    await writeFile(join(directory, "existing-record.json"), "opaque", { mode: 0o600 });
    await chmod(directory, 0o700);
    const repository = new AgentRunRepository({ directory, encryptionKey: key });

    await expect(repository.activeRunId("marker-case")).rejects.toMatchObject({
      code: "AGENT_REPOSITORY_KEY_MARKER_INVALID",
    });
    expect(await readdir(directory)).toEqual(["existing-record.json"]);
  });
});
