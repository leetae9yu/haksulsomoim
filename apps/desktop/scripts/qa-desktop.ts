import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { _electron as electron, type Page } from "playwright";

const execFileAsync = promisify(execFile);
type Scenario = "happy" | "malformed";
type Action = Readonly<{ action: string; observed: string }>;

function option(arguments_: readonly string[], name: string): string | undefined {
  const index = arguments_.indexOf(name);
  return index >= 0 ? arguments_[index + 1] : undefined;
}

function requireScenario(arguments_: readonly string[]): Scenario {
  const scenario = option(arguments_, "--scenario");
  if (scenario !== "happy" && scenario !== "malformed") {
    throw new TypeError("--scenario must be happy or malformed");
  }
  return scenario;
}

async function pngFixture(page: Page, scenario: Scenario): Promise<Buffer> {
  const dataUrl = await page.evaluate((selectedScenario) => {
    const canvas = document.createElement("canvas");
    canvas.width = 1200;
    canvas.height = 520;
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("Canvas 2D context is unavailable");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    if (selectedScenario === "happy") {
      context.fillStyle = "#111111";
      context.font = "700 58px Arial, sans-serif";
      context.fillText("BANK TRANSFER RECEIPT", 72, 110);
      context.font = "700 86px Arial, sans-serif";
      context.fillText("5,380,000 KRW", 72, 245);
    }
    return canvas.toDataURL("image/png");
  }, scenario);
  const png = Buffer.from(dataUrl.split(",", 2)[1] ?? "", "base64");
  return scenario === "happy" ? Buffer.concat([png, Buffer.from("HAKSUL_QA_FIXTURE_HAPPY")]) : png;
}

async function clickOrdered(page: Page, labels: readonly string[], actions: Action[]) {
  for (const label of labels) {
    await page.getByRole("button", { name: label }).click();
    actions.push({ action: label, observed: "control accepted in required order" });
  }
}

async function pathIsAbsent(path: string): Promise<boolean> {
  try {
    await access(path);
    return false;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return true;
    throw error;
  }
}

const arguments_ = process.argv.slice(2);
const scenario = requireScenario(arguments_);
const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const evidenceDirectory = resolve(
  option(arguments_, "--evidence-dir") ?? resolve(desktopRoot, "qa-artifacts"),
);
await mkdir(evidenceDirectory, { recursive: true });
await execFileAsync(
  resolve(desktopRoot, "node_modules/.bin/electron-vite"),
  ["build", "--mode", "qa", "--entry", "src/main/qa.ts"],
  { cwd: desktopRoot },
);

const ocrPrefix = "haksulsomoim-ocr-";
const ocrBefore = new Set((await readdir(tmpdir())).filter((name) => name.startsWith(ocrPrefix)));
const userData = await mkdtemp(resolve(tmpdir(), `haksulsomoim-${scenario}-`));
const actions: Action[] = [];
let application: Awaited<ReturnType<typeof electron.launch>> | undefined;
let page: Page | undefined;
let failure: unknown;
let electronClosed = false;

