import { describe, expect, test } from "bun:test";
import type { AgentLoopProvider } from "./agent-loop-service";
import {
  civilGoal,
  createLoopHarness,
  DIGEST_A,
  DIGEST_B,
  DIGEST_C,
  MutableProjectionReader,
  RecordingProvider,
} from "./agent-loop-test-fixtures";
import type { AgentOfficialLawTools } from "./agent-tool-registry";

describe("Agent loop context and availability boundaries", () => {
  test("pauses before outbound work when the approved context digest changed", async () => {
    const provider = new RecordingProvider(() => ({
      kind: "finish",
      decisionId: "must-not-run",
      outcome: { kind: "completed", summaryDigest: DIGEST_C },
    }));
    const projection = new MutableProjectionReader();
    projection.projection = { ...projection.projection, contextDigest: DIGEST_B };
    const { service } = createLoopHarness(provider, { projection });

    const run = await service.start({
      caseId: "case-1",
      goal: civilGoal(),
      approvedContextDigest: DIGEST_A,
    });

    expect(provider.inputs).toHaveLength(0);
    expect(run.state).toEqual({ kind: "paused", reason: "context-changed" });
  });

  test("rechecks context after the provider and executes zero stale-context tools", async () => {
    const projection = new MutableProjectionReader();
    const provider = new RecordingProvider(() => {
      projection.projection = { ...projection.projection, contextDigest: DIGEST_B };
      return {
        kind: "tool",
        decisionId: "stale-context-decision",
        toolCall: {
          toolName: "write-local-draft",
          toolCallId: "stale-draft",
          artifactKind: "civil-demand",
          contentDigest: DIGEST_C,
        },
      };
    });
    const { draftWrites, service } = createLoopHarness(provider, { projection });

    const run = await service.start({
      caseId: "case-1",
      goal: civilGoal(),
      approvedContextDigest: DIGEST_A,
    });

    expect(run.state).toEqual({ kind: "paused", reason: "context-changed" });
    expect(draftWrites).toEqual([]);
    expect(run.steps.some((step) => step.kind === "tool-started")).toBe(false);
  });

  test("pauses for unavailable provider while manual case work remains callable", async () => {
    let providerCalls = 0;
    let manualCalls = 0;
    const provider: AgentLoopProvider = {
      state: { status: "unavailable" },
      async nextDecision(): Promise<unknown> {
        providerCalls += 1;
        throw new Error("must not call unavailable provider");
      },
      async interrupt(): Promise<void> {},
    };
    const manualService = {
      async enforcementChoices(caseId: string) {
        manualCalls += 1;
        return { status: "manual-ok", caseId };
      },
    };
    const { service } = createLoopHarness(provider);

    const run = await service.start({
      caseId: "case-1",
      goal: civilGoal(),
      approvedContextDigest: DIGEST_A,
    });
    const manual = await manualService.enforcementChoices("case-1");

    expect(run.state).toEqual({ kind: "paused", reason: "provider-unavailable" });
    expect(providerCalls).toBe(0);
    expect(manual).toEqual({ status: "manual-ok", caseId: "case-1" });
    expect(manualCalls).toBe(1);
  });

  test("persists an unavailable law observation and leaves manual work callable", async () => {
    let manualCalls = 0;
    const provider = new RecordingProvider(() => ({
      kind: "tool",
      decisionId: "law-unavailable",
      toolCall: {
        toolName: "search-official-law",
        toolCallId: "law-unavailable-call",
        query: "민법",
      },
    }));
    const law: AgentOfficialLawTools = {
      async search() {
        return { status: "unavailable", reason: "mcp-unavailable" };
      },
      async detail() {
        return { status: "unavailable", reason: "mcp-unavailable" };
      },
    };
    const manualService = {
      async enforcementChoices() {
        manualCalls += 1;
        return { status: "manual-ok" };
      },
    };
    const { service } = createLoopHarness(provider, { law });

    const run = await service.start({
      caseId: "case-1",
      goal: civilGoal(),
      approvedContextDigest: DIGEST_A,
    });
    expect(await manualService.enforcementChoices()).toEqual({ status: "manual-ok" });

    expect(run.state).toEqual({ kind: "paused", reason: "provider-unavailable" });
    expect(run.steps.find((step) => step.kind === "tool-finished")).toMatchObject({
      result: { outcome: "unavailable" },
    });
    expect(manualCalls).toBe(1);
  });

  test("rejects provider attempts to forge host-owned terminal outcomes", async () => {
    const provider = new RecordingProvider(() => ({
      kind: "finish",
      decisionId: "forged-budget-outcome",
      outcome: { kind: "budget-exhausted", exhausted: "tools" },
    }));
    const { service } = createLoopHarness(provider);

    const run = await service.start({
      caseId: "case-1",
      goal: civilGoal(),
      approvedContextDigest: DIGEST_A,
    });

    expect(run.state).toEqual({
      kind: "terminal",
      outcome: { kind: "failed-policy", reason: "unknown-tool" },
    });
  });

  test("records an exact denial and keeps the consequential action pending", async () => {
    const provider = new RecordingProvider(() => ({
      kind: "request-approval",
      decisionId: "approval-decision",
      approval: {
        approvalId: "approval-deny",
        approvalDigest: DIGEST_B,
        caseId: "case-1",
        decisionId: "approval-decision",
        action: "review-draft",
        contextDigest: DIGEST_A,
      },
    }));
    const { service } = createLoopHarness(provider);
    const pending = await service.start({
      caseId: "case-1",
      goal: civilGoal(),
      approvedContextDigest: DIGEST_A,
    });

    const denied = await service.decideApproval({
      caseId: "case-1",
      runId: pending.runId,
      approvalId: "approval-deny",
      approvalDigest: DIGEST_B,
      outcome: "denied",
    });

    expect(denied.status).toBe("recorded");
    expect(denied.run.state).toEqual({ kind: "paused", reason: "approval-required" });
    expect(denied.run.steps.at(-1)).toMatchObject({
      kind: "approval-decided",
      decision: { outcome: "denied" },
    });
  });
});
