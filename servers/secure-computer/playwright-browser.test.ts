import { describe, expect, test } from "bun:test";
import { access } from "node:fs/promises";
import type { LocalOcrPort } from "../contracts/ocr";
import { PlaywrightSecureBrowser } from "./playwright-browser";

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

describe("PlaywrightSecureBrowser", () => {
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
});
