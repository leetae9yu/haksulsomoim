import { execFile } from "node:child_process";
import { watch } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { _electron as electron, type Page } from "playwright";

const execFileAsync = promisify(execFile);
const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const evidenceDirectory = resolve(process.argv[2] ?? resolve(desktopRoot, "qa-artifacts"));
await mkdir(evidenceDirectory, { recursive: true });
await execFileAsync(
  resolve(desktopRoot, "node_modules/.bin/electron-vite"),
  ["build", "--mode", "qa", "--entry", "src/main/qa.ts"],
  { cwd: desktopRoot },
);
const userData = await mkdtemp(resolve(tmpdir(), "haksulsomoim-unresolved-tool-"));
const unresolvedMarker = resolve(userData, "tool-entered");

type Authority = Readonly<{ caseId: string; contextDigest: string }>;

async function launch(afterRestart: boolean) {
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

async function pngFixture(page: Page): Promise<Buffer> {
  const dataUrl = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 1200;
    canvas.height = 520;
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("Canvas unavailable");
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#111";
    context.font = "700 86px Arial";
    context.fillText("5,380,000 KRW", 72, 245);
    return canvas.toDataURL("image/png");
  });
  return Buffer.concat([
    Buffer.from(dataUrl.split(",", 2)[1] ?? "", "base64"),
    Buffer.from("HAKSUL_QA_FIXTURE_HAPPY"),
  ]);
}

async function startUnresolvedTool(page: Page): Promise<Authority> {
  await page.getByRole("heading", { name: /놓치기 쉬운 절차/ }).waitFor();
  await page.getByLabel("피해금액").fill("5380000");
  await page.getByRole("button", { name: "사건 시작" }).click();
  await page.getByText("₩5,380,000").waitFor();
  await page.locator("#evidence-file").setInputFiles({
    name: "transfer-receipt.png",
    mimeType: "image/png",
    buffer: await pngFixture(page),
  });
  await page.getByText(/로컬 OCR 후보/).waitFor();
  await page.getByRole("button", { name: "추출 내용 확인" }).click();
  await page.locator('[data-testid^="citation-"]').waitFor();
  const authority = await page.evaluate(async () => {
    const caseId = localStorage.getItem("haksul.agent.active-case.v1");
    if (caseId === null) throw new Error("Missing case binding");
    const opened = await window.haksul.openAgentCase?.({ caseId });
    if (opened === undefined) throw new Error("Missing Agent open boundary");
    return { caseId, contextDigest: opened.contextDigest };
  });
  await page.getByLabel("민사 회수").click();
  await page.getByLabel(/마스킹된 사건 컨텍스트 전송을 승인/).click();
  await page.getByTestId("agent-start").click();
  await page.locator('[data-agent-tool="inspect-masked-case"]').waitFor();
  await page.locator('[data-agent-status="running"]').waitFor();
  return authority;
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

const first = await launch(false);
let second: Awaited<ReturnType<typeof launch>> | undefined;
let receipt: unknown;
try {
  const toolEntered = waitForToolEntry();
  const authority = await startUnresolvedTool(await first.firstWindow());
  await toolEntered;
  const firstClosed = new Promise<void>((resolveClose) => first.once("close", resolveClose));
  first.process().kill("SIGKILL");
  await firstClosed;
  second = await launch(true);
  const page = await second.firstWindow();
  await page.getByTestId("agent-workspace").waitFor();
  receipt = await page.evaluate(async ({ caseId, contextDigest }) => {
    let recoveryDenied = false;
    try {
      await window.haksul.listAgentRuns?.({ caseId });
    } catch {
      recoveryDenied = true;
    }
    let replacementDenied = false;
    try {
      await window.haksul.startAgentRun?.({
        caseId,
        contextDigest,
        goal: { kind: "civil-recovery", caseId, objective: "prepare-civil-demand" },
      });
    } catch {
      replacementDenied = true;
    }
    return { recoveryDenied, replacementDenied };
  }, authority);
  if (
    typeof receipt !== "object" ||
    receipt === null ||
    !("recoveryDenied" in receipt) ||
    receipt.recoveryDenied !== true ||
    !("replacementDenied" in receipt) ||
    receipt.replacementDenied !== true
  ) {
    throw new Error("Fresh Electron process did not retain unresolved-tool ownership");
  }
  await page.screenshot({
    path: resolve(evidenceDirectory, "unresolved-tool-relaunch.png"),
    fullPage: true,
  });
  await writeFile(
    resolve(evidenceDirectory, "unresolved-tool-relaunch-receipt.json"),
    `${JSON.stringify({ status: "PASS", ...receipt }, null, 2)}\n`,
    { mode: 0o600 },
  );
  console.log(JSON.stringify({ status: "PASS", ...receipt }));
} finally {
  const process = second?.process();
  if (second !== undefined && process?.exitCode === null && process.signalCode === null)
    await second.close();
  await rm(userData, { recursive: true, force: true });
}
