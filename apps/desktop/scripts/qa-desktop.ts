import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { _electron as electron, type Page } from "playwright";
import { type DesktopQaScenario, type QaAction, runAgentScenario } from "./qa-desktop-agent.ts";

const execFileAsync = promisify(execFile);

function option(arguments_: readonly string[], name: string): string | undefined {
  const index = arguments_.indexOf(name);
  return index >= 0 ? arguments_[index + 1] : undefined;
}

function requireScenario(arguments_: readonly string[]): DesktopQaScenario {
  const scenario = option(arguments_, "--scenario");
  if (
    scenario !== "happy" &&
    scenario !== "malformed" &&
    scenario !== "agent-happy" &&
    scenario !== "agent-approval"
  ) {
    throw new TypeError("--scenario is not supported");
  }
  return scenario;
}

async function pngFixture(page: Page, scenario: DesktopQaScenario): Promise<Buffer> {
  const dataUrl = await page.evaluate((malformed) => {
    const canvas = document.createElement("canvas");
    canvas.width = 1200;
    canvas.height = 520;
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("Canvas 2D context is unavailable");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    if (!malformed) {
      context.fillStyle = "#111111";
      context.font = "700 58px Arial, sans-serif";
      context.fillText("BANK TRANSFER RECEIPT", 72, 110);
      context.font = "700 86px Arial, sans-serif";
      context.fillText("5,380,000 KRW", 72, 245);
    }
    return canvas.toDataURL("image/png");
  }, scenario === "malformed");
  const png = Buffer.from(dataUrl.split(",", 2)[1] ?? "", "base64");
  return scenario === "malformed"
    ? png
    : Buffer.concat([png, Buffer.from("HAKSUL_QA_FIXTURE_HAPPY")]);
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

async function reachTracks(page: Page, scenario: DesktopQaScenario, actions: QaAction[]) {
  await page.getByLabel("피해금액").fill("5380000");
  await page.getByRole("button", { name: "사건 시작" }).click();
  await page.getByText("₩5,380,000").waitFor();
  await page.locator("#evidence-file").setInputFiles({
    name: scenario === "malformed" ? "blank.png" : "transfer-receipt.png",
    mimeType: "image/png",
    buffer: await pngFixture(page, scenario),
  });
  actions.push({ action: "create case and upload", observed: "real case and OCR IPC accepted" });
  if (scenario === "malformed") return;
  await page.getByText(/로컬 OCR 후보/).waitFor();
  await page.getByRole("button", { name: "추출 내용 확인" }).click();
  await page
    .getByTestId("citation-230af24aa64ea4819039b5a7664367ba865262a9324d8636f427f4c3f21681bf")
    .waitFor();
  actions.push({
    action: "confirm OCR and guidance",
    observed: "manual confirmation and official citation rendered",
  });
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
const actions: QaAction[] = [];
let application: Awaited<ReturnType<typeof electron.launch>> | undefined;
let page: Page | undefined;
let failure: unknown;
let electronClosed = false;

try {
  application = await electron.launch({
    args: [
      `--user-data-dir=${userData}`,
      `--qa-user-data-root=${userData}`,
      `--qa-scenario=${scenario}`,
      "out/main/qa.js",
    ],
    cwd: desktopRoot,
  });
  page = await application.firstWindow();
  await page.getByRole("heading", { name: /놓치기 쉬운 절차/ }).waitFor();
  actions.push({
    action: "launch",
    observed: "real Electron main, production preload, and renderer bundle rendered",
  });
  await reachTracks(page, scenario, actions);

  if (scenario === "agent-happy" || scenario === "agent-approval") {
    await runAgentScenario(page, scenario, actions, evidenceDirectory);
  } else if (scenario === "malformed") {
    await page.getByText("캡처에서 문자를 읽지 못했습니다.").waitFor();
    const manualButton = page.getByRole("button", { name: "수동 내용 확인" });
    if (!(await manualButton.isDisabled())) throw new Error("Empty manual gate was enabled");
    actions.push({ action: "inspect malformed boundary", observed: "manual gate remained closed" });
  } else {
    await page.screenshot({
      path: resolve(evidenceDirectory, "desktop-happy.png"),
      fullPage: true,
    });
  }
} catch (error) {
  failure = error;
  if (page !== undefined) {
    await page.screenshot({
      path: resolve(evidenceDirectory, `${scenario}-failure.png`),
      fullPage: true,
    });
  }
} finally {
  if (application !== undefined) {
    const closed = new Promise<void>((resolveClose) => application?.once("close", resolveClose));
    await application.close();
    await closed;
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
    route: "main -> IPC -> production preload -> renderer -> runtime",
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
