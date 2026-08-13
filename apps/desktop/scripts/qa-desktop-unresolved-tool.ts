import { execFile } from "node:child_process";
import { watch } from "node:fs";
import { access, chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { type ElectronApplication, _electron as electron, type Page } from "playwright";

const execFileAsync = promisify(execFile);
const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const evidenceDirectory = resolve(process.argv[2] ?? resolve(desktopRoot, "qa-artifacts"));
const ocrPrefix = "haksulsomoim-ocr-";
const fixturePng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6ZgAAAABJRU5ErkJggg==",
  "base64",
);

type QaAction = Readonly<{ action: string; observed: string }>;

await mkdir(evidenceDirectory, { recursive: true });
await execFileAsync(
  resolve(desktopRoot, "node_modules/.bin/electron-vite"),
  ["build", "--mode", "qa", "--entry", "src/main/qa.ts"],
  { cwd: desktopRoot },
);
const ocrBefore = new Set((await readdir(tmpdir())).filter((name) => name.startsWith(ocrPrefix)));
const userData = await mkdtemp(resolve(tmpdir(), "haksulsomoim-unresolved-tool-"));
const unresolvedMarker = resolve(userData, "tool-entered");
const actions: QaAction[] = [];
let first: ElectronApplication | undefined;
let second: ElectronApplication | undefined;
let page: Page | undefined;
let failure: unknown;
let firstClosed = false;
let secondClosed = false;
let proof: Record<string, unknown> = {};

function launch(afterRestart: boolean): Promise<ElectronApplication> {
  return electron.launch({
    args: [
      `--user-data-dir=${userData}`,
      `--qa-user-data-root=${userData}`,
      "--qa-scenario=agent-happy",
      "--qa-unresolved-tool",
      `--qa-unresolved-marker=${unresolvedMarker}`,
      ...(afterRestart ? ["--qa-after-restart"] : []),
      "out/main/qa.js",
    ],
    cwd: desktopRoot,
  });
}

function waitForToolEntry(): Promise<void> {
  return new Promise((resolveEntry, reject) => {
    const watcher = watch(userData, (_event, filename) => {
      if (filename?.toString() !== basename(unresolvedMarker)) return;
      clearTimeout(deadline);
      watcher.close();
      resolveEntry();
    });
    const deadline = setTimeout(() => {
      watcher.close();
      reject(new Error("Unresolved external tool did not enter before deadline"));
    }, 30_000);
  });
}

async function readyUnresolvedTool(currentPage: Page): Promise<void> {
  currentPage.setDefaultTimeout(30_000);
  await currentPage.getByRole("heading", { name: /놓치기 쉬운 절차/ }).waitFor();
  await currentPage.getByLabel("피해금액").fill("5380000");
  await currentPage.getByRole("button", { name: "사건 시작" }).click();
  await currentPage.getByText("₩5,380,000").waitFor();
  await currentPage.locator("#evidence-file").setInputFiles({
    name: "transfer-receipt.png",
    mimeType: "image/png",
    buffer: Buffer.concat([fixturePng, Buffer.from("HAKSUL_QA_FIXTURE_HAPPY")]),
  });
  await currentPage.getByText(/로컬 OCR 후보/).waitFor();
  await currentPage.getByRole("button", { name: "추출 내용 확인" }).click();
  await currentPage.locator('[data-testid^="citation-"]').waitFor();
  await currentPage.getByLabel("민사 회수").click();
  await currentPage.getByLabel(/마스킹된 사건 컨텍스트 전송을 승인/).click();
  const toolEntered = waitForToolEntry();
  const externalStarted = currentPage
    .locator("[data-agent-step]")
    .filter({ hasText: "공식 법령 검색 시작" })
    .waitFor();
  await currentPage.getByTestId("agent-start").click();
  await Promise.all([externalStarted, toolEntered]);
  if ((await currentPage.locator('[data-agent-tool="inspect-masked-case"]').count()) !== 1) {
    throw new Error("Inspection checkpoint was not committed exactly once before external entry");
  }
}

