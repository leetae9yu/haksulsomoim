import { describe, expect, test } from "bun:test";

import { Redactor } from "../security/redaction";
import type {
  ScreenMaskRegion,
  SecureBrowserInspection,
  SecureBrowserPort,
  SecureBrowserTarget,
} from "./contracts";
import { SecureComputerService } from "./secure-computer-service";

const decoder = new TextDecoder();

class FakeBrowser implements SecureBrowserPort {
  readonly clicks: Array<readonly [number, number]> = [];
  readonly typed: string[] = [];
  target: SecureBrowserTarget = { text: "연락처", tagName: "INPUT", inputType: "text" };
  startedUrl = "";

  async start(url: string): Promise<void> {
    this.startedUrl = url;
  }

  async inspect(): Promise<SecureBrowserInspection> {
    return {
      url: this.startedUrl,
      width: 1280,
      height: 900,
      candidates: [
        { text: "성명: 홍길동", boundingBox: { x: 10, y: 10, width: 100, height: 24 } },
        { text: "홍길동", boundingBox: { x: 55, y: 10, width: 50, height: 24 } },
        {
          text: "전화: 010-1234-5678 / 계좌: 123-456-789012",
          boundingBox: { x: 10, y: 40, width: 320, height: 24 },
        },
        { text: "010-1234-5678", boundingBox: { x: 50, y: 40, width: 110, height: 24 } },
        { text: "123-456-789012", boundingBox: { x: 210, y: 40, width: 115, height: 24 } },
      ],
    };
  }

  async captureMasked(regions: readonly ScreenMaskRegion[]): Promise<Uint8Array> {
    return new TextEncoder().encode(JSON.stringify(regions));
  }

  async targetAt(): Promise<SecureBrowserTarget> {
    return this.target;
  }

  async click(x: number, y: number): Promise<void> {
    this.clicks.push([x, y]);
  }

  async typeText(_x: number, _y: number, text: string): Promise<void> {
    this.typed.push(text);
  }

  async scroll(): Promise<void> {}
  async close(): Promise<void> {}
}

describe("SecureComputerService", () => {
  const createService = () => {
    const browser = new FakeBrowser();
    const service = new SecureComputerService({
      browser,
      caseId: "case-secure-computer",
      redactor: new Redactor(new Uint8Array(32).fill(11)),
      allowedHosts: ["ecfs.scourt.go.kr"],
      maxActions: 8,
    });
    return { browser, service };
  };

  test("redacts screenshot regions before observation and rehydrates tokens only locally", async () => {
    const { browser, service } = createService();
    await service.start("https://ecfs.scourt.go.kr/ecf/form.jsp");

    const observation = await service.observe();
    const outbound = `${observation.maskedText}\n${decoder.decode(observation.imagePng)}`;
    expect(outbound).not.toContain("홍길동");
    expect(outbound).not.toContain("010-1234-5678");
    const maskRegions = JSON.parse(decoder.decode(observation.imagePng)) as unknown[];
    expect(maskRegions).toHaveLength(2);

    const phoneToken = observation.maskedText.match(/\[PHONE_[A-Z2-7]{16}\]/)?.[0];
    expect(phoneToken).toBeDefined();
    const result = await service.act({
      kind: "type-token",
      x: 80,
      y: 120,
      token: phoneToken ?? "",
      observationDigest: observation.observationDigest,
    });

    expect(result).toEqual({ outcome: "executed", actionCount: 1 });
    expect(browser.typed).toEqual(["010-1234-5678"]);
    expect(JSON.stringify(result)).not.toContain("010-1234-5678");
  });

  test("blocks stale actions and final submission without mutating the browser", async () => {
    const { browser, service } = createService();
    await service.start("https://ecfs.scourt.go.kr/ecf/submit.jsp");
    const observation = await service.observe();

    const stale = await service.act({
      kind: "click",
      x: 100,
      y: 200,
      observationDigest: "f".repeat(64),
    });
    expect(stale).toEqual({ outcome: "rejected", reason: "stale-observation", actionCount: 0 });

    browser.target = { text: "최종 제출", tagName: "BUTTON" };
    const blocked = await service.act({
      kind: "click",
      x: 100,
      y: 200,
      observationDigest: observation.observationDigest,
    });
    expect(blocked).toEqual({
      outcome: "requires-user",
      reason: "high-risk-action",
      actionCount: 0,
    });
    expect(browser.clicks).toHaveLength(0);
  });
});
