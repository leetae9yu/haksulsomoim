import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createCipheriv, createHmac, randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { agentToolLeaseSchema } from "./agent-case-tool-lease";
import { EncryptedAgentCaseClaimStore } from "./agent-run-case-claim";

const roots: string[] = [];
const files: string[] = [];
const key = new Uint8Array(32).fill(43);
const lease = agentToolLeaseSchema.parse({
  caseId: "case-1",
  runId: "run-1",
  stepId: "step-1",
  toolExecutionToken: "tool-1",
  startedAt: 1,
  deadline: 2,
  state: "executing",
});
const identity = lease;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "agent-durable-lease-"));
  roots.push(root);
  return { root, store: new EncryptedAgentCaseClaimStore(root, key) };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  await Promise.all(files.splice(0).map((file) => unlink(file).catch(() => undefined)));
});

describe("durable external-tool leases", () => {
  test("persists encrypted quarantine across fresh OS processes", async () => {
    const { root } = await fixture();
    const modulePath = resolve("src/main/agent/agent-run-case-claim.ts");
    const driver = join(tmpdir(), `agent-durable-lease-${randomBytes(8).toString("hex")}.ts`);
    files.push(driver);
    await writeFile(
      driver,
      `
      const { EncryptedAgentCaseClaimStore } = await import(process.argv[2]);
      const store = new EncryptedAgentCaseClaimStore(process.argv[3], new Uint8Array(32).fill(43));
      const lease = { caseId: "case-1", runId: "run-1", stepId: "step-1", toolExecutionToken: "tool-1" };
      if (process.argv[4] === "owner") {
        await store.acquire(lease.caseId, lease.runId);
        await store.beginToolLease({ ...lease, startedAt: 1, deadline: 2, state: "executing" });
        await store.quarantine(lease.caseId, lease.runId, lease);
      } else {
        const blocked = await store.isQuarantined(lease.caseId);
        let denied = false;
        try { await store.release(lease.caseId, lease.runId); } catch { denied = true; }
        console.log(JSON.stringify({ blocked, denied, owner: await store.owner(lease.caseId) }));
        if (!blocked || !denied) process.exitCode = 1;
      }
    `,
      { mode: 0o600 },
    );
    for (const mode of ["owner", "check"]) {
      const child = spawn(process.execPath, [driver, modulePath, root, mode]);
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
        stderr += chunk;
      });
      const [exit] = (await once(child, "close")) as [number];
      expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
      if (mode === "check")
        expect(JSON.parse(stdout)).toEqual({ blocked: true, denied: true, owner: "run-1" });
    }
    const records = await Promise.all(
      (await readdir(root)).map((name) => readFile(join(root, name), "utf8")),
    );
    expect(records.join(" ")).not.toMatch(/case-1|run-1|step-1|tool-1/);
  });

  test("uses lease identity CAS and never releases by elapsed deadline", async () => {
    const { root, store } = await fixture();
    await store.acquire(identity.caseId, identity.runId);
    await store.beginToolLease(lease);
    await store.settleToolLease(identity);
    const newer = agentToolLeaseSchema.parse({
      ...lease,
      stepId: "step-2",
      toolExecutionToken: "tool-2",
      startedAt: 3,
      deadline: 4,
    });
    await store.beginToolLease(newer);
    await expect(store.settleToolLease(identity)).rejects.toThrow("identity mismatch");
    expect(await new EncryptedAgentCaseClaimStore(root, key).isQuarantined(identity.caseId)).toBe(
      true,
    );
    await expect(store.release(identity.caseId, identity.runId)).rejects.toMatchObject({
      code: "AGENT_CASE_ALREADY_CLAIMED",
    });
    await store.settleToolLease(newer);
    await store.release(identity.caseId, identity.runId);
  });

  test("fails closed when an authenticated claim omits its lease field", async () => {
    const { root, store } = await fixture();
    await store.acquire(identity.caseId, identity.runId);
    const locator = createHmac("sha256", key)
      .update("haksulsomoim:agent-case-claim:v1\0")
      .update(identity.caseId)
      .digest("hex");
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(Buffer.from(locator));
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify({ caseId: identity.caseId, runId: identity.runId })),
      cipher.final(),
    ]);
    await writeFile(
      join(root, `${locator}.claim`),
      JSON.stringify({
        version: 1,
        nonce: nonce.toString("base64"),
        ciphertext: ciphertext.toString("base64"),
        authTag: cipher.getAuthTag().toString("base64"),
      }),
      { mode: 0o600 },
    );
    await expect(
      new EncryptedAgentCaseClaimStore(root, key).isQuarantined(identity.caseId),
    ).rejects.toThrow();
    await expect(store.release(identity.caseId, identity.runId)).rejects.toThrow();
  });
});