async function close(application: ElectronApplication | undefined): Promise<boolean> {
  if (application === undefined) return true;
  const process = application.process();
  if (process.exitCode !== null || process.signalCode !== null) return true;
  const closed = new Promise<void>((resolveClose) => application.once("close", resolveClose));
  await application.close();
  await closed;
  return true;
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

try {
  first = await launch(false);
  page = await first.firstWindow();
  await readyUnresolvedTool(page);
  actions.push({
    action: "launch and start Agent through visible case, evidence, consent, and start controls",
    observed:
      "production renderer displayed the Korean workspace and timeline while the QA adapter entered once",
  });
  const firstPid = first.process().pid;
  if (firstPid === undefined) throw new Error("First Electron process has no PID");
  const firstExit = new Promise<void>((resolveClose) => first?.once("close", resolveClose));
  first.process().kill("SIGKILL");
  await firstExit;
  firstClosed = true;
  actions.push({
    action: "hard-kill first Electron process",
    observed: "the process exited during the externally executing tool without graceful settlement",
  });

  second = await launch(true);
  const secondPid = second.process().pid;
  if (secondPid === undefined || secondPid === firstPid)
    throw new Error("Relaunch was not a new process");
  page = await second.firstWindow();
  page.setDefaultTimeout(30_000);
  await page.getByRole("heading", { name: "중단된 Agent 실행" }).waitFor();
  const workspace = page.locator('[data-agent-status="unresolved-tool"]');
  await workspace.waitFor();
  await page.locator('[data-agent-provider="authenticated"]').waitFor();
  await page
    .getByText(/이 사건의 Agent 실행이 안전하게 잠겨 있습니다/)
    .first()
    .waitFor();
  const blockedStart = page.getByRole("button", { name: "안전 잠금으로 새 실행 차단" });
  if (!(await blockedStart.isDisabled()))
    throw new Error("Same-case replacement control was enabled");
  actions.push({
    action: "relaunch the same encrypted user-data in a second Electron process",
    observed:
      "renderer announced the case-specific unresolved-tool safety lock and blocked a new run",
  });

  const denied = page.getByTestId("agent-recovery-denied").waitFor();
  await page.getByRole("button", { name: "중단된 실행 다시 확인" }).click();
  await denied;
  const entries = (await readFile(unresolvedMarker, "utf8")).trim().split(/\r?\n/u);
  if (
    entries.length !== 1 ||
    entries[0] !== String(firstPid) ||
    entries.includes(String(secondPid))
  ) {
    throw new Error(`Unexpected external tool entries: ${entries.join(",")}`);
  }
  actions.push({
    action: "use the visible recovery recheck",
    observed:
      "renderer showed a fail-closed denial; no second-process external tool entry occurred",
  });

  const dimensions = await workspace.evaluate((node) => ({
    clientWidth: node.clientWidth,
    scrollWidth: node.scrollWidth,
  }));
  if (dimensions.clientWidth !== 478 || dimensions.scrollWidth > dimensions.clientWidth) {
    throw new Error(
      `Recovered Korean Agent workspace width is ${dimensions.clientWidth}/${dimensions.scrollWidth}`,
    );
  }
  const screenshot = resolve(evidenceDirectory, "agent-unresolved-tool.png");
  await page.getByTestId("agent-recovery-boundary").screenshot({ path: screenshot });
  await chmod(screenshot, 0o600);
  proof = {
    firstPid,
    secondPid,
    crashSignal: "SIGKILL",
    sameEncryptedUserData: true,
    rendererStatus: "unresolved-tool",
    recoveryRecheckDenied: true,
    sameCaseNewRunBlocked: true,
    externalToolEntries: entries.length,
    duplicateExternalToolEntries: 0,
    externalOverlap: false,
    workspaceWidth: dimensions.clientWidth,
  };
} catch (error) {
  failure = error;
  if (page !== undefined) {
    await page
      .screenshot({
        path: resolve(evidenceDirectory, "agent-unresolved-tool-failure.png"),
        fullPage: true,
      })
      .catch(() => undefined);
  }
} finally {
  secondClosed = await close(second).catch(() => false);
  firstClosed = firstClosed || (await close(first).catch(() => false));
  const ocrAfter = (await readdir(tmpdir())).filter(
    (name) => name.startsWith(ocrPrefix) && !ocrBefore.has(name),
  );
  await rm(userData, { recursive: true, force: true });
  const cleanup = {
    electronClosed: firstClosed && secondClosed,
    qaUserDataRemoved: await pathIsAbsent(userData),
    ocrTempArtifacts: ocrAfter,
  };
  if (
    (!cleanup.electronClosed ||
      !cleanup.qaUserDataRemoved ||
      cleanup.ocrTempArtifacts.length > 0) &&
    failure === undefined
  ) {
    failure = new Error("Unresolved-tool QA cleanup did not complete");
  }
  const status = failure === undefined ? "PASS" : "FAIL";
  const receipt = {
    scenario: "agent-unresolved-tool",
    status,
    route: "main -> IPC -> production preload -> renderer -> runtime",
    actions,
    proof,
    cleanup,
    externalResources: { portsUsed: [], testServersUsed: [] },
  };
  await Promise.all([
    writeFile(
      resolve(evidenceDirectory, "desktop-agent-unresolved-tool-actions.json"),
      `${JSON.stringify({ scenario: "agent-unresolved-tool", actions }, null, 2)}\n`,
      { mode: 0o600 },
    ),
    writeFile(
      resolve(evidenceDirectory, "desktop-agent-unresolved-tool-receipt.json"),
      `${JSON.stringify(receipt, null, 2)}\n`,
      { mode: 0o600 },
    ),
    writeFile(
      resolve(evidenceDirectory, "desktop-agent-unresolved-tool-cleanup.json"),
      `${JSON.stringify(cleanup, null, 2)}\n`,
      { mode: 0o600 },
    ),
  ]);
  console.log(JSON.stringify(receipt));
}

if (failure !== undefined) throw failure;
