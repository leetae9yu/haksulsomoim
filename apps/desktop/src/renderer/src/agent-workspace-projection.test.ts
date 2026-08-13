import { describe, expect, test } from "bun:test";
import { agentRunProjectionSchema } from "../../contracts/desktop-api";
import { acceptAgentProjection, acceptAgentProjectionEvent } from "./agent-workspace-projection";
import { activeProjection, completedProjection } from "./agent-workspace-test-fixtures";

const paused = (revision: number) =>
  agentRunProjectionSchema.parse({
    ...activeProjection(),
    revision,
    state: { kind: "paused", reason: "user-paused" },
  });

const terminal = (outcome: unknown) =>
  agentRunProjectionSchema.parse({
    ...completedProjection(),
    revision: 10,
    state: { kind: "terminal", outcome },
  });

describe("Agent projection causal reducer", () => {
  test.each([
    { kind: "completed", summaryDigest: "c".repeat(64) },
    { kind: "budget-exhausted", exhausted: "decisions" },
    { kind: "failed-policy", reason: "context-changed" },
  ])("keeps terminal outcome $kind monotonic against a higher paused revision", (outcome) => {
    const current = terminal(outcome);
    expect(acceptAgentProjection(current, paused(11))).toBe(current);
  });

  test.each([
    { state: { kind: "terminal", outcome: { kind: "completed", summaryDigest: "c".repeat(64) } } },
    { state: { kind: "interrupted", interruption: { kind: "user-cancelled" } } },
    { state: { kind: "terminal", outcome: { kind: "failed-policy", reason: "context-changed" } } },
  ])("keeps completed, cancelled, and failed runs monotonic", ({ state }) => {
    const current = agentRunProjectionSchema.parse({
      ...activeProjection(),
      revision: 10,
      state,
    });
    expect(acceptAgentProjection(current, paused(11))).toBe(current);
    expect(acceptAgentProjection(current, { ...activeProjection(), revision: 12 })).toBe(current);
  });

  test("accepts only a strict higher-revision explicit restart resume", () => {
    const interrupted = agentRunProjectionSchema.parse({
      ...activeProjection(),
      revision: 5,
      state: { kind: "interrupted", interruption: { kind: "application-restarted" } },
    });
    const resumed = agentRunProjectionSchema.parse({
      ...activeProjection(),
      revision: 6,
      state: { kind: "active" },
    });
    expect(acceptAgentProjection(interrupted, resumed)).toBe(resumed);
    expect(acceptAgentProjection(interrupted, { ...resumed, revision: 5 })).toBe(interrupted);
    expect(acceptAgentProjection(interrupted, { ...resumed, revision: 4 })).toBe(interrupted);
    expect(acceptAgentProjection(interrupted, paused(6))).toBe(interrupted);
  });

  test.each(["provider-timeout", "user-cancelled"] as const)(
    "keeps non-resumable interruption %s monotonic",
    (kind) => {
      const interrupted = agentRunProjectionSchema.parse({
        ...activeProjection(),
        revision: 5,
        state: { kind: "interrupted", interruption: { kind } },
      });
      expect(acceptAgentProjection(interrupted, { ...activeProjection(), revision: 6 })).toBe(
        interrupted,
      );
    },
  );

  test("rejects unsolicited revival and wrong run, case, or step history", () => {
    const interrupted = agentRunProjectionSchema.parse({
      ...activeProjection(),
      revision: 5,
      state: { kind: "interrupted", interruption: { kind: "application-restarted" } },
    });
    const resumed = agentRunProjectionSchema.parse({
      ...activeProjection(),
      revision: 6,
      state: { kind: "active" },
    });
    const wrongRun = agentRunProjectionSchema.parse({ ...resumed, runId: "run-wrong" });
    const wrongCase = agentRunProjectionSchema.parse({
      ...resumed,
      caseId: "case-2",
      goal: { ...resumed.goal, caseId: "case-2" },
    });
    const missingStep = agentRunProjectionSchema.parse({
      ...resumed,
      lastStepId: resumed.steps[0]?.stepId ?? null,
      steps: resumed.steps.slice(0, 1),
    });
    expect(acceptAgentProjectionEvent(interrupted, resumed)).toBe(interrupted);
    expect(acceptAgentProjection(interrupted, wrongRun)).toBe(interrupted);
    expect(acceptAgentProjection(interrupted, wrongCase)).toBe(interrupted);
    expect(acceptAgentProjection(interrupted, missingStep)).toBe(interrupted);
  });

  test("rejects foreign case and run events while allowing an explicitly reset restart", () => {
    const current = terminal({ kind: "completed", summaryDigest: "c".repeat(64) });
    const newRun = agentRunProjectionSchema.parse({
      ...activeProjection(),
      runId: "run-restarted",
      revision: 0,
    });
    const foreignCase = activeProjection("case-2");
    expect(acceptAgentProjection(current, newRun)).toBe(current);
    expect(acceptAgentProjection(current, foreignCase)).toBe(current);
    expect(acceptAgentProjection(undefined, newRun)).toBe(newRun);
  });
});
