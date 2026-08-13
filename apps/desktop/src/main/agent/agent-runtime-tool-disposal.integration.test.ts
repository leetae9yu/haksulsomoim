import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodexAgentDecisionProvider } from "../../integrations/agent-provider/agent-provider";
import type { KoreanLawMcpAdapter } from "../../integrations/korean-law-mcp/korean-law-mcp";
import { createDesktopRuntime } from "../runtime";
import { agentGoalSchema } from "./agent-contracts";
import { type AgentExecutionTimer, AgentToolQuarantinedError } from "./agent-tool-execution";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

class ManualTimer implements AgentExecutionTimer {
  readonly entries: Array<{ active: boolean; callback: () => void }> = [];
  schedule(_delayMs: number, callback: () => void): () => void {
    const entry = { active: true, callback };
    this.entries.push(entry);
    return () => {
      entry.active = false;
    };
  }
  firePending(): void {
    for (const entry of [...this.entries]) {
      if (!entry.active) continue;
      entry.active = false;
      entry.callback();
    }
  }
}

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Agent runtime tool disposal", () => {
  test("bounds disposal and keeps a noncooperative tool claim quarantined", async () => {
    const root = await mkdtemp(join(tmpdir(), "haksul-agent-tool-dispose-"));
    roots.push(root);
    const timer = new ManualTimer();
    const entered = deferred();
    const aborted = deferred();
    const release = deferred();
    const lateSettled = deferred();
    const key = new Uint8Array(32).fill(43);
    const law = {
      tools: () => ["search_law"],
      discover: async () => ["search_law"],
      async execute(_tool: string, _arguments: unknown, context?: { signal: AbortSignal }) {
        if (context === undefined) throw new Error("missing tool cancellation context");
        context.signal.addEventListener("abort", aborted.resolve, { once: true });
        entered.resolve();
        await release.promise;
        lateSettled.resolve();
        return { ok: true as const, value: { content: {}, citations: [] } };
      },
      close: async () => undefined,
    } as KoreanLawMcpAdapter;
    const provider = {
      state: {
        status: "authenticated",
        account: { type: "chatgpt", email: null, planType: "test" },
      },
      nextDecision: async () => ({
        kind: "tool",
        decisionId: "model-decision",
        toolCall: { toolName: "search-official-law", toolCallId: "model-tool", query: "민법" },
      }),
      interrupt: async () => undefined,
      startChatGptLogin: async () => {
        throw new Error("unused");
      },
      dispose: async () => undefined,
    } as unknown as CodexAgentDecisionProvider;
    const runtime = await createDesktopRuntime(root, {
      loadKey: async () => key,
      createLaw: () => law,
      createProvider: async () => provider,
      agentExecution: { timer, toolSettlementGraceMs: 10 },
    });
    const created = await runtime.handlers.createCase({
      amountKrw: 100_000,
      jurisdiction: "domestic",
      paymentMethod: "bank-transfer",
    });
    if (created.status !== "accepted") throw new Error("case fixture failed");
    const opened = await runtime.agent.openCase(created.caseId);
    const begun = await runtime.agent.begin({
      caseId: created.caseId,
      goal: agentGoalSchema.parse({
        kind: "civil-recovery",
        caseId: created.caseId,
        objective: "prepare-civil-demand",
      }),
      approvedContextDigest: opened.contextDigest,
    });
    if (begun.status !== "started") throw new Error("Agent fixture did not start");
    await entered.promise;

    const disposal = runtime.dispose().then(
      () => undefined,
      (error) => error,
    );
    await aborted.promise;
    timer.firePending();
    const failure = await disposal;
    expect(failure).toBeInstanceOf(AggregateError);
    const agentFailure = (failure as AggregateError).errors.find(
      (error) => error instanceof AggregateError,
    );
    expect(agentFailure).toBeInstanceOf(AggregateError);
    expect((agentFailure as AggregateError).errors[0]).toBeInstanceOf(AgentToolQuarantinedError);

    const replacement = await createDesktopRuntime(root, {
      loadKey: async () => key,
      createLaw: () => law,
      createProvider: async () => provider,
    });
    await expect(replacement.agent.openCase(created.caseId)).rejects.toThrow("quarantined");
    await replacement.dispose();

    release.resolve();
    await lateSettled.promise;
    const completed = await begun.completion;
    expect(completed.steps.some((step) => step.kind === "tool-finished")).toBe(false);
  });
});
