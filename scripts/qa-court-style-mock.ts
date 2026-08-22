import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  ScreenMaskRegion,
  SecureBrowserInspection,
} from "../servers/contracts/secure-computer";
import { createLocalKorEngOcr } from "../servers/secure-computer/local-ocr";
import {
  intersectMaskRegion,
  PlaywrightSecureBrowser,
} from "../servers/secure-computer/playwright-browser";
import { Redactor } from "../servers/secure-computer/redaction";
import { SecureComputerService } from "../servers/secure-computer/secure-computer-service";

const fixtureDirectory = "fixtures/court-style-mock";
const evidenceDirectory = process.env.QA_EVIDENCE_DIR;
const executablePath = process.env.HAKSUL_BROWSER_EXECUTABLE ?? "/usr/bin/chromium-browser";
const rawValues = [
  "홍길동",
  "900101-1234567",
  "서울특별시 강남구 테헤란로 123",
  "010-1234-5678",
  "hong.qa@example.com",
  "김철수",
  "123-456-789012",
  "경기도 성남시 분당구 판교로 45",
  "010-9876-5432",
  "2026차전12345",
];
const expectedTokenKinds = ["PERSON", "RRN", "ADDRESS", "PHONE", "EMAIL", "ACCOUNT", "CASE"];
await access(executablePath);

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
  async fetch(request) {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/styles.css") {
      return new Response(Bun.file(join(fixtureDirectory, "styles.css")), {
        headers: { "content-type": "text/css; charset=utf-8" },
      });
    }
    if (pathname === "/" || pathname === "/index.html") {
      return new Response(Bun.file(join(fixtureDirectory, "index.html")), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    return new Response("Not found", { status: 404 });
  },
});

const saveCapture = async (name: string, image: Uint8Array): Promise<string | undefined> => {
  if (evidenceDirectory === undefined) return undefined;
  await mkdir(evidenceDirectory, { recursive: true });
  const path = join(evidenceDirectory, name);
  await writeFile(path, image);
  return path;
};

const assertMasked = (
  inspection: SecureBrowserInspection,
  maskedText: string,
  masks: readonly ScreenMaskRegion[],
): number => {
  const leaked = rawValues.filter((value) => maskedText.includes(value));
  if (leaked.length > 0) throw new Error(`Mock observation leaked ${leaked.join(", ")}`);
  const missingKinds = expectedTokenKinds.filter((kind) => !maskedText.includes(`[${kind}_`));
  if (missingKinds.length > 0) {
    throw new Error(`Mock observation missed token kinds ${missingKinds.join(", ")}`);
  }
  if (!maskedText.includes("5,380,000원") || !maskedText.includes("연락 두절")) {
    throw new Error("Mock observation removed adjacent non-sensitive legal text");
  }
  if (!inspection.url.startsWith(`http://127.0.0.1:${server.port}`)) {
    throw new Error("Mock browser left the allowed local origin");
  }
  if (masks.length !== 17) throw new Error(`Expected 17 masks, received ${masks.length}`);
  const visible = masks.flatMap((mask) => {
    const region = intersectMaskRegion(mask, inspection);
    return region === undefined ? [] : [region];
  });
  if (
    visible.some(({ boundingBox }) =>
      [boundingBox.x, boundingBox.y, boundingBox.width, boundingBox.height].some(
        (value) => !Number.isFinite(value) || value <= 0,
      ),
    )
  ) {
    throw new Error("Mock observation produced invalid visible mask geometry");
  }
  return visible.length;
};

const findVisibleTarget = (
  inspection: SecureBrowserInspection,
  text: string,
): SecureBrowserInspection["candidates"][number] => {
  const target = inspection.candidates.find(
    (candidate) =>
      candidate.text.trim() === text &&
      candidate.boundingBox.y >= 0 &&
      candidate.boundingBox.y + candidate.boundingBox.height <= inspection.height,
  );
  if (target === undefined) throw new Error(`Visible ${text} target was not found`);
  return target;
};

const targetCenter = (
  target: SecureBrowserInspection["candidates"][number],
): Readonly<{ x: number; y: number }> => ({
  x: Math.round(target.boundingBox.x + target.boundingBox.width / 2),
  y: Math.round(target.boundingBox.y + target.boundingBox.height / 2),
});

interface ViewportRun {
  readonly captures: readonly string[];
  readonly maskCounts: readonly number[];
  readonly visibleMaskCounts: readonly number[];
}

const runDesktop = async (): Promise<
  ViewportRun & Readonly<{ finalSubmit: string; login: string; restored: boolean }>
