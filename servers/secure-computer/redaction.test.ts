import { describe, expect, test } from "bun:test";
import { containsDirectIdentifier, Redactor } from "./redaction";
import { SecureComputerRedactionSession } from "./redaction-session";

describe("secure-computer redaction", () => {
  test("replaces direct identifiers with stable case-scoped tokens", () => {
    const redactor = new Redactor(new Uint8Array(32).fill(0x5a));
    const first = redactor.redactWithMappings(
      "case-a",
      "성명: 홍길동 / 전화 010-1234-5678 / 계좌 123-456-789012",
    );
    const second = redactor.redactWithMappings("case-a", "전화 010-1234-5678");
    expect(first.text).not.toContain("홍길동");
    expect(first.text).not.toContain("010-1234-5678");
    expect(first.text).not.toContain("123-456-789012");
    expect(first.mappings.find((mapping) => mapping.kind === "PHONE")?.token).toBe(
      second.mappings[0]?.token,
    );
    expect(containsDirectIdentifier(first.text)).toBe(false);
  });

  test("rehydrates a token only inside the active local session", () => {
    const session = new SecureComputerRedactionSession(
      "case-a",
      new Redactor(new Uint8Array(32).fill(7)),
    );
    const result = session.redact("전화 010-1234-5678");
    const token = result.mappings[0]?.token;
    expect(token).toBeDefined();
    expect(session.rehydrate(token ?? "")).toBe("010-1234-5678");
    session.dispose();
    expect(() => session.rehydrate(token ?? "")).toThrow("disposed");
  });
});
