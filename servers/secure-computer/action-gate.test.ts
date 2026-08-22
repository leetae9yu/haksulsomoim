import { describe, expect, test } from "bun:test";
import { SecureComputerActionGate } from "./action-gate";

const digest = "a".repeat(64);

describe("SecureComputerActionGate", () => {
  const gate = new SecureComputerActionGate(["ecfs.scourt.go.kr"]);

  test("allows a reversible action on an allowlisted host", () => {
    expect(
      gate.evaluate({
        url: "https://ecfs.scourt.go.kr/ecf/index.jsp",
        action: { kind: "click", x: 40, y: 80, observationDigest: digest },
        target: { text: "민사서류", tagName: "BUTTON" },
      }),
    ).toEqual({ outcome: "allowed" });
  });

  test("requires user takeover for authentication and final filing", () => {
    expect(
      gate.evaluate({
        url: "https://ecfs.scourt.go.kr/ecf/index.jsp",
        action: { kind: "click", x: 40, y: 80, observationDigest: digest },
        target: { text: "공동인증서 로그인", tagName: "BUTTON" },
      }).outcome,
    ).toBe("requires-user");
    expect(
      gate.evaluate({
        url: "https://ecfs.scourt.go.kr/ecf/index.jsp",
        action: { kind: "click", x: 40, y: 80, observationDigest: digest },
        target: { text: "최종 제출", tagName: "BUTTON" },
      }).outcome,
    ).toBe("requires-user");
  });

  test("rejects non-allowlisted hosts and raw identifiers", () => {
    expect(
      gate.evaluate({
        url: "https://example.com",
        action: { kind: "scroll", deltaX: 0, deltaY: 100, observationDigest: digest },
      }).outcome,
    ).toBe("rejected");
    expect(
      gate.evaluate({
        url: "https://ecfs.scourt.go.kr",
        action: {
          kind: "type-text",
          x: 10,
          y: 10,
          text: "010-1234-5678",
          observationDigest: digest,
        },
        target: { text: "연락처", tagName: "INPUT", inputType: "text" },
      }).outcome,
    ).toBe("rejected");
  });
});
