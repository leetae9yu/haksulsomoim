import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";

import { createLocalKorEngOcr } from "../src/ocr/tesseract-recognizer";
import type { SecureComputerObservation } from "../src/secure-computer/contracts";
import { naverCase538Fixture } from "../src/secure-computer/naver-case-538-fixture";
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

const portalHtml = `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<title>5.38m 합성 사건 E2E</title><style>
body{margin:0;background:#e9eef5;color:#172033;font:15px sans-serif}main{position:relative;width:1000px;height:820px;margin:30px auto;padding:36px;box-sizing:border-box;border-radius:20px;background:white}h1{margin:0 0 8px}.summary{color:#465066}.grid{display:grid;grid-template-columns:1fr 1fr;gap:7px 30px;margin-top:22px}.pii{margin-top:18px;color:#334}.phone{position:absolute;left:36px;top:365px;width:420px;height:44px;font-size:17px}.states{position:absolute;left:36px;top:435px;display:grid;grid-template-columns:1fr 1fr;gap:7px 35px;width:900px}.controls button{position:absolute;top:565px;height:48px;border:0;border-radius:10px;padding:0 18px;background:#0066cc;color:white;font-weight:700}.controls .civil{left:36px}.controls .criminal{left:196px}.controls .judgment{left:356px}.controls .service{left:516px}.controls .finality{left:676px}.controls .registry{left:36px;top:635px;background:#236445}.controls .submit{left:236px;top:635px;background:#b42318}.footer{position:absolute;left:36px;top:715px}
</style></head><body><main><h1>5,380,000원 계좌이체 사기 합성 사건</h1>
<div class="summary">개인 과정 기록을 토대로 검증된 절차 난관만 재구성한 기능 QA</div>
<div class="grid"><div>피해금액: 5,380,000원</div><div>소장 송달: 2023-06-09</div>
<div>무변론판결: 법원 재량</div><div>6개월 기준: 확정 집행권원</div>
<div>형사 형량 인과: 미검증</div><div>명부 등재는 회수가 아님</div></div>
<div class="pii">성명: 홍길동 · 주민번호: 900101-1234567 · 계좌: 123-456-789012<br>
이메일: hong@example.com · 사건번호: 2026가단12345 · 주소: 서울특별시 중구 세종대로 110</div>
<input class="phone" name="phone" aria-label="연락처" value="010-1234-5678">
<section class="states"><div class="civil-state">민사: 미준비</div><div class="criminal-state">형사: 미준비</div>
<div class="judgment-state">판결: 미기록</div><div class="service-state">판결문 송달: 대기</div>
<div class="finality-state">확정: 미확정</div><div class="registry-state">채무불이행자명부: 미등재</div>
<div class="recovery-state">실제 회수: 미회수 (0원)</div><div class="filing-count">실제 소장 제출: 0회</div></section>
<div class="controls"><button class="civil">민사 준비</button><button class="criminal">형사 준비</button>
<button class="judgment">판결 기록</button><button class="service">송달 기록</button>
<button class="finality">확정 기록</button><button class="registry">명부 등재 기록</button>
<button class="submit">소장 최종 제출</button></div><div class="footer">로그인·서약·제출·결제는 사용자 직접 수행</div>
</main><script>
const set=(selector,text)=>{document.querySelector(selector).textContent=text};
document.querySelector('.civil').onclick=()=>set('.civil-state','민사: 소장 준비 완료');
document.querySelector('.criminal').onclick=()=>set('.criminal-state','형사: 고소장 준비 완료');
document.querySelector('.judgment').onclick=()=>set('.judgment-state','판결: 선고 기록');
document.querySelector('.service').onclick=()=>set('.service-state','판결문 송달: 완료');
document.querySelector('.finality').onclick=()=>set('.finality-state','확정: 완료');
document.querySelector('.registry').onclick=()=>set('.registry-state','채무불이행자명부: 등재');
document.querySelector('.submit').onclick=()=>set('.filing-count','실제 소장 제출: 1회');
</script></body></html>`;

const evidenceFlag = process.argv.find((value) => value.startsWith("--evidence-dir="));
const evidenceDirectory = resolve(
  evidenceFlag?.slice("--evidence-dir=".length) ?? ".omo/evidence/secure-computer/naver-case-538",
);
await mkdir(evidenceDirectory, { recursive: true });

const server = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(portalHtml);
});
await new Promise<void>((resolveListen, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolveListen);
});
const address = server.address();
if (address === null || typeof address === "string") throw new Error("Case portal did not bind");

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
  caseId: naverCase538Fixture.scenarioId,
  redactor: new Redactor(new Uint8Array(32).fill(53)),
  allowedHosts: ["127.0.0.1"],
  maxActions: 12,
});

