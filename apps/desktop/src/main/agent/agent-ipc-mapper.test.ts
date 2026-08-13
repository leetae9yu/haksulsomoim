import { describe, expect, test } from "bun:test";
import { agentRunProjectionSchema } from "./agent-ipc-contracts";
import { toAgentRunProjection } from "./agent-ipc-mapper";

const observationDigest = "b".repeat(64);
const summaryDigest = "c".repeat(64);

function runFixture() {
  const toolCall = {
    toolName: "search-official-law" as const,
    toolCallId: "tool-secret-provider-id",
    query: "이 입력은 렌더러에 노출되면 안 됩니다",
  };
  return {
    runId: "run-1",
    caseId: "case-1",
    goal: {
      kind: "civil-recovery" as const,
      caseId: "case-1",
      objective: "prepare-civil-demand" as const,
    },
    budget: { decisionsRemaining: 11, toolsRemaining: 7, durationMsRemaining: 280_000 },
    state: { kind: "terminal" as const, outcome: { kind: "completed" as const, summaryDigest } },
    steps: [
      { kind: "decision-started" as const, stepId: "step-1", decisionId: "decision-secret-id" },
      {
        kind: "decision-recorded" as const,
        stepId: "step-2",
        decision: { kind: "tool" as const, decisionId: "decision-secret-id", toolCall },
      },
      {
        kind: "tool-started" as const,
        stepId: "step-3",
        decisionId: "decision-secret-id",
        toolCall,
      },
      {
        kind: "tool-finished" as const,
        stepId: "step-4",
        result: {
          toolName: "search-official-law" as const,
          toolCallId: "tool-secret-provider-id",
          outcome: "completed" as const,
          observationDigest,
        },
      },
      {
        kind: "terminal" as const,
        stepId: "step-5",
        outcome: { kind: "completed" as const, summaryDigest },
      },
    ],
  };
}

const citation = {
  citationId: "law-1",
  stepId: "step-4",
  sourceUrl: "https://law.go.kr/법령/민사집행법",
  law: "민사집행법",
  versionDate: "2026-01-01",
  retrievedAt: "2026-08-11T00:00:00.000Z",
};

describe("bounded Agent renderer projection", () => {
  test("maps ordered step summaries and linked official citations without raw inputs or IDs", () => {
    const projection = toAgentRunProjection({ run: runFixture(), citations: [citation] });

    expect(JSON.stringify(projection.steps)).toBe(
      JSON.stringify([
        { kind: "decision-started", stepId: "step-1" },
        { kind: "decision-recorded", stepId: "step-2", decisionKind: "tool" },
        { kind: "tool-started", stepId: "step-3", toolName: "search-official-law" },
        {
          kind: "tool-finished",
          stepId: "step-4",
          toolName: "search-official-law",
          outcome: "completed",
        },
        { kind: "terminal", stepId: "step-5", outcome: { kind: "completed" } },
      ]),
    );
    expect(JSON.stringify(projection.citations)).toBe(JSON.stringify([citation]));
    expect(String(projection.lastStepId)).toBe("step-5");
    const serialized = JSON.stringify(projection);
    expect(serialized).not.toContain("렌더러에 노출되면 안 됩니다");
    expect(serialized).not.toContain("decision-secret-id");
    expect(serialized).not.toContain("tool-secret-provider-id");
    expect(serialized).not.toContain(observationDigest);
  });

  test("projects an opaque causal edge without exposing observation digests", () => {
    const run = runFixture();
    const started = run.steps.find((step) => step.kind === "tool-started");
    if (started?.kind !== "tool-started") throw new Error("missing law-search fixture");
    const search = {
      ...started.toolCall,
      basisObservationDigest: "d".repeat(64),
    };
    const causal = {
      ...run,
      steps: [
        {
          kind: "tool-started" as const,
          stepId: "step-inspect-start",
          decisionId: "decision-inspect",
          toolCall: { toolName: "inspect-masked-case" as const, toolCallId: "tool-inspect" },
        },
        {
          kind: "tool-finished" as const,
          stepId: "step-inspect-finish",
          result: {
            toolName: "inspect-masked-case" as const,
            toolCallId: "tool-inspect",
            outcome: "completed" as const,
            observationDigest: "d".repeat(64),
          },
        },
        ...run.steps.map((step) =>
          step.kind === "decision-recorded"
            ? { ...step, decision: { ...step.decision, toolCall: search } }
            : step.kind === "tool-started"
              ? { ...step, toolCall: search }
              : step,
        ),
      ],
    };
    const projection = toAgentRunProjection(causal);
    const law = projection.steps.find(
      (step) => step.kind === "tool-finished" && step.toolName === "search-official-law",
    );
    expect(law).toMatchObject({ dependsOnStepId: "step-inspect-finish" });
    expect(JSON.stringify(projection)).not.toContain("d".repeat(64));
  });

  test("rejects unlinked, unsafe, duplicate, or raw citation projections", () => {
    for (const unsafe of [
      { ...citation, stepId: "step-3" },
      { ...citation, sourceUrl: "https://law.go.kr.evil.example/민법" },
      { ...citation, rawContent: "forged" },
    ]) {
      expect(() => toAgentRunProjection({ run: runFixture(), citations: [unsafe] })).toThrow();
    }
    expect(() =>
      toAgentRunProjection({ run: runFixture(), citations: [citation, citation] }),
    ).toThrow();
  });

  test("keeps the renderer projection closed against tool inputs and provider metadata", () => {
    const projection = toAgentRunProjection({ run: runFixture(), citations: [citation] });
    expect(
      agentRunProjectionSchema.safeParse({
        ...projection,
        steps: [{ ...projection.steps[0], query: "forged" }],
      }).success,
    ).toBe(false);
    expect(
      agentRunProjectionSchema.safeParse({ ...projection, providerThreadId: "thread-secret" })
        .success,
    ).toBe(false);
  });
});
