import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodexAgentDecisionProvider } from "../../integrations/agent-provider/agent-provider";
import type { KoreanLawMcpAdapter } from "../../integrations/korean-law-mcp/korean-law-mcp";
import { createDesktopRuntime } from "../runtime";
import { agentGoalSchema } from "./agent-contracts";
import { AgentRuntimeDisposedError } from "./agent-runtime";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Agent runtime initialization ownership", () => {
  test("waits for deferred initialization before disposal and rejects late starts", async () => {
    const root = await mkdtemp(join(tmpdir(), "haksul-agent-init-dispose-"));
    roots.push(root);
    let signalInitialization!: () => void;
    const initializationRequested = new Promise<void>((resolve) => {
      signalInitialization = resolve;
    });
    let releaseProvider!: (provider: CodexAgentDecisionProvider) => void;
    const providerInitialization = new Promise<CodexAgentDecisionProvider>((resolve) => {
      releaseProvider = resolve;
    });
    const events: string[] = [];
    let decisionCalls = 0;
    let providerCloseCalls = 0;
    let lawCloseCalls = 0;
    let providerClosed = false;
    const provider = {
      state: {
        status: "authenticated",
        account: { type: "chatgpt", email: null, planType: "test" },
      },
      async nextDecision() {
        decisionCalls += 1;
        if (providerClosed) throw new Error("Agent turn began after provider disposal");
        return { kind: "finish" };
      },
      interrupt: async () => undefined,
      startChatGptLogin: async () => {
        throw new Error("unused");
      },
      suggest: async () => {
        throw new Error("unused");
      },
      async dispose() {
        providerCloseCalls += 1;
        providerClosed = true;
        events.push("provider-closed");
      },
    } as unknown as CodexAgentDecisionProvider;
    const law = {
      tools: () => ["search_law"],
      discover: async () => ["search_law"],
      execute: async () => ({ ok: true, value: { content: {}, citations: [] } }),
      async close() {
        lawCloseCalls += 1;
        events.push("law-closed");
      },
    } as KoreanLawMcpAdapter;
    const runtime = await createDesktopRuntime(root, {
      loadKey: async () => new Uint8Array(32).fill(41),
      createLaw: () => law,
      createProvider: async () => {
        signalInitialization();
        return providerInitialization;
      },
    });
    const created = await runtime.handlers.createCase({
      amountKrw: 100_000,
      jurisdiction: "domestic",
      paymentMethod: "bank-transfer",
    });
    if (created.status !== "accepted") throw new Error("case fixture failed");
    const opened = await runtime.agent.openCase(created.caseId);
    const input = {
      caseId: created.caseId,
      goal: agentGoalSchema.parse({
        kind: "civil-recovery",
        caseId: created.caseId,
        objective: "prepare-civil-demand",
      }),
      approvedContextDigest: opened.contextDigest,
    };
    const starts = [runtime.agent.start(input), runtime.agent.start(input)];
    const startsSettled = Promise.allSettled(starts).then((results) => {
      events.push("starts-settled");
      return results;
    });
    await initializationRequested;
    const firstDisposal = runtime.dispose().then(() => events.push("disposed"));
    const repeatedDisposal = runtime.dispose();
    releaseProvider(provider);

    const [startResults] = await Promise.all([startsSettled, firstDisposal, repeatedDisposal]);
    expect(startResults.every((result) => result.status === "rejected")).toBe(true);
    expect(decisionCalls).toBe(0);
    expect(providerCloseCalls).toBe(1);
    expect(lawCloseCalls).toBe(1);
    expect(events.indexOf("starts-settled")).toBeLessThan(events.indexOf("provider-closed"));
    expect(events.indexOf("starts-settled")).toBeLessThan(events.indexOf("law-closed"));
    expect(events.at(-1)).toBe("disposed");
    let lateAdmissionError: unknown;
    try {
      await runtime.agent.start(input);
    } catch (error) {
      lateAdmissionError = error;
    }
    expect(lateAdmissionError).toBeInstanceOf(AgentRuntimeDisposedError);
    const records = await readdir(join(root, "case-vault", "agent-runs"));
    expect(records.filter((name) => name !== ".agent-repository-key")).toEqual([]);
  });

  test("settles rejected initialization before one idempotent teardown", async () => {
    const root = await mkdtemp(join(tmpdir(), "haksul-agent-init-reject-"));
    roots.push(root);
    let lawCloseCalls = 0;
    const runtime = await createDesktopRuntime(root, {
      loadKey: async () => new Uint8Array(32).fill(42),
      createLaw: () =>
        ({
          tools: () => ["search_law"],
          discover: async () => ["search_law"],
          execute: async () => ({ ok: true, value: { content: {}, citations: [] } }),
          close: async () => {
            lawCloseCalls += 1;
          },
        }) as KoreanLawMcpAdapter,
      createProvider: async () => Promise.reject(new Error("provider init rejected")),
    });
    const created = await runtime.handlers.createCase({
      amountKrw: 100_000,
      jurisdiction: "domestic",
      paymentMethod: "bank-transfer",
    });
    if (created.status !== "accepted") throw new Error("case fixture failed");
    const opened = await runtime.agent.openCase(created.caseId);
    const result = await runtime.agent.start({
      caseId: created.caseId,
      goal: agentGoalSchema.parse({
        kind: "civil-recovery",
        caseId: created.caseId,
        objective: "prepare-civil-demand",
      }),
      approvedContextDigest: opened.contextDigest,
    });
    expect(result).toEqual({ status: "unavailable", reason: "provider-initialization" });
    await Promise.all([runtime.dispose(), runtime.dispose()]);
    expect(lawCloseCalls).toBe(1);
  });
});
