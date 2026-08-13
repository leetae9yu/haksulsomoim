import { afterEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
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

async function markerSnapshot(marker: string): Promise<string> {
  const entries = (await readdir(marker)).sort();
  const facts = await Promise.all(
    entries.map(async (entry) => {
      const metadata = await stat(join(marker, entry));
      return { entry, mode: metadata.mode, nlink: metadata.nlink, size: metadata.size };
    }),
  );
  return JSON.stringify(facts);
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Agent repository key marker", () => {
  test("creates one fixed private marker directory shared by same-key instances", async () => {
    const directory = await root();
    const left = new AgentRunRepository({ directory, encryptionKey: key });
    const right = new AgentRunRepository({ directory, encryptionKey: key });

    expect(
      await Promise.all([left.activeRunId("case-left"), right.activeRunId("case-right")]),
    ).toEqual([undefined, undefined]);
    expect(await readdir(directory)).toEqual([MARKER]);
    expect((await stat(join(directory, MARKER))).mode & 0o777).toBe(0o700);
    const [entry] = await readdir(join(directory, MARKER));
    if (entry === undefined) throw new Error("expected verifier entry");
    expect(entry).toMatch(/^verifier-[a-f0-9]{64}$/u);
    expect((await stat(join(directory, MARKER, entry))).mode & 0o777).toBe(0o600);
    expect((await stat(join(directory, MARKER, entry))).size).toBe(0);
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
    const parent = await root();
    const directory = join(parent, "repository");
    await mkdir(directory, { mode: 0o700 });
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
    expect(await readdir(parent)).toEqual(["repository"]);
  });

  for (const corruption of ["truncated", "malformed", "tampered"] as const) {
    test(`rejects a ${corruption} marker without changing it`, async () => {
      const directory = await root();
      const marker = join(directory, MARKER);
      const repository = new AgentRunRepository({ directory, encryptionKey: key });
      await repository.activeRunId("marker-case");
      const [entry] = await readdir(marker);
      if (entry === undefined) throw new Error("expected verifier entry");
      if (corruption === "truncated") {
        await writeFile(join(marker, entry), "x", "utf8");
      } else if (corruption === "malformed") {
        await writeFile(join(marker, "legacy-marker.json"), "legacy", { mode: 0o600 });
      } else {
        await rename(join(marker, entry), join(marker, `verifier-${"0".repeat(64)}`));
      }
      const before = await markerSnapshot(marker);

      await expect(repository.activeRunId("marker-case")).rejects.toMatchObject({
        code:
          corruption === "tampered"
            ? "AGENT_REPOSITORY_KEY_MISMATCH"
            : "AGENT_REPOSITORY_KEY_MARKER_INVALID",
      });
      expect(await markerSnapshot(marker)).toBe(before);
    });
  }

  test("does not initialize a markerless legacy repository", async () => {
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
