import { describe, expect, test } from "bun:test";

import { Redactor } from "../security/redaction";
import { SecureComputerRedactionSession } from "./redaction-session";

describe("SecureComputerRedactionSession", () => {
  test("keeps reversible values local while exposing only stable tokens", () => {
    const session = new SecureComputerRedactionSession(
      "case-secure-computer",
      new Redactor(new Uint8Array(32).fill(7)),
    );
    const result = session.redact("성명: 홍길동 / 전화 010-1234-5678 / 계좌 123-456-789012");

    expect(result.text).not.toContain("홍길동");
    expect(result.text).not.toContain("010-1234-5678");
    expect(result.text).not.toContain("123-456-789012");
    expect(result.mappings).toHaveLength(3);
    for (const mapping of result.mappings) {
      expect(session.rehydrate(mapping.token)).toBe(mapping.value);
    }

    expect(() => session.rehydrate("[PERSON_AAAAAAAAAAAAAAAA]")).toThrow("Unknown redaction token");
    session.dispose();
    expect(() => session.rehydrate(result.mappings[0]?.token ?? "")).toThrow(
      "Redaction session is disposed",
    );
  });
});
