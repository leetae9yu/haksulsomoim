import { describe, expect, test } from "bun:test";
import {
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
