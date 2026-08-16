import { describe, expect, test } from "bun:test";

import { SecureComputerActionGate } from "./action-gate";

const digest = "a".repeat(64);

describe("SecureComputerActionGate", () => {
  const gate = new SecureComputerActionGate(["ecfs.scourt.go.kr"]);

  test("allows reversible navigation on an allowlisted court host", () => {
    expect(
      gate.evaluate({
        url: "https://ecfs.scourt.go.kr/ecf/index.jsp",
        action: { kind: "click", x: 40, y: 80, observationDigest: digest },
        target: { text: "민사서류", tagName: "BUTTON" },
      }),
    ).toEqual({ outcome: "allowed" });
  });

  test("requires user takeover immediately before legal or financial actions", () => {
    expect(
      gate.evaluate({
        url: "https://ecfs.scourt.go.kr/ecf/submit.jsp",
        action: { kind: "click", x: 40, y: 80, observationDigest: digest },
        target: { text: "최종 제출 및 결제", tagName: "BUTTON" },
      }),
    ).toEqual({ outcome: "requires-user", reason: "high-risk-action" });
  });

  test("rejects raw identifiers and non-allowlisted origins", () => {
    expect(
      gate.evaluate({
        url: "https://ecfs.scourt.go.kr/ecf/form.jsp",
        action: {
          kind: "type-text",
          x: 40,
          y: 80,
          text: "010-1234-5678",
          observationDigest: digest,
        },
        target: { text: "연락처", tagName: "INPUT", inputType: "text" },
      }),
    ).toEqual({ outcome: "rejected", reason: "raw-identifier" });

    expect(
      gate.evaluate({
        url: "https://evil.example/phish",
        action: { kind: "scroll", deltaX: 0, deltaY: 300, observationDigest: digest },
      }),
    ).toEqual({ outcome: "rejected", reason: "origin-not-allowlisted" });
  });

  test("requires takeover for password and authentication fields", () => {
    expect(
      gate.evaluate({
        url: "https://ecfs.scourt.go.kr/ecf/login.jsp",
        action: {
          kind: "type-token",
          x: 40,
          y: 80,
          token: "[PERSON_AAAAAAAAAAAAAAAA]",
          observationDigest: digest,
        },
        target: { text: "비밀번호", tagName: "INPUT", inputType: "password" },
      }),
    ).toEqual({ outcome: "requires-user", reason: "authentication-field" });
  });

  test("rejects typing when the observed target is not an editable field", () => {
    expect(
      gate.evaluate({
        url: "https://ecfs.scourt.go.kr/ecf/form.jsp",
        action: {
          kind: "type-token",
          x: 40,
          y: 80,
          token: "[PERSON_AAAAAAAAAAAAAAAA]",
          observationDigest: digest,
        },
        target: { text: "사건 화면", tagName: "DIV" },
      }),
    ).toEqual({ outcome: "rejected", reason: "unsupported-input-target" });
  });
});
