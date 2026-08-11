import { describe, expect, test } from "bun:test";
import { createRedactedDiagnostic, type RedactedText, Redactor } from "./redaction";

const tokenKey = new Uint8Array(32).fill(0x5a);
const rawIdentifiers = [
  "900101-1234567",
  "010-1234-5678",
  "서울특별시 종로구 세종대로 209",
  "110-123-456789",
  "2024가단123456",
] as const;

const outbound = [
  "의뢰인 주민등록번호 900101-1234567, 전화 010-1234-5678.",
  "주소는 서울특별시 종로구 세종대로 209이고 계좌는 110-123-456789입니다.",
  "관련 사건은 2024가단123456입니다. 전화 010-1234-5678로 연락하세요.",
].join(" ");

describe("Redactor", () => {
  test("removes every direct identifier from outbound text", () => {
    const redactor = new Redactor(tokenKey);
    const redacted = redactor.redact("case-alpha", outbound);

    for (const raw of rawIdentifiers) {
      expect(redacted).not.toContain(raw);
    }

    expect(redacted).toMatch(/\[RRN_[A-Z0-9]{16}\]/);
    expect(redacted).toMatch(/\[PHONE_[A-Z0-9]{16}\]/);
    expect(redacted).toMatch(/\[ADDRESS_[A-Z0-9]{16}\]/);
    expect(redacted).toMatch(/\[ACCOUNT_[A-Z0-9]{16}\]/);
    expect(redacted).toMatch(/\[CASE_[A-Z0-9]{16}\]/);
  });

  test("uses stable tokens within one case and unlinkable tokens across cases", () => {
    const redactor = new Redactor(tokenKey);
    const repeated = "010-1234-5678 / 010-1234-5678";

    const first = redactor.redact("case-alpha", repeated);
    const again = redactor.redact("case-alpha", repeated);
    const otherCase = redactor.redact("case-beta", repeated);
    const firstTokens = [...first.matchAll(/\[PHONE_[A-Z0-9]{16}\]/g)].map((match) => match[0]);

    expect(first).toBe(again);
    expect(firstTokens).toHaveLength(2);
    expect(firstTokens[0]).toBe(firstTokens[1]);
    expect(otherCase).not.toBe(first);
  });

  test("diagnostics are constructed only from branded redacted fields", () => {
    const redactor = new Redactor(tokenKey);
    const message: RedactedText = redactor.redact("case-alpha", outbound);
    const diagnostic = createRedactedDiagnostic("outbound-request", {
      message,
    });

    expect(diagnostic).toEqual({
      scope: "outbound-request",
      fields: { message },
    });
    for (const raw of rawIdentifiers) {
      expect(JSON.stringify(diagnostic)).not.toContain(raw);
    }
  });
});
