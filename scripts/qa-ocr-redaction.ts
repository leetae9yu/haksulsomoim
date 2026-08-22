import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ScreenMaskRegion } from "../servers/contracts/secure-computer";
import { createLocalKorEngOcr } from "../servers/secure-computer/local-ocr";
import { PlaywrightSecureBrowser } from "../servers/secure-computer/playwright-browser";
import { Redactor } from "../servers/secure-computer/redaction";
import { SecureComputerService } from "../servers/secure-computer/secure-computer-service";

const html = `<!doctype html>
<html lang="ko">
<body style="margin:0;background:#fff">
  <canvas id="document" width="1200" height="700"></canvas>
  <script>
    const canvas = document.querySelector("#document");
    const context = canvas.getContext("2d");
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#111";
    context.font = "700 32px sans-serif";
    [
      "성명: 홍길동",
      "전화: 010-1234-5678",
      "주민등록번호: 900101-1234567",
      "계좌: 123-456-789012",
      "신청유형: 지급명령",
    ].forEach((line, index) => context.fillText(line, 60, 90 + index * 70));
    document.currentScript.remove();
  </script>
</body>
</html>`;

class RecordingBrowser extends PlaywrightSecureBrowser {
  masks: readonly ScreenMaskRegion[] = [];

  override captureMasked(regions: readonly ScreenMaskRegion[]): Promise<Uint8Array> {
    this.masks = regions;
    return super.captureMasked(regions);
  }
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: () => new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } }),
});
const executablePath = process.env.HAKSUL_BROWSER_EXECUTABLE ?? "/usr/bin/chromium-browser";
const evidenceDirectory = process.env.QA_EVIDENCE_DIR;
await access(executablePath);
const browser = new RecordingBrowser({
  ocr: await createLocalKorEngOcr(),
  allowedHosts: ["127.0.0.1"],
  executablePath,
  headless: true,
  viewport: { width: 1200, height: 700 },
});
const computer = new SecureComputerService({
  browser,
  caseId: "ocr-redaction-qa",
  redactor: new Redactor(new Uint8Array(32).fill(0x51)),
  allowedHosts: ["127.0.0.1"],
  maxActions: 1,
});

try {
  await computer.start(`http://127.0.0.1:${server.port}`);
  const observation = await computer.observe();
  const rawValues = ["홍길동", "010-1234-5678", "900101-1234567", "123-456-789012"];
  const tokenKinds = ["PERSON", "PHONE", "RRN", "ACCOUNT"];
  if (rawValues.some((value) => observation.maskedText.includes(value))) {
    throw new Error("OCR observation exposed a direct identifier");
  }
  if (tokenKinds.some((kind) => !observation.maskedText.includes(`[${kind}_`))) {
    throw new Error("OCR observation did not produce every expected token kind");
  }
  if (!/지\s*급\s*명\s*령/u.test(observation.maskedText)) {
    throw new Error("OCR redaction removed adjacent non-sensitive content");
  }
  if (browser.masks.length !== tokenKinds.length) {
    throw new Error(
      `Expected ${tokenKinds.length} precise masks, received ${browser.masks.length}`,
    );
  }
  let capture: string | undefined;
  if (evidenceDirectory !== undefined) {
    await mkdir(evidenceDirectory, { recursive: true });
    capture = join(evidenceDirectory, "ocr-identifiers-masked.png");
    await writeFile(capture, observation.imagePng);
  }
  process.stdout.write(
    `${JSON.stringify({
      scenario: "ocr-only-precise-redaction",
      status: "PASS",
      tokenKinds,
      maskCount: browser.masks.length,
      preservedSafeText: true,
      imageBytes: observation.imagePng.byteLength,
      capture,
    })}\n`,
  );
} finally {
  await computer.close();
  server.stop(true);
}
