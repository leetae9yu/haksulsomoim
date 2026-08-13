import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRunRepository } from "./agent-run-repository";
import { AGENT_REPOSITORY_KEY_MARKER_BYTES } from "./agent-run-repository-key-publication";

const MARKER = ".agent-repository-key";
const roots: string[] = [];
const key = new Uint8Array(32).fill(51);

async function root(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "haksul-agent-key-marker-"));
  roots.push(directory);
  return directory;
}

async function markerSnapshot(marker: string): Promise<string> {
  const metadata = await stat(marker);
  return JSON.stringify({
    content: (await readFile(marker)).toString("hex"),
    mode: metadata.mode,
    nlink: metadata.nlink,
    size: metadata.size,
  });
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Agent repository key marker", () => {
  test("creates one fixed private authenticated marker file", async () => {
    const directory = await root();
    const left = new AgentRunRepository({ directory, encryptionKey: key });
    const right = new AgentRunRepository({ directory, encryptionKey: key });

    expect(
      await Promise.all([left.activeRunId("case-left"), right.activeRunId("case-right")]),
    ).toEqual([undefined, undefined]);
    expect(await readdir(directory)).toEqual([MARKER]);
    const marker = join(directory, MARKER);
    const metadata = await stat(marker);
    expect(metadata.isFile()).toBe(true);
    expect(metadata.mode & 0o777).toBe(0o600);
    expect(metadata.nlink).toBe(1);
    expect(metadata.size).toBe(AGENT_REPOSITORY_KEY_MARKER_BYTES);
    expect(await readFile(marker, "ascii")).toMatch(
      /^haksulsomoim-agent-repository-key:v1:[a-f0-9]{64}\n$/u,
    );
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

  test("rejects a wrong key without changing the marker", async () => {
    const directory = await root();
    const marker = join(directory, MARKER);
    await new AgentRunRepository({ directory, encryptionKey: key }).activeRunId("key-owner");
    const before = await markerSnapshot(marker);
    const wrong = new AgentRunRepository({
      directory,
      encryptionKey: new Uint8Array(32).fill(52),
    });

    await expect(wrong.activeRunId("wrong-key")).rejects.toMatchObject({
      code: "AGENT_REPOSITORY_KEY_MISMATCH",
    });
    expect(await markerSnapshot(marker)).toBe(before);
  });

  for (const corruption of ["crash-partial", "malformed", "tampered"] as const) {
    test(`rejects a ${corruption} marker without changing it`, async () => {
      const directory = await root();
      const marker = join(directory, MARKER);
      const repository = new AgentRunRepository({ directory, encryptionKey: key });
      await repository.activeRunId("marker-case");
      if (corruption === "crash-partial") {
        await writeFile(marker, "haksulsomoim-agent-repository-key:v1:", { mode: 0o600 });
      } else if (corruption === "malformed") {
        await writeFile(marker, Buffer.alloc(AGENT_REPOSITORY_KEY_MARKER_BYTES, 0x78), {
          mode: 0o600,
        });
      } else {
        const data = await readFile(marker);
        data[data.byteLength - 2] = data[data.byteLength - 2] === 0x30 ? 0x31 : 0x30;
        await writeFile(marker, data, { mode: 0o600 });
      }
      const before = await markerSnapshot(marker);
      const expectedCode =
        corruption === "tampered"
          ? "AGENT_REPOSITORY_KEY_MISMATCH"
          : "AGENT_REPOSITORY_KEY_MARKER_INVALID";

      await expect(repository.activeRunId("marker-case")).rejects.toMatchObject({
        code: expectedCode,
      });
      await expect(repository.activeRunId("marker-case-retry")).rejects.toMatchObject({
        code: expectedCode,
      });
      expect(await markerSnapshot(marker)).toBe(before);
    });
  }

  test("fails closed on the unreleased marker-directory layout", async () => {
    const directory = await root();
    const marker = join(directory, MARKER);
    const legacyEntry = `verifier-${"a".repeat(64)}`;
    await mkdir(marker, { mode: 0o700 });
    await writeFile(join(marker, legacyEntry), "", { mode: 0o600 });
    const repository = new AgentRunRepository({ directory, encryptionKey: key });

    await expect(repository.activeRunId("old-layout")).rejects.toMatchObject({
      code: "AGENT_REPOSITORY_KEY_MARKER_INVALID",
    });
    expect(await readdir(marker)).toEqual([legacyEntry]);
  });

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