const actionLog: unknown[] = [];
const expectedInitial = ["5,380,000원", "2023-06-09", "법원 재량", "확정 집행권원", "미검증"];
const assertMasked = (observation: SecureComputerObservation): void => {
  if (rawValues.some((value) => observation.maskedText.includes(value))) {
    throw new Error("Raw identifier crossed the case observation boundary");
  }
};
let observation: SecureComputerObservation;
const click = async (name: string, x: number, y: number, expected: string): Promise<void> => {
  const result = await computer.act({
    kind: "click",
    x,
    y,
    observationDigest: observation.observationDigest,
  });
  actionLog.push({ action: name, result });
  if (result.outcome !== "executed") throw new Error(`${name} was not executed`);
  observation = await computer.observe();
  assertMasked(observation);
  if (!observation.maskedText.includes(expected)) throw new Error(`${name} state was not observed`);
};

try {
  await computer.start(`http://127.0.0.1:${address.port}/`);
  observation = await computer.observe();
  assertMasked(observation);
  if (expectedInitial.some((value) => !observation.maskedText.includes(value))) {
    throw new Error("Verified case acceptance fact is missing");
  }
  await writeFile(resolve(evidenceDirectory, "naver-case-initial.png"), observation.imagePng);

  const phoneToken = observation.maskedText.match(/\[PHONE_[A-Z2-7]{16}\]/)?.[0];
  if (phoneToken === undefined) throw new Error("Phone token was not produced");
  const typed = await computer.act({
    kind: "type-token",
    x: 466,
    y: 417,
    token: phoneToken,
    observationDigest: observation.observationDigest,
  });
  actionLog.push({ action: "type-local-token", result: typed });
  if (typed.outcome !== "executed") throw new Error("Local token typing failed");
  observation = await computer.observe();

  await click("civil-preparation", 326, 619, "민사: 소장 준비 완료");
  await click("criminal-preparation", 490, 619, "형사: 고소장 준비 완료");
  await click("judgment-recorded", 650, 619, "판결: 선고 기록");
  await writeFile(resolve(evidenceDirectory, "naver-case-judgment.png"), observation.imagePng);
  if (
    !observation.maskedText.includes("판결문 송달: 대기") ||
    !observation.maskedText.includes("확정: 미확정")
  ) {
    throw new Error("Judgment, service, and finality collapsed into one state");
  }
  await click("judgment-served", 810, 619, "판결문 송달: 완료");
  await click("judgment-final", 970, 619, "확정: 완료");
  await click("debtor-registry-entered", 340, 689, "채무불이행자명부: 등재");
  if (!observation.maskedText.includes("실제 회수: 미회수 (0원)")) {
    throw new Error("Registry entry was incorrectly treated as collection");
  }

  const blocked = await computer.act({
    kind: "click",
    x: 545,
    y: 689,
    observationDigest: observation.observationDigest,
  });
  actionLog.push({ action: "final-filing", result: blocked });
  if (blocked.outcome !== "requires-user") throw new Error("Final filing was not blocked");
  observation = await computer.observe();
  if (!observation.maskedText.includes("실제 소장 제출: 0회")) {
    throw new Error("Blocked filing mutated the portal");
  }
  await writeFile(resolve(evidenceDirectory, "naver-case-final.png"), observation.imagePng);

  const imageAudit = await ocr.recognize(observation.imagePng);
  const auditedText =
    imageAudit.status === "readable"
      ? imageAudit.candidates.map((item) => item.text).join(" ")
      : "";
  if (containsDirectIdentifier(auditedText))
    throw new Error("Final PNG contains a direct identifier");
  const serializedActions = JSON.stringify(actionLog, null, 2);
  if (rawValues.some((value) => serializedActions.includes(value)))
    throw new Error("Action log leaked PII");
  await writeFile(resolve(evidenceDirectory, "naver-case-actions.json"), serializedActions);

  const receipt = {
    scenario: naverCase538Fixture.scenarioId,
    status: "passed",
    amountKrw: naverCase538Fixture.amountKrw,
    complaintServiceDate: naverCase538Fixture.civil.complaintServiceDate,
    civilCriminalSeparated: true,
    judgmentServiceFinalitySeparated: true,
    registryMeansCollection: false,
    collectedKrw: 0,
    safeActionsExecuted: 7,
    finalFilingBlocked: true,
    rawMatchCount: rawValues.filter((value) => auditedText.includes(value)).length,
    finalScreenshotSha256: createHash("sha256").update(observation.imagePng).digest("hex"),
  };
  await writeFile(
    resolve(evidenceDirectory, "naver-case-receipt.json"),
    JSON.stringify(receipt, null, 2),
  );
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
} finally {
  await computer.close().catch(() => undefined);
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  await writeFile(
    resolve(evidenceDirectory, "naver-case-cleanup.json"),
    JSON.stringify({ browser: "closed", mockPortal: "closed" }, null, 2),
  );
}
