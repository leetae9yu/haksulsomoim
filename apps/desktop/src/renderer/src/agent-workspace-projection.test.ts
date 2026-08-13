import { describe, expect, test } from "bun:test";
import { agentRunProjectionSchema } from "../../contracts/desktop-api";
import { acceptAgentProjection } from "./agent-workspace-projection";
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

  test("keeps cancellation monotonic and rejects out-of-order same-run events", () => {
    const cancelled = agentRunProjectionSchema.parse({
      ...activeProjection(),
      revision: 10,
      state: { kind: "interrupted", interruption: { kind: "user-cancelled" } },
    });
    expect(acceptAgentProjection(cancelled, paused(11))).toBe(cancelled);
    expect(acceptAgentProjection(cancelled, { ...activeProjection(), revision: 9 })).toBe(
      cancelled,
    );
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
