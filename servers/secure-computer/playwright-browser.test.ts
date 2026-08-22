import { describe, expect, test } from "bun:test";
import { access } from "node:fs/promises";
import type { LocalOcrPort, OcrCandidate } from "../contracts/ocr";
import {
  deduplicateScreenCandidates,
  intersectMaskRegion,
  PlaywrightSecureBrowser,
} from "./playwright-browser";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
};

class EmptyOcr implements LocalOcrPort {
  recognize(): Promise<readonly []> {
    return Promise.resolve([]);
  }

  dispose(): Promise<void> {
    return Promise.resolve();
  }
}

class StaticOcr implements LocalOcrPort {
  constructor(readonly candidates: readonly OcrCandidate[]) {}

  recognize(): Promise<readonly OcrCandidate[]> {
    return Promise.resolve(this.candidates);
  }

  dispose(): Promise<void> {
    return Promise.resolve();
  }
}

describe("PlaywrightSecureBrowser", () => {
  test("intersects masks with the visible viewport", () => {
    const viewport = { width: 390, height: 844 };
    expect(
      intersectMaskRegion(
        { label: "[PERSON_TEST]", boundingBox: { x: 10, y: -40, width: 60, height: 20 } },
        viewport,
      ),
    ).toBeUndefined();
    expect(
      intersectMaskRegion(
        { label: "[PHONE_TEST]", boundingBox: { x: 10, y: -5, width: 80, height: 20 } },
        viewport,
      ),
    ).toEqual({
      label: "[PHONE_TEST]",
      boundingBox: { x: 10, y: 0, width: 80, height: 15 },
    });
    expect(
      intersectMaskRegion(
        { label: "[ACCOUNT_TEST]", boundingBox: { x: 410, y: 20, width: 40, height: 20 } },
        viewport,
      ),
    ).toBeUndefined();
    expect(
      intersectMaskRegion(
        { label: "[EMAIL_TEST]", boundingBox: { x: 10, y: 20, width: 0, height: 20 } },
        viewport,
      ),
    ).toBeUndefined();
    expect(
      intersectMaskRegion(
        { label: "[ADDRESS_TEST]", boundingBox: { x: 10, y: 20, width: 40, height: -1 } },
        viewport,
      ),
    ).toBeUndefined();
  });

  test("keeps a materially larger OCR region overlapping a DOM label", () => {
    const imageText = "주소 경기도 성남시 분당구 판교로 45";
    const candidates = deduplicateScreenCandidates([
      {
        text: "주소",
        boundingBox: { x: 100, y: 100, width: 40, height: 20 },
        context: "field-address",
        source: "dom",
      },
      {
        text: imageText,
        boundingBox: { x: 98, y: 98, width: 310, height: 32 },
        source: "ocr",
      },
    ]);

    expect(candidates.map(({ text }) => text)).toEqual(["주소", imageText]);
  });

  test("waits for a dynamically rendered portal body", async () => {
    const executablePath = process.env.HAKSUL_BROWSER_EXECUTABLE ?? "/usr/bin/chromium-browser";
    await access(executablePath);
    const readyRequested = deferred();
    const releaseReadyResponse = deferred();
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        if (new URL(request.url).pathname === "/ready") {
          readyRequested.resolve();
          await releaseReadyResponse.promise;
          return new Response("ready");
        }
        return new Response(
          `<!doctype html>
              <html lang="ko">
                <body></body>
                <script>
                  window.addEventListener("load", async () => {
                    await fetch("/ready");
                    document.body.innerHTML =
                      "<main><div>성명: 홍길동 신청유형: 지급명령</div><button>전자소송포털 로그인</button></main>";
                  });
                </script>
              </html>`,
          { headers: { "content-type": "text/html; charset=utf-8" } },
        );
      },
    });
    const browser = new PlaywrightSecureBrowser({
      ocr: new EmptyOcr(),
      allowedHosts: ["127.0.0.1"],
      executablePath,
      headless: true,
    });
    let startResolved = false;
    const start = browser.start(`http://127.0.0.1:${server.port}`).then(() => {
      startResolved = true;
    });

    try {
      await readyRequested.promise;
      expect(startResolved).toBe(false);
      releaseReadyResponse.resolve();
      await start;
      const inspection = await browser.inspect();
      const texts = inspection.candidates.map(({ text }) => text);
      expect(texts).toContain("성명:");
      expect(texts).toContain("홍길동");
      expect(texts).toContain("신청유형:");
      expect(texts).toContain("지급명령");
      expect(texts).toContain("전자소송포털");
      expect(texts).toContain("로그인");
    } finally {
      releaseReadyResponse.resolve();
      await start.catch(() => undefined);
      await browser.close();
      server.stop(true);
    }
  }, 30_000);

  test("prefers contextual DOM text over an overlapping OCR misread", async () => {
    const executablePath = process.env.HAKSUL_BROWSER_EXECUTABLE ?? "/usr/bin/chromium-browser";
    await access(executablePath);
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        new Response(
          `<!doctype html>
            <html lang="ko">
              <body style="margin:0">
                <div role="row" style="position:absolute;left:100px;top:100px">
                  <span style="font:700 20px sans-serif">홍길동</span>
                </div>
              </body>
            </html>`,
          { headers: { "content-type": "text/html; charset=utf-8" } },
        ),
    });
    const browser = new PlaywrightSecureBrowser({
      ocr: new StaticOcr([
        {
          text: "sus",
          confidence: 81,
          boundingBox: { x: 98, y: 98, width: 64, height: 30 },
        },
      ]),
      allowedHosts: ["127.0.0.1"],
      executablePath,
      headless: true,
    });
    try {
      await browser.start(`http://127.0.0.1:${server.port}`);
      const inspection = await browser.inspect();
      expect(inspection.candidates.map(({ text }) => text)).toContain("홍길동");
      expect(inspection.candidates.map(({ text }) => text)).not.toContain("sus");
    } finally {
      await browser.close();
      server.stop(true);
    }
  }, 30_000);

  test("preserves a larger image OCR candidate overlapping a DOM label", async () => {
    const executablePath = process.env.HAKSUL_BROWSER_EXECUTABLE ?? "/usr/bin/chromium-browser";
    await access(executablePath);
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        new Response(
          `<!doctype html>
            <html lang="ko">
              <body style="margin:0">
                <div role="row" style="position:absolute;left:100px;top:100px">
                  <span style="font:700 20px sans-serif">주소</span>
                  <canvas width="320" height="40"></canvas>
                </div>
              </body>
            </html>`,
          { headers: { "content-type": "text/html; charset=utf-8" } },
        ),
    });
    const imageText = "주소 경기도 성남시 분당구 판교로 45";
    const browser = new PlaywrightSecureBrowser({
      ocr: new StaticOcr([
        {
          text: imageText,
          confidence: 88,
          boundingBox: { x: 98, y: 98, width: 310, height: 32 },
        },
      ]),
      allowedHosts: ["127.0.0.1"],
      executablePath,
      headless: true,
    });
    try {
      await browser.start(`http://127.0.0.1:${server.port}`);
      const inspection = await browser.inspect();
      expect(inspection.candidates.map(({ text }) => text)).toContain("주소");
      expect(inspection.candidates.map(({ text }) => text)).toContain(imageText);
    } finally {
      await browser.close();
      server.stop(true);
    }
  }, 30_000);
});
