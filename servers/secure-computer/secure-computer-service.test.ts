import { describe, expect, test } from "bun:test";
import type {
  ScreenMaskRegion,
  SecureBrowserInspection,
  SecureBrowserPort,
  SecureBrowserTarget,
} from "../contracts/secure-computer";
import { Redactor } from "./redaction";
import { SecureComputerService } from "./secure-computer-service";

class FakeBrowser implements SecureBrowserPort {
  readonly typed: string[] = [];
  masks: readonly ScreenMaskRegion[] = [];
  target: SecureBrowserTarget = { text: "연락처", tagName: "INPUT", inputType: "text" };
  startedUrl = "";

  async start(url: string): Promise<void> {
    this.startedUrl = url;
  }

  async inspect(): Promise<SecureBrowserInspection> {
    return {
      url: this.startedUrl,
      width: 800,
      height: 600,
      candidates: [
        {
          text: "전화 010-1234-5678",
          boundingBox: { x: 10, y: 10, width: 180, height: 30 },
        },
      ],
    };
  }

  async captureMasked(regions: readonly ScreenMaskRegion[]): Promise<Uint8Array> {
    this.masks = regions;
    return new TextEncoder().encode("masked-png");
  }

  async targetAt(): Promise<SecureBrowserTarget> {
    return this.target;
  }

  async click(): Promise<void> {}

  async typeText(_x: number, _y: number, text: string): Promise<void> {
    this.typed.push(text);
  }

  async scroll(): Promise<void> {}

  async close(): Promise<void> {}
}

describe("SecureComputerService", () => {
  test("requires a fresh masked observation for every action", async () => {
    const browser = new FakeBrowser();
    const service = new SecureComputerService({
      browser,
      caseId: "case-a",
      redactor: new Redactor(new Uint8Array(32).fill(3)),
      allowedHosts: ["ecfs.scourt.go.kr"],
      maxActions: 3,
    });
    await service.start("https://ecfs.scourt.go.kr/ecf/index.jsp");
    const observation = await service.observe();
    expect(observation.maskedText).not.toContain("010-1234-5678");
    expect(browser.masks).toHaveLength(1);
    const result = await service.act({
      kind: "click",
      x: 10,
      y: 10,
      observationDigest: observation.observationDigest,
    });
    expect(result).toEqual({ outcome: "executed", actionCount: 1 });
    expect(
      await service.act({
        kind: "click",
        x: 10,
        y: 10,
        observationDigest: observation.observationDigest,
      }),
    ).toEqual({ outcome: "rejected", reason: "stale-observation", actionCount: 1 });
    await service.close();
  });
});
