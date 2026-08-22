import { describe, expect, test } from "bun:test";
import type {
  ScreenMaskRegion,
  SecureBrowserInspection,
  SecureBrowserPort,
  SecureBrowserTarget,
} from "../contracts/secure-computer";
import { Redactor } from "./redaction";
import { MAX_MASKED_IMAGE_BYTES, SecureComputerService } from "./secure-computer-service";

const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
};

class FakeBrowser implements SecureBrowserPort {
  readonly typed: string[] = [];
  masks: readonly ScreenMaskRegion[] = [];
  image = new TextEncoder().encode("masked-png");
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
    return this.image;
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

  test("serializes concurrent actions against one observation", async () => {
    const clickStarted = deferred<void>();
    const releaseClick = deferred<void>();
    class BlockingBrowser extends FakeBrowser {
      clickCount = 0;

      override async click(): Promise<void> {
        this.clickCount += 1;
        clickStarted.resolve();
        await releaseClick.promise;
      }
    }
    const browser = new BlockingBrowser();
    const service = new SecureComputerService({
      browser,
      caseId: "case-b",
      redactor: new Redactor(new Uint8Array(32).fill(4)),
      allowedHosts: ["ecfs.scourt.go.kr"],
      maxActions: 3,
    });
    await service.start("https://ecfs.scourt.go.kr/ecf/index.jsp");
    const observation = await service.observe();
    const action = {
      kind: "click" as const,
      x: 10,
      y: 10,
      observationDigest: observation.observationDigest,
    };

    const first = service.act(action);
    await clickStarted.promise;
    const second = service.act(action);
    releaseClick.resolve();

    expect(await Promise.all([first, second])).toEqual([
      { outcome: "executed", actionCount: 1 },
      { outcome: "rejected", reason: "stale-observation", actionCount: 1 },
    ]);
    expect(browser.clickCount).toBe(1);
    await service.close();
  });

  test("rejects masked screenshots that exceed the transport budget", async () => {
    const browser = new FakeBrowser();
    browser.image = new Uint8Array(MAX_MASKED_IMAGE_BYTES + 1);
    const service = new SecureComputerService({
      browser,
      caseId: "case-c",
      redactor: new Redactor(new Uint8Array(32).fill(5)),
      allowedHosts: ["ecfs.scourt.go.kr"],
      maxActions: 3,
    });
    await service.start("https://ecfs.scourt.go.kr/ecf/index.jsp");

    await expect(service.observe()).rejects.toThrow("Masked screenshot exceeds the byte limit");
    await service.close();
  });

  test("invalidates the previous observation when a new capture fails", async () => {
    const browser = new FakeBrowser();
    const service = new SecureComputerService({
      browser,
      caseId: "case-d",
      redactor: new Redactor(new Uint8Array(32).fill(6)),
      allowedHosts: ["ecfs.scourt.go.kr"],
      maxActions: 3,
    });
    await service.start("https://ecfs.scourt.go.kr/ecf/index.jsp");
    const previous = await service.observe();
    browser.image = new Uint8Array(MAX_MASKED_IMAGE_BYTES + 1);

    await expect(service.observe()).rejects.toThrow("Masked screenshot exceeds the byte limit");
    expect(
      await service.act({
        kind: "click",
        x: 10,
        y: 10,
        observationDigest: previous.observationDigest,
      }),
    ).toEqual({ outcome: "rejected", reason: "stale-observation", actionCount: 0 });
    await service.close();
  });
});
