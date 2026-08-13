import { describe, expect, test } from "bun:test";
import {
  agentApprovalDecisionIpcRequestSchema,
  agentApprovalDecisionRequestSchema,
  agentArtifactOpenRequestSchema,
  agentArtifactViewSchema,
  agentCaseContextSchema,
  agentCaseOpenRequestSchema,
  agentRunListResponseSchema,
  agentRunResumeRequestSchema,
  agentRunStartIpcRequestSchema,
  agentRunStartRequestSchema,
  caseCreateRequestSchema,
  evidenceAnalyzeRequestSchema,
  officialSourceRequestSchema,
  trustedAuthenticationRequestSchema,
} from "./desktop-api";

describe("desktop IPC contracts", () => {
  test("accepts only the supported intake boundary", () => {
    expect(
      caseCreateRequestSchema.safeParse({
        amountKrw: 5_380_000,
        jurisdiction: "domestic",
        paymentMethod: "bank-transfer",
      }).success,
    ).toBe(true);
    expect(
      caseCreateRequestSchema.safeParse({
        amountKrw: 30_000_001,
        jurisdiction: "domestic",
        paymentMethod: "bank-transfer",
      }).success,
    ).toBe(false);
  });

  test.each([
    ["https://law.go.kr/법령", true],
    ["https://scourt.go.kr/portal/main.jsp", true],
    ["https://ecrm.police.go.kr/minwon/main", true],
    ["http://law.go.kr/법령", false],
    ["https://www.law.go.kr/법령", true],
    ["https://law.go.kr.evil.example/", false],
    ["https://scourt.go.kr:444/", false],
    ["not a URL", false],
  ])("allows only an explicit official HTTPS origin: %s", (url, expected) => {
    expect(officialSourceRequestSchema.safeParse({ url }).success).toBe(expected);
  });

  test.each([
    ["https://auth.openai.com/oauth/authorize?state=opaque", true],
    ["http://auth.openai.com/oauth/authorize", false],
    ["https://www.auth.openai.com/oauth/authorize", false],
    ["https://auth.openai.com.evil.example/oauth/authorize", false],
    ["https://auth.openai.com:444/oauth/authorize", false],
  ])("allows only the exact trusted authentication origin: %s", (url, expected) => {
    expect(trustedAuthenticationRequestSchema.safeParse({ url }).success).toBe(expected);
  });

  test("accepts only matching Agent case goals and current approval digests", () => {
    const digest = "a".repeat(64);
    expect(
      agentRunStartRequestSchema.safeParse({
        caseId: "case-1",
        goal: {
          kind: "civil-recovery",
          caseId: "case-1",
          objective: "prepare-civil-demand",
        },
      }).success,
    ).toBe(true);
    expect(
      agentRunStartRequestSchema.safeParse({
        caseId: "case-1",
        goal: {
          kind: "criminal-complaint",
          caseId: "case-2",
          objective: "prepare-criminal-complaint",
        },
      }).success,
    ).toBe(false);
    expect(
      agentApprovalDecisionRequestSchema.safeParse({
        approval: {
          approvalId: "approval-1",
          approvalDigest: digest,
          caseId: "case-1",
          decisionId: "decision-1",
          action: "review-draft",
          contextDigest: digest,
        },
        decision: {
          approvalId: "approval-1",
          approvalDigest: "b".repeat(64),
          outcome: "approved",
        },
      }).success,
    ).toBe(false);
  });

  test("returns only a strict case-bound masked context digest", () => {
    const context = { caseId: "case-1", contextDigest: "a".repeat(64) };
    expect(agentCaseOpenRequestSchema.safeParse({ caseId: "case-1" }).success).toBe(true);
    expect(agentCaseOpenRequestSchema.safeParse({ ...context, evidenceId: "raw" }).success).toBe(
      false,
    );
    expect(agentCaseContextSchema.safeParse(context).success).toBe(true);
    expect(
      agentCaseContextSchema.safeParse({
        ...context,
        maskedFacts: [{ id: "raw", text: "must not cross IPC" }],
        providerId: "forged",
      }).success,
    ).toBe(false);
  });

  test("bounds app-owned Agent artifact opening without paths or provider payloads", () => {
    const request = {
      caseId: "case-1",
      runId: "run-1",
      contextDigest: "a".repeat(64),
      artifactId: "artifact-1",
    };
    const view = {
      artifactId: "artifact-1",
      artifactKind: "civil-demand",
      title: "민사 초안",
      sections: [{ heading: "요약", text: "마스킹된 사실" }],
      citationIds: ["citation-1"],
    };
    expect(agentArtifactOpenRequestSchema.safeParse(request).success).toBe(true);
    expect(
      agentArtifactOpenRequestSchema.safeParse({ ...request, rawPath: "/tmp/x" }).success,
    ).toBe(false);
    expect(agentArtifactViewSchema.safeParse(view).success).toBe(true);
    expect(agentArtifactViewSchema.safeParse({ ...view, providerPayload: {} }).success).toBe(false);
  });

  test("closes Agent lifecycle inputs and bounds renderer user input", () => {
    const digest = "a".repeat(64);
    const start = {
      caseId: "case-1",
      goal: {
        kind: "civil-recovery",
        caseId: "case-1",
        objective: "prepare-civil-demand",
      },
      contextDigest: digest,
    };
    expect(agentRunStartIpcRequestSchema.safeParse(start).success).toBe(true);
    expect(
      agentRunStartIpcRequestSchema.safeParse({ ...start, providerId: "forged" }).success,
    ).toBe(false);
    expect(
      agentRunResumeRequestSchema.safeParse({
        caseId: "case-1",
        runId: "run-1",
        contextDigest: digest,
        userInput: "x".repeat(2_001),
      }).success,
    ).toBe(false);
    expect(
      agentApprovalDecisionIpcRequestSchema.safeParse({
        caseId: "case-1",
        runId: "run-1",
        contextDigest: digest,
        approvalId: "approval-1",
        approvalDigest: digest,
        outcome: "approved",
        toolResult: { outcome: "completed" },
      }).success,
    ).toBe(false);
  });

  test("rejects only duplicate Agent case-run identity pairs", () => {
    const run = {
      caseId: "case-1",
      runId: "run-1",
      goal: {
        kind: "civil-recovery" as const,
        caseId: "case-1",
        objective: "prepare-civil-demand" as const,
      },
      budget: { decisionsRemaining: 12, toolsRemaining: 8, durationMsRemaining: 300_000 },
      state: { kind: "active" as const },
      lastStepId: null,
      pendingApproval: null,
      steps: [],
      citations: [],
    };
    const sameRunDifferentCase = {
      ...run,
      caseId: "case-2",
      goal: { ...run.goal, caseId: "case-2" },
    };
    const sameCaseDifferentRun = { ...run, runId: "run-2" };

    expect(agentRunListResponseSchema.safeParse([run, sameRunDifferentCase]).success).toBe(true);
    expect(agentRunListResponseSchema.safeParse([run, sameCaseDifferentRun]).success).toBe(true);
    const duplicate = agentRunListResponseSchema.safeParse([run, run]);
    expect(duplicate.success).toBe(false);
    if (!duplicate.success) {
      expect(duplicate.error.issues).toEqual([
        {
          code: "custom",
          message: "Duplicate Agent run identity",
          path: [1],
        },
      ]);
    }
  });

  test("requires case association and rejects empty evidence bytes or unknown fields", () => {
    expect(
      evidenceAnalyzeRequestSchema.safeParse({
        filename: "capture.png",
        mimeType: "image/png",
        bytes: [137, 80, 78, 71],
      }).success,
    ).toBe(false);
    expect(
      evidenceAnalyzeRequestSchema.safeParse({
        caseId: "case-1",
        filename: "capture.png",
        mimeType: "image/png",
        bytes: [],
      }).success,
    ).toBe(false);
    expect(
      evidenceAnalyzeRequestSchema.safeParse({
        caseId: "case-1",
        filename: "capture.png",
        mimeType: "image/png",
        bytes: [137, 80, 78, 71],
        leakedPath: "C:\\Users\\victim\\capture.png",
      }).success,
    ).toBe(false);
  });
});
