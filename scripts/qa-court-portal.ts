import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createLocalKorEngOcr } from "../servers/secure-computer/local-ocr";
import { PlaywrightSecureBrowser } from "../servers/secure-computer/playwright-browser";
import { containsDirectIdentifier, Redactor } from "../servers/secure-computer/redaction";
import { SecureComputerService } from "../servers/secure-computer/secure-computer-service";

const portalUrl = "https://ecfs.scourt.go.kr/psp/index.on?m=PSP004M01";
const executablePath = process.env.HAKSUL_BROWSER_EXECUTABLE ?? "/usr/bin/chromium-browser";
const evidenceDirectory = process.env.QA_EVIDENCE_DIR;
const captures: string[] = [];
const saveCapture = async (name: string, image: Uint8Array): Promise<void> => {
  if (evidenceDirectory === undefined) return;
  await mkdir(evidenceDirectory, { recursive: true });
  const path = join(evidenceDirectory, name);
  await writeFile(path, image);
  captures.push(path);
};
await access(executablePath);
const browser = new PlaywrightSecureBrowser({
  ocr: await createLocalKorEngOcr(),
  allowedHosts: ["ecfs.scourt.go.kr"],
  executablePath,
  headless: true,
  viewport: { width: 1440, height: 900 },
});
const computer = new SecureComputerService({
  browser,
  caseId: "live-court-readonly-qa",
  redactor: new Redactor(new Uint8Array(32).fill(0x45)),
  allowedHosts: ["ecfs.scourt.go.kr"],
  maxActions: 4,
});

try {
  await computer.start(portalUrl);
  const initial = await computer.observe();
  if (!initial.url.includes("/psp/index.on")) throw new Error("Unexpected portal URL");
  if (initial.imagePng.byteLength < 10_000)
    throw new Error("Portal screenshot is unexpectedly empty");
  if (initial.maskedText.length < 100) throw new Error("Portal text is unexpectedly empty");
  if (!/전자소송|법원/.test(initial.maskedText)) throw new Error("Portal label was not observed");
  if (containsDirectIdentifier(initial.maskedText)) {
    throw new Error("A direct identifier escaped the masked observation");
  }

  const scrollDown = await computer.act({
    kind: "scroll",
    deltaX: 0,
    deltaY: 400,
    observationDigest: initial.observationDigest,
  });
  if (scrollDown.outcome !== "executed") throw new Error("Portal scroll was not executed");
  await saveCapture("court-initial-masked.png", initial.imagePng);
  const scrolled = await computer.observe();
  await saveCapture("court-scrolled-masked.png", scrolled.imagePng);
  const scrollUp = await computer.act({
    kind: "scroll",
    deltaX: 0,
    deltaY: -400,
    observationDigest: scrolled.observationDigest,
  });
  if (scrollUp.outcome !== "executed") throw new Error("Portal return scroll was not executed");
  const restored = await computer.observe();
  await saveCapture("court-restored-masked.png", restored.imagePng);

  const inspection = await browser.inspect();
  const login = inspection.candidates.find(({ text }) => text.trim() === "로그인");
  if (login === undefined) throw new Error("Portal login target was not found");
  const loginHandoff = await computer.act({
    kind: "click",
    x: Math.round(login.boundingBox.x + login.boundingBox.width / 2),
    y: Math.round(login.boundingBox.y + login.boundingBox.height / 2),
    observationDigest: restored.observationDigest,
  });
  if (loginHandoff.outcome !== "requires-user") {
    throw new Error("Portal login did not require user takeover");
  }

  process.stdout.write(
    `${JSON.stringify({
      scenario: "live-court-portal",
      status: "PASS",
      url: restored.url,
      imageBytes: [
        initial.imagePng.byteLength,
        scrolled.imagePng.byteLength,
        restored.imagePng.byteLength,
      ],
      maskedTextLengths: [
        initial.maskedText.length,
        scrolled.maskedText.length,
        restored.maskedText.length,
      ],
      safeActions: [scrollDown.outcome, scrollUp.outcome],
      loginHandoff: loginHandoff.outcome,
      loginReason: loginHandoff.reason,
      captures,
    })}\n`,
  );
} finally {
  await computer.close();
}
