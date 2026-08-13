import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentRunSchema } from "./agent-contracts";
import { EncryptedAgentCaseClaimStore } from "./agent-run-case-claim";
import { AgentRunRepository } from "./agent-run-repository";
import { activeRun } from "./agent-run-repository.fixtures";

const roots: string[] = [];
const key = new Uint8Array(32).fill(21);

async function fixture(): Promise<Readonly<{ root: string; runs: AgentRunRepository }>> {
  const root = await mkdtemp(join(tmpdir(), "haksul-agent-case-claim-"));
  roots.push(root);
  return { root, runs: new AgentRunRepository({ directory: root, encryptionKey: key }) };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("encrypted Agent case claim", () => {
  test("stores an opaque encrypted owner and releases only after interrupted persistence", async () => {
    const { root, runs } = await fixture();
    const initial = activeRun("private-owner", "private-case");
    await runs.createOwned(initial);

    expect(await runs.activeRunId("private-case")).toBe("private-owner");
    await expect(runs.releaseOwned("private-case", "private-owner")).rejects.toThrow("active");
    expect(await runs.activeRunId("private-case")).toBe("private-owner");
    const names = await readdir(root);
    expect(names).toHaveLength(2);
    expect(names.every((name) => /^[a-f0-9]{64}\.(?:json|claim)$/u.test(name))).toBe(true);
    for (const name of names) {
      const bytes = await readFile(join(root, name), "utf8");
      expect(bytes).not.toContain("private-case");
      expect(bytes).not.toContain("private-owner");
    }

    const recovered = await runs.recoverActiveCase("private-case");
    expect(recovered?.run.state).toEqual({
      kind: "interrupted",
      interruption: { kind: "application-restarted" },
    });
    expect(await runs.activeRunId("private-case")).toBeUndefined();
    expect(await readdir(root)).toHaveLength(1);
  });

  test("fails closed on a tampered claim and isolates a wrong encryption key", async () => {
    const { root, runs } = await fixture();
    await runs.createOwned(activeRun("tamper-owner", "tamper-case"));
    const claim = (await readdir(root)).find((name) => name.endsWith(".claim"));
    if (claim === undefined) throw new Error("missing encrypted case claim");
    await writeFile(join(root, claim), "not-authenticated", "utf8");

    await expect(runs.activeRunId("tamper-case")).rejects.toThrow();
    const wrongKey = new AgentRunRepository({
      directory: root,
      encryptionKey: new Uint8Array(32).fill(22),
    });
    expect(await wrongKey.activeRunId("tamper-case")).toBeUndefined();
  });

  test("allows exactly one multi-instance owner for the same case", async () => {
    const { root, runs: left } = await fixture();
    const right = new AgentRunRepository({ directory: root, encryptionKey: key });
    const settled = await Promise.allSettled([
      left.create(activeRun("left-owner", "shared-case")),
      right.createOwned(activeRun("right-owner", "shared-case")),
    ]);

    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = settled.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: { code: "AGENT_CASE_ALREADY_CLAIMED" },
    });
    const owner = await left.activeRunId("shared-case");
    expect(owner === "left-owner" || owner === "right-owner").toBe(true);
  });

  test("cleans an orphaned acquired claim during explicit recovery", async () => {
    const { root, runs } = await fixture();
    const claims = new EncryptedAgentCaseClaimStore(root, key);
    await claims.acquire("orphan-case", "orphan-run");

    expect(await runs.activeRunId("orphan-case")).toBe("orphan-run");
    expect(await runs.recoverActiveCase("orphan-case")).toBeUndefined();
    expect(await runs.activeRunId("orphan-case")).toBeUndefined();
    expect(await readdir(root)).toEqual([]);
  });

  test("rolls back a newly acquired claim when run publication fails", async () => {
    const { runs } = await fixture();
    const initial = activeRun("duplicate-run", "rollback-case");
    await runs.create(
      agentRunSchema.parse({
        ...initial,
        state: { kind: "paused", reason: "provider-unavailable" },
      }),
    );

    await expect(runs.createOwned(initial)).rejects.toThrow("already exists");
    expect(await runs.activeRunId("rollback-case")).toBeUndefined();
    await runs.createOwned(activeRun("replacement-run", "rollback-case"));
    expect(await runs.activeRunId("rollback-case")).toBe("replacement-run");
  });
});
