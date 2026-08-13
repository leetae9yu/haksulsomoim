import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ApprovedAgentDecisionContext,
  CodexAgentDecisionProvider,
} from "../../integrations/agent-provider/agent-provider";
import type { KoreanLawMcpAdapter } from "../../integrations/korean-law-mcp/korean-law-mcp";
import { createDesktopRuntime } from "../runtime";
import { agentGoalSchema } from "./agent-contracts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function law(overrides: Partial<KoreanLawMcpAdapter> = {}): KoreanLawMcpAdapter {
  return {
    tools: () => ["search_law", "get_law_text"],
    discover: async () => ["search_law", "get_law_text"],
    execute: async () => ({
      ok: true,
      value: { content: {}, citations: [] },
    }),
    close: async () => undefined,
    ...overrides,
  } as KoreanLawMcpAdapter;
}

function provider(
  decision: (input: ApprovedAgentDecisionContext) => Promise<unknown>,
  interrupt: () => Promise<void> = async () => undefined,
): CodexAgentDecisionProvider {
  return {
    state: {
      status: "authenticated",
      account: { type: "chatgpt", email: "masked@example.test", planType: "test" },
    },
    nextDecision: decision,
    interrupt,
    startChatGptLogin: async () => {
      throw new Error("unused");
    },
    dispose: async () => undefined,
  } as unknown as CodexAgentDecisionProvider;
}

async function caseFixture(runtime: Awaited<ReturnType<typeof createDesktopRuntime>>) {
  const created = await runtime.handlers.createCase({
    amountKrw: 538_000,
    jurisdiction: "domestic",
    paymentMethod: "bank-transfer",
  });
  if (created.status !== "accepted") throw new Error("case fixture failed");
  return created.caseId;
}

describe("desktop Agent runtime integration", () => {
  test("resumes an interrupted run after recreating the desktop runtime", async () => {
    const root = await mkdtemp(join(tmpdir(), "haksul-agent-runtime-"));
    roots.push(root);
    const key = new Uint8Array(32).fill(19);
    let releaseFirst!: () => void;
    const firstInterrupted = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let secondTurnStarted!: () => void;
    const secondTurn = new Promise<void>((resolve) => {
      secondTurnStarted = resolve;
    });
    let firstCalls = 0;
    let lawCalls = 0;
    let interruptCalls = 0;
    const firstProvider = provider(
      async () => {
        firstCalls += 1;
        if (firstCalls === 1) {
          return {
            kind: "tool",
            decisionId: "provider-decision-1",
            toolCall: {
              toolName: "search-official-law",
              toolCallId: "provider-tool-1",
              query: "지급명령",
            },
          };
        }
        secondTurnStarted();
        await firstInterrupted;
        throw new Error("transport interrupted");
      },
      async () => {
        interruptCalls += 1;
        releaseFirst();
      },
    );
    const runtime1 = await createDesktopRuntime(root, {
      loadKey: async () => key,
      createLaw: () =>
        law({
          execute: async () => {
            lawCalls += 1;
            return { ok: true, value: { content: {}, citations: [] } };
          },
        }),
      createProvider: async () => firstProvider,
    });
    const caseId = await caseFixture(runtime1);
    const opened = await runtime1.agent.openCase(caseId);
    const running = runtime1.agent.start({
      caseId,
      goal: agentGoalSchema.parse({
        kind: "civil-recovery",
        caseId,
        objective: "prepare-civil-demand",
      }),
      approvedContextDigest: opened.contextDigest,
    });
    await secondTurn;

    let resumedCalls = 0;
    let resumedObservations = 0;
    const runtime2 = await createDesktopRuntime(root, {
      loadKey: async () => key,
      createLaw: () => law(),
      createProvider: async () =>
        provider(async (input) => {
          resumedCalls += 1;
          resumedObservations = input.observations.length;
          return {
            kind: "finish",
            decisionId: "ignored-provider-id",
            outcome: { kind: "completed", summary: "Recovered safely" },
          };
        }),
    });
    const recovered = await runtime2.agent.openCase(caseId);
    expect(recovered.interruptedRun?.state.kind).toBe("interrupted");
    expect(resumedCalls).toBe(0);
    expect(lawCalls).toBe(1);
    if (recovered.interruptedRun === undefined) throw new Error("recovery fixture failed");

    const resumed = await runtime2.agent.resume({
      caseId,
      runId: recovered.interruptedRun.runId,
      approvedContextDigest: recovered.contextDigest,
    });
    expect(resumed.status).toBe("completed");
    if (resumed.status !== "completed") throw new Error("resume fixture failed");
    expect(resumed.run.runId).toBe(recovered.interruptedRun.runId);
    expect(resumedCalls).toBe(1);
    expect(resumedObservations).toBe(1);
    expect(firstCalls).toBe(2);
    expect(lawCalls).toBe(1);

    await runtime2.dispose();
    await runtime1.dispose().catch(() => undefined);
    await running.catch(() => undefined);
    expect(interruptCalls).toBe(1);
  });

  test("reports MCP initialization failure without starting or replaying a run", async () => {
    const root = await mkdtemp(join(tmpdir(), "haksul-agent-mcp-failure-"));
    roots.push(root);
    const runtime = await createDesktopRuntime(root, {
      loadKey: async () => new Uint8Array(32).fill(23),
      createLaw: () => law({ discover: async () => Promise.reject(new Error("MCP failed")) }),
      createProvider: async () => provider(async () => ({ kind: "finish" })),
    });
    const caseId = await caseFixture(runtime);
    const opened = await runtime.agent.openCase(caseId);
    const result = await runtime.agent.start({
      caseId,
      goal: agentGoalSchema.parse({
        kind: "civil-recovery",
        caseId,
        objective: "prepare-civil-demand",
      }),
      approvedContextDigest: opened.contextDigest,
    });
    expect(result).toEqual({ status: "unavailable", reason: "mcp-initialization" });
    await runtime.dispose();
  });
});
