import { describe, expect, test } from "bun:test";
import {
  agentApprovalDecisionIpcRequestSchema,
  agentApprovalDecisionRequestSchema,
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