try {
  application = await electron.launch({
    args: [`--user-data-dir=${userData}`, `--qa-user-data-root=${userData}`, "out/main/qa.js"],
    cwd: desktopRoot,
  });
  page = await application.firstWindow();
  await page.getByRole("heading", { name: /놓치기 쉬운 절차/ }).waitFor();
  actions.push({ action: "launch", observed: "real Electron QA-only entry rendered" });

  await page.getByLabel("피해금액").fill("5380000");
  await page.getByRole("button", { name: "사건 시작" }).click();
  await page.getByText("₩5,380,000").waitFor();
  actions.push({ action: "create case", observed: "₩5,380,000 accepted" });

  await page.locator("#evidence-file").setInputFiles({
    name: scenario === "happy" ? "transfer-receipt.png" : "blank.png",
    mimeType: "image/png",
    buffer: await pngFixture(page, scenario),
  });
  actions.push({ action: "upload screenshot", observed: `${scenario} PNG crossed secure IPC` });

  if (scenario === "happy") {
    await page.getByText(/로컬 OCR 후보/).waitFor();
    await page.getByRole("button", { name: "추출 내용 확인" }).click();
    await page
      .getByTestId("citation-230af24aa64ea4819039b5a7664367ba865262a9324d8636f427f4c3f21681bf")
      .waitFor();
    actions.push({
      action: "confirm OCR and guidance",
      observed: "manual confirmation boundary and www.law.go.kr citation rendered",
    });
    await clickOrdered(page, ["고소장 준비 시작", "고소장 제출 완료를 직접 확인"], actions);
    await clickOrdered(
      page,
      [
        "지급명령 신청 완료를 직접 확인",
        "송달 완료를 직접 확인",
        "판결·결정문 수령을 직접 확인",
        "집행권원 확보로 표시",
      ],
      actions,
    );
    for (const label of ["재산조회", "압류·추심", "채무불이행자명부"]) {
      await page.getByText(label, { exact: true }).waitFor();
    }
    actions.push({
      action: "inspect enforcement",
      observed: "three conditional enforcement choices and official citation rendered",
    });
  } else {
    await page.getByText("캡처에서 문자를 읽지 못했습니다.").waitFor();
    const manualButton = page.getByRole("button", { name: "수동 내용 확인" });
    if (!(await manualButton.isDisabled())) throw new Error("Empty manual gate was enabled");
    if ((await page.getByRole("heading", { name: "형사 절차" }).count()) !== 0) {
      throw new Error("Malformed evidence bypassed manual confirmation");
    }
    actions.push({
      action: "inspect malformed boundary",
      observed: "unreadable evidence requested manual confirmation with no procedure tracks",
    });
    await page.screenshot({
      path: resolve(evidenceDirectory, "desktop-malformed.png"),
      fullPage: true,
    });
    await page.getByLabel("직접 확인한 캡처 내용").fill("사용자가 직접 확인한 송금 내역");
    await manualButton.click();
    await page.getByRole("heading", { name: "형사 절차" }).waitFor();
    actions.push({
      action: "complete malformed manual gate",
      observed: "empty input blocked progression; explicit manual confirmation unlocked tracks",
    });
    await page.screenshot({
      path: resolve(evidenceDirectory, "desktop-malformed-after-manual.png"),
      fullPage: true,
    });
  }

  if (scenario === "happy") {
    await page.screenshot({
      path: resolve(evidenceDirectory, "desktop-happy.png"),
      fullPage: true,
    });
  }
} catch (error) {
  failure = error;
  if (page !== undefined) {
    await page.screenshot({
      path: resolve(evidenceDirectory, `desktop-${scenario}-failure.png`),
      fullPage: true,
    });
  }
} finally {
  if (application !== undefined) {
    const closeObserved = new Promise<void>((resolveClose) =>
      application?.once("close", resolveClose),
    );
    await application.close();
    await closeObserved;
    electronClosed = true;
  }
  const ocrAfter = (await readdir(tmpdir())).filter(
    (name) => name.startsWith(ocrPrefix) && !ocrBefore.has(name),
  );
  await rm(userData, { recursive: true, force: true });
  const qaUserDataRemoved = await pathIsAbsent(userData);
  if (ocrAfter.length > 0 && failure === undefined) {
    failure = new Error(`OCR temp artifacts remain: ${ocrAfter.join(", ")}`);
  }
  if (!qaUserDataRemoved && failure === undefined) failure = new Error("QA root removal failed");
  const receipt = {
    scenario,
    status: failure === undefined ? "PASS" : "FAIL",
    actions,
    cleanup: { electronClosed, qaUserDataRemoved, ocrTempArtifacts: ocrAfter },
    externalResources: { portsUsed: [], testServersUsed: [] },
  };
  await writeFile(
    resolve(evidenceDirectory, `desktop-${scenario}-actions.json`),
    `${JSON.stringify(receipt, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  console.log(JSON.stringify(receipt));
}

if (failure !== undefined) throw failure;
