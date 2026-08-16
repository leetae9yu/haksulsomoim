import { containsDirectIdentifier } from "../security/redaction";
import type {
  SecureBrowserTarget,
  SecureComputerAction,
  SecureComputerGateDecision,
} from "./contracts";

const HIGH_RISK_ACTION =
  /(?:최종\s*제출|제출\s*완료|결제|납부|송금|이체|서약|법적\s*동의|삭제|취소\s*확정|submit|pay|purchase|transfer|delete)/iu;
const AUTHENTICATION =
  /(?:로그인|인증|비밀번호|패스워드|일회용|공동인증서|금융인증서|captcha|password|otp|sign[ -]?in)/iu;

export class SecureComputerActionGate {
  readonly #allowedHosts: ReadonlySet<string>;

  constructor(allowedHosts: readonly string[]) {
    if (allowedHosts.length === 0) {
      throw new TypeError("At least one allowed host is required");
    }
    this.#allowedHosts = new Set(allowedHosts.map((host) => host.toLowerCase()));
  }

  evaluate(
    input: Readonly<{
      url: string;
      action: SecureComputerAction;
      target?: SecureBrowserTarget;
    }>,
  ): SecureComputerGateDecision {
    if (!this.#isAllowedUrl(input.url)) {
      return { outcome: "rejected", reason: "origin-not-allowlisted" };
    }
    if (input.action.kind === "type-text" && containsDirectIdentifier(input.action.text)) {
      return { outcome: "rejected", reason: "raw-identifier" };
    }
    if (input.action.kind === "scroll") {
      return { outcome: "allowed" };
    }
    if (input.target === undefined) {
      return { outcome: "rejected", reason: "target-unavailable" };
    }
    const typing = input.action.kind === "type-text" || input.action.kind === "type-token";
    const editable =
      input.target.tagName === "INPUT" ||
      input.target.tagName === "TEXTAREA" ||
      input.target.role === "textbox";
    if (typing && !editable) return { outcome: "rejected", reason: "unsupported-input-target" };

    const targetText = [
      input.target.text,
      input.target.ariaLabel ?? "",
      input.target.role ?? "",
      input.target.inputType ?? "",
    ].join(" ");
    if (input.target.inputType === "password" || AUTHENTICATION.test(targetText)) {
      return { outcome: "requires-user", reason: "authentication-field" };
    }
    if (input.action.kind === "click" && HIGH_RISK_ACTION.test(targetText)) {
      return { outcome: "requires-user", reason: "high-risk-action" };
    }
    return { outcome: "allowed" };
  }

  #isAllowedUrl(input: string): boolean {
    try {
      const url = new URL(input);
      const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
      const protocolAllowed = url.protocol === "https:" || (loopback && url.protocol === "http:");
      return protocolAllowed && this.#allowedHosts.has(url.hostname.toLowerCase());
    } catch {
      return false;
    }
  }
}
