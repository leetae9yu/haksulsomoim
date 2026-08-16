import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";

import { createLocalKorEngOcr } from "../src/ocr/tesseract-recognizer";
import { PlaywrightSecureBrowser } from "../src/secure-computer/playwright-browser";
import { SecureComputerService } from "../src/secure-computer/secure-computer-service";
import { containsDirectIdentifier, Redactor } from "../src/security/redaction";

const rawValues = [
  "홍길동",
  "900101-1234567",
  "010-1234-5678",
  "123-456-789012",
  "hong@example.com",
  "2026가단12345",
  "서울특별시 중구 세종대로 110",
] as const;

const html = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><title>보안 전자소송 QA</title>
<style>
body{margin:0;background:#eef2f7;color:#172033;font:16px sans-serif}main{position:relative;width:900px;height:760px;margin:40px auto;background:white;border-radius:20px;padding:32px;box-sizing:border-box}
h1{margin:0 0 24px}.fact{margin:10px 0}.phone{position:absolute;left:32px;top:330px;width:430px;height:48px;font-size:18px}.next,.submit{position:absolute;top:420px;height:52px;border:0;border-radius:12px;padding:0 24px;font-weight:700}.next{left:32px;background:#0066cc;color:white}.submit{left:220px;background:#b42318;color:white}.status{position:absolute;left:32px;top:510px}.mutation{position:absolute;left:32px;top:550px}
</style></head><body><main>
<h1>전자소송 입력 화면</h1>
<div class="fact">성명: 홍길동</div><div class="fact">주민번호: 900101-1234567</div>
<div class="fact">계좌: 123-456-789012</div><div class="fact">이메일: hong@example.com</div>
<div class="fact">사건번호: 2026가단12345</div><div class="fact">주소: 서울특별시 중구 세종대로 110</div>
<input class="phone" name="phone" aria-label="연락처" value="010-1234-5678">
<button class="next" type="button">다음 단계</button><button class="submit" type="button">최종 제출 및 결제</button>
<div class="status">현재 단계: 사건 접수</div><div class="mutation">제출 횟수: 0</div>
</main><script>
document.querySelector('.next').addEventListener('click',()=>{document.querySelector('.status').textContent='현재 단계: 증빙 확인 단계'});
document.querySelector('.submit').addEventListener('click',()=>{document.querySelector('.mutation').textContent='제출 횟수: 1'});
</script></body></html>`;

const evidenceArgument = process.argv.find((argument) => argument.startsWith("--evidence-dir="));
const evidenceDirectory = resolve(
  evidenceArgument?.slice("--evidence-dir=".length) ?? ".omo/evidence/secure-computer",
);
await mkdir(evidenceDirectory, { recursive: true });

const server = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(html);
});
await new Promise<void>((resolveListen, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolveListen);
});
const address = server.address();
if (address === null || typeof address === "string") throw new Error("Mock portal did not bind");
const url = `http://127.0.0.1:${address.port}/`;

const ocr = await createLocalKorEngOcr();
const browser = new PlaywrightSecureBrowser({
  ocr,
  allowedHosts: ["127.0.0.1"],
  executablePath: process.env.HAKSUL_BROWSER_EXECUTABLE ?? "/usr/bin/chromium-browser",
  headless: true,
  viewport: { width: 1440, height: 900 },
});
const computer = new SecureComputerService({
  browser,
  caseId: "qa-secure-computer",
  redactor: new Redactor(new Uint8Array(32).fill(29)),
  allowedHosts: ["127.0.0.1"],
  maxActions: 8,
});

const actionLog: unknown[] = [];
let cleanup = "pending";
try {
  await computer.start(url);
  const initial = await computer.observe();
  await writeFile(resolve(evidenceDirectory, "secure-computer-initial.png"), initial.imagePng);
  if (rawValues.some((value) => initial.maskedText.includes(value))) {
    throw new Error("Raw identifier crossed the masked-text boundary");
  }
  const phoneToken = initial.maskedText.match(/\[PHONE_[A-Z2-7]{16}\]/)?.[0];
  if (phoneToken === undefined) throw new Error("Phone token was not produced");

  const typed = await computer.act({
    kind: "type-token",
    x: 517,
    y: 394,
    token: phoneToken,
    observationDigest: initial.observationDigest,
  });
  actionLog.push({ action: "type-token", result: typed });
  if (typed.outcome !== "executed") throw new Error("Token typing did not execute");

  const afterType = await computer.observe();
  const advanced = await computer.act({
    kind: "click",
    x: 370,
    y: 486,
    observationDigest: afterType.observationDigest,
  });
  actionLog.push({ action: "safe-click", result: advanced });
  if (advanced.outcome !== "executed") throw new Error("Safe navigation did not execute");

  const beforeSubmit = await computer.observe();
  await writeFile(
    resolve(evidenceDirectory, "secure-computer-safe-step.png"),
    beforeSubmit.imagePng,
  );
  if (!beforeSubmit.maskedText.includes("증빙 확인 단계")) {
    throw new Error("Safe action did not mutate the mock portal");
  }
  const blocked = await computer.act({
    kind: "click",
    x: 576,
    y: 486,
    observationDigest: beforeSubmit.observationDigest,
  });
  actionLog.push({ action: "final-submit", result: blocked });
  if (blocked.outcome !== "requires-user") throw new Error("Final submission was not blocked");

  const finalObservation = await computer.observe();
  await writeFile(
    resolve(evidenceDirectory, "secure-computer-blocked-submit.png"),
    finalObservation.imagePng,
  );
  if (!finalObservation.maskedText.includes("제출 횟수: 0")) {
    throw new Error("Blocked submission mutated the portal");
  }
  const audit = await ocr.recognize(finalObservation.imagePng);
  const auditedText =
    audit.status === "readable" ? audit.candidates.map((item) => item.text).join(" ") : "";
  if (containsDirectIdentifier(auditedText))
    throw new Error("Masked PNG still contains a direct identifier");

  const serializedActions = JSON.stringify(actionLog, null, 2);
  if (rawValues.some((value) => serializedActions.includes(value))) {
    throw new Error("Action log contains a raw identifier");
  }
  await writeFile(resolve(evidenceDirectory, "secure-computer-actions.json"), serializedActions);
  const receipt = {
    status: "passed",
    safeActionsExecuted: 2,
    blockedAction: "final-submit",
    blockedReason: blocked.reason,
    rawMatchCount: rawValues.filter((value) => auditedText.includes(value)).length,
    finalScreenshotSha256: createHash("sha256").update(finalObservation.imagePng).digest("hex"),
  };
  await writeFile(
    resolve(evidenceDirectory, "secure-computer-receipt.json"),
    JSON.stringify(receipt, null, 2),
  );
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
} finally {
  await computer.close().catch(() => undefined);
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  cleanup = "closed";
  await writeFile(
    resolve(evidenceDirectory, "secure-computer-cleanup.json"),
    JSON.stringify({ browser: cleanup, mockPortal: cleanup }, null, 2),
  );
}