> => {
  const browser = new RecordingBrowser({
    ocr: await createLocalKorEngOcr(),
    allowedHosts: ["127.0.0.1"],
    executablePath,
    headless: true,
    viewport: { width: 1440, height: 900 },
  });
  const computer = new SecureComputerService({
    browser,
    caseId: "court-style-mock-desktop",
    redactor: new Redactor(new Uint8Array(32).fill(0x61)),
    allowedHosts: ["127.0.0.1"],
    maxActions: 8,
  });
  const captures: string[] = [];
  const maskCounts: number[] = [];
  const visibleMaskCounts: number[] = [];
  try {
    await computer.start(`http://127.0.0.1:${server.port}`);
    const initial = await computer.observe();
    const initialInspection = await browser.inspect();
    visibleMaskCounts.push(assertMasked(initialInspection, initial.maskedText, browser.masks));
    maskCounts.push(browser.masks.length);
    const initialPath = await saveCapture("mock-desktop-initial-masked.png", initial.imagePng);
    if (initialPath !== undefined) captures.push(initialPath);

    const loginTarget = findVisibleTarget(initialInspection, "로그인");
    const login = await computer.act({
      kind: "click",
      ...targetCenter(loginTarget),
      observationDigest: initial.observationDigest,
    });
    if (login.outcome !== "requires-user") throw new Error("Mock login did not require takeover");

    const midScroll = await computer.act({
      kind: "scroll",
      deltaX: 0,
      deltaY: 650,
      observationDigest: initial.observationDigest,
    });
    if (midScroll.outcome !== "executed") throw new Error("Mock mid scroll failed");
    const mid = await computer.observe();
    const midInspection = await browser.inspect();
    visibleMaskCounts.push(assertMasked(midInspection, mid.maskedText, browser.masks));
    maskCounts.push(browser.masks.length);
    const midPath = await saveCapture("mock-desktop-form-masked.png", mid.imagePng);
    if (midPath !== undefined) captures.push(midPath);

    const bottomScroll = await computer.act({
      kind: "scroll",
      deltaX: 0,
      deltaY: 2_000,
      observationDigest: mid.observationDigest,
    });
    if (bottomScroll.outcome !== "executed") throw new Error("Mock bottom scroll failed");
    const handoff = await computer.observe();
    const handoffInspection = await browser.inspect();
    visibleMaskCounts.push(assertMasked(handoffInspection, handoff.maskedText, browser.masks));
    maskCounts.push(browser.masks.length);
    const handoffPath = await saveCapture("mock-desktop-handoff-masked.png", handoff.imagePng);
    if (handoffPath !== undefined) captures.push(handoffPath);

    const finalTarget = findVisibleTarget(handoffInspection, "최종");
    const finalSubmit = await computer.act({
      kind: "click",
      ...targetCenter(finalTarget),
      observationDigest: handoff.observationDigest,
    });
    if (finalSubmit.outcome !== "requires-user") {
      throw new Error("Mock final submission did not require takeover");
    }

    const topScroll = await computer.act({
      kind: "scroll",
      deltaX: 0,
      deltaY: -3_000,
      observationDigest: handoff.observationDigest,
    });
    if (topScroll.outcome !== "executed") throw new Error("Mock top restoration failed");
    const restored = await computer.observe();
    const restoredInspection = await browser.inspect();
    visibleMaskCounts.push(assertMasked(restoredInspection, restored.maskedText, browser.masks));
    maskCounts.push(browser.masks.length);
    const restoredPath = await saveCapture("mock-desktop-restored-masked.png", restored.imagePng);
    if (restoredPath !== undefined) captures.push(restoredPath);

    return {
      captures,
      maskCounts,
      visibleMaskCounts,
      login: login.outcome,
      finalSubmit: finalSubmit.outcome,
      restored:
        initial.imagePng.byteLength === restored.imagePng.byteLength &&
        initial.observationDigest === restored.observationDigest,
    };
  } finally {
    await computer.close();
  }
};

const runMobile = async (): Promise<ViewportRun> => {
  const browser = new RecordingBrowser({
    ocr: await createLocalKorEngOcr(),
    allowedHosts: ["127.0.0.1"],
    executablePath,
    headless: true,
    viewport: { width: 390, height: 844 },
  });
  const computer = new SecureComputerService({
    browser,
    caseId: "court-style-mock-mobile",
    redactor: new Redactor(new Uint8Array(32).fill(0x62)),
    allowedHosts: ["127.0.0.1"],
    maxActions: 3,
  });
  const captures: string[] = [];
  const maskCounts: number[] = [];
  const visibleMaskCounts: number[] = [];
  try {
    await computer.start(`http://127.0.0.1:${server.port}`);
    const initial = await computer.observe();
    const initialInspection = await browser.inspect();
    visibleMaskCounts.push(assertMasked(initialInspection, initial.maskedText, browser.masks));
    maskCounts.push(browser.masks.length);
    const initialPath = await saveCapture("mock-mobile-initial-masked.png", initial.imagePng);
    if (initialPath !== undefined) captures.push(initialPath);

    const scroll = await computer.act({
      kind: "scroll",
      deltaX: 0,
      deltaY: 700,
      observationDigest: initial.observationDigest,
    });
    if (scroll.outcome !== "executed") throw new Error("Mock mobile form scroll failed");
    const form = await computer.observe();
    const formInspection = await browser.inspect();
    visibleMaskCounts.push(assertMasked(formInspection, form.maskedText, browser.masks));
    maskCounts.push(browser.masks.length);
    const formPath = await saveCapture("mock-mobile-form-masked.png", form.imagePng);
    if (formPath !== undefined) captures.push(formPath);
    return { captures, maskCounts, visibleMaskCounts };
  } finally {
    await computer.close();
  }
};

try {
  const desktop = await runDesktop();
  const mobile = await runMobile();
  process.stdout.write(
    `${JSON.stringify({
      scenario: "court-style-mock",
      status: "PASS",
      desktop,
      mobile,
      rawIdentifierCount: rawValues.length,
    })}\n`,
  );
} finally {
  server.stop(true);
}
