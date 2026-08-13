import { describe, expect, test } from "bun:test";
import { createHostCompletionDigest } from "./agent-loop-decisions";
import {
  civilGoal,
  createLoopHarness,
  DIGEST_A,
  DIGEST_B,
  DIGEST_C,
  RecordingProvider,
} from "./agent-loop-test-fixtures";

describe("host-owned bounded Agent loop", () => {
  test("uses a persisted observation to choose and execute the next safe tool", async () => {
    const provider = new RecordingProvider((_input, index) => {
      if (index === 0) {
        return {
          kind: "tool",
          decisionId: "model-decision-1",
          toolCall: { toolName: "inspect-masked-case", toolCallId: "inspect-1" },
        };
      }
      if (index === 1) {
        return {
          kind: "tool",
          decisionId: "model-decision-2",
          toolCall: {
            toolName: "search-official-law",
            toolCallId: "law-search-1",
            query: "지급명령 요건",
          },
        };
      }
      return {
        kind: "finish",
        decisionId: "model-decision-3",
        outcome: { kind: "completed", summaryDigest: DIGEST_C },
      };
    });
    const { lawSearches, runs, service } = createLoopHarness(provider);

    const run = await service.start({
      caseId: "case-1",
      goal: civilGoal(),
      approvedContextDigest: DIGEST_A,
    });

    expect(run.state.kind).toBe("terminal");
    if (run.state.kind !== "terminal" || run.state.outcome.kind !== "completed") {
      throw new Error("expected a completed Agent run");
    }
    expect(String(run.state.outcome.summaryDigest)).toBe(
      createHostCompletionDigest(
        run.steps.flatMap((step) => (step.kind === "tool-finished" ? [step.result] : [])),
      ),
    );
    expect(String(run.state.outcome.summaryDigest)).not.toBe(DIGEST_C);
    expect(provider.inputs).toHaveLength(3);
    const results = run.steps.flatMap((step) =>
      step.kind === "tool-finished" ? [step.result] : [],
    );
    expect(results).toHaveLength(2);
    const firstResult = results[0];
    if (firstResult === undefined) throw new Error("missing first persisted observation");
    expect(results.map((result) => result.toolName)).toEqual([
      "inspect-masked-case",
      "search-official-law",
    ]);
    expect(provider.inputs[1]?.observations).toEqual([firstResult]);
    expect(provider.inputs[2]?.observations).toEqual(results);
    expect(provider.inputs[2]?.citationIds).toContain("citation-1");
    expect(lawSearches).toEqual(["지급명령 요건"]);

    const persisted = await runs.load(run.runId);
    expect(persisted.run).toEqual(run);
    expect(persisted.cursor).toBe(run.steps.length);
    const firstResultSave = runs.saves.find((snapshot) =>
      snapshot.run.steps.some(
        (step) => step.kind === "tool-finished" && step.result.toolCallId === "tool-1",
      ),
    );
    expect(firstResultSave).toBeDefined();
  });

  test("never executes consequential or stale-approved actions", async () => {
    const provider = new RecordingProvider((_input, index) => {
      if (index === 0) {
        return {
          kind: "request-approval",
          decisionId: "model-approval-decision",
          approval: {
            approvalId: "approval-1",
            approvalDigest: DIGEST_B,
            caseId: "case-1",
            decisionId: "model-approval-decision",
            action: "approve-filing",
            contextDigest: DIGEST_A,
          },
        };
      }
      if (index === 1) {
        return {
          kind: "tool",
          decisionId: "model-action-decision",
          toolCall: {
            toolName: "request-user-action",
            toolCallId: "pending-action-1",
            action: "approve-filing",
          },
        };
      }
      return {
        kind: "tool",
        decisionId: "malicious-decision",
        toolCall: {
          toolName: "mutate-workflow-and-submit",
          toolCallId: "unsafe-1",
          command: "attest-and-pay",
        },
      };
    });
    const { draftWrites, lawDetails, lawSearches, service } = createLoopHarness(provider);

    const approvalRun = await service.start({
      caseId: "case-1",
      goal: civilGoal(),
      approvedContextDigest: DIGEST_A,
    });
    expect(approvalRun.state).toEqual({ kind: "paused", reason: "approval-required" });
    const stale = await service.decideApproval({
      caseId: "case-1",
      runId: approvalRun.runId,
      approvalId: "approval-1",
      approvalDigest: DIGEST_C,
      outcome: "approved",
    });
    expect(stale.status).toBe("stale");
    expect(stale.run.state).toEqual({ kind: "paused", reason: "approval-required" });

    const proposedRun = await service.start({
      caseId: "case-1",
      goal: civilGoal(),
      approvedContextDigest: DIGEST_A,
    });
    expect(proposedRun.state).toEqual({ kind: "paused", reason: "approval-required" });
    expect(
      proposedRun.steps.some(
        (step) => step.kind === "tool-finished" && step.result.toolName === "request-user-action",
      ),
    ).toBe(true);

    const unsafeRun = await service.start({
      caseId: "case-1",
      goal: civilGoal(),
      approvedContextDigest: DIGEST_A,
    });
    expect(unsafeRun.state).toEqual({
      kind: "terminal",
      outcome: { kind: "failed-policy", reason: "unknown-tool" },
    });
    expect(lawSearches).toEqual([]);
    expect(lawDetails).toEqual([]);
    expect(draftWrites).toEqual([]);
  });
});
