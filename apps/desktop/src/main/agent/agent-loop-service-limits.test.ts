import { describe, expect, test } from "bun:test";
import type { ApprovedAgentDecisionContext } from "../../integrations/agent-provider/agent-provider";
import type { AgentLoopProvider } from "./agent-loop-service";
import {
  civilGoal,
  createLoopHarness,
  DIGEST_A,
  MutableClock,
  RecordingProvider,
} from "./agent-loop-test-fixtures";

describe("Agent loop limits and ownership", () => {
  test("stops at twelve decisions and never reexecutes an exact duplicate result", async () => {
    const provider = new RecordingProvider(() => ({
      kind: "tool",
      decisionId: "model-duplicate",
      toolCall: { toolName: "inspect-masked-case", toolCallId: "inspect-duplicate" },
    }));
    const { service } = createLoopHarness(provider);

    const run = await service.start({
      caseId: "case-1",
      goal: civilGoal(),
      approvedContextDigest: DIGEST_A,
    });

    expect(provider.inputs).toHaveLength(12);
    expect(run.budget.decisionsRemaining).toBe(0);
    expect(run.state).toEqual({
      kind: "terminal",
      outcome: { kind: "budget-exhausted", exhausted: "decisions" },
    });
    expect(run.steps.filter((step) => step.kind === "tool-started")).toHaveLength(1);
    expect(run.steps.filter((step) => step.kind === "tool-finished")).toHaveLength(1);
  });

  test("stops after exactly eight safe tool executions", async () => {
    const provider = new RecordingProvider((_input, index) => ({
      kind: "tool",
      decisionId: `model-${index + 1}`,
      toolCall: {
        toolName: "inspect-masked-case",
        toolCallId: `inspect-${index + 1}`,
      },
    }));
    const { service } = createLoopHarness(provider);

    const run = await service.start({
      caseId: "case-1",
      goal: civilGoal(),
      approvedContextDigest: DIGEST_A,
    });

    expect(provider.inputs).toHaveLength(8);
    expect(run.budget.toolsRemaining).toBe(0);
    expect(run.state).toEqual({
      kind: "terminal",
      outcome: { kind: "budget-exhausted", exhausted: "tools" },
    });
    expect(run.steps.filter((step) => step.kind === "tool-finished")).toHaveLength(8);
  });

  test("charges provider time against the exact five minute budget", async () => {
    const clock = new MutableClock();
    const provider = new RecordingProvider(() => {
      clock.value = 300_000;
      return {
        kind: "tool",
        decisionId: "too-late",
        toolCall: { toolName: "inspect-masked-case", toolCallId: "late-inspect" },
      };
    });
    const { service } = createLoopHarness(provider, { clock });

    const run = await service.start({
      caseId: "case-1",
      goal: civilGoal(),
      approvedContextDigest: DIGEST_A,
    });

    expect(run.budget.durationMsRemaining).toBe(0);
    expect(run.state).toEqual({
      kind: "terminal",
      outcome: { kind: "budget-exhausted", exhausted: "duration" },
    });
    expect(run.steps.some((step) => step.kind === "tool-started")).toBe(false);
  });

  test("allows one active run per case and cancellation interrupts after persistence", async () => {
    let announceStarted = (): void => undefined;
    let inspectPersistedCancellation = async (): Promise<void> => undefined;
    const started = new Promise<void>((resolve) => {
      announceStarted = resolve;
    });
    const decision = new Promise<unknown>(() => undefined);
    let interruptCalls = 0;
    const provider: AgentLoopProvider = {
      state: { status: "authenticated" },
      async nextDecision(_input: ApprovedAgentDecisionContext): Promise<unknown> {
        announceStarted();
        return decision;
      },
      async interrupt(): Promise<void> {
        interruptCalls += 1;
        await inspectPersistedCancellation();
      },
    };
    const { runs, service } = createLoopHarness(provider);
    inspectPersistedCancellation = async () => {
      const snapshot = await runs.load("run-1");
      expect(snapshot.run.state).toEqual({
        kind: "interrupted",
        interruption: { kind: "user-cancelled" },
      });
    };

    const active = service.start({
      caseId: "case-1",
      goal: civilGoal(),
      approvedContextDigest: DIGEST_A,
    });
    await started;
    await expect(
      service.start({
        caseId: "case-1",
        goal: civilGoal(),
        approvedContextDigest: DIGEST_A,
      }),
    ).rejects.toMatchObject({ code: "AGENT_LOOP_ALREADY_ACTIVE" });

    const cancelled = await service.cancel({ caseId: "case-1", runId: "run-1" });
    expect(cancelled.state).toEqual({
      kind: "interrupted",
      interruption: { kind: "user-cancelled" },
    });
    expect((await active).state).toEqual(cancelled.state);
    expect(interruptCalls).toBe(1);
  });
});
