import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "../../../../apps/desktop/node_modules/playwright/index.mjs";
import type { DesktopApi } from "../../../../apps/desktop/src/contracts/desktop-api";

const execFileAsync = promisify(execFile);
const evidence = dirname(fileURLToPath(import.meta.url));
const root = resolve(evidence, "../../../../apps/desktop");
const userData = await mkdtemp(resolve(tmpdir(), "haksulsomoim-interrupted-resume-"));
const ocrPrefix = "haksulsomoim-ocr-";
const ocrBefore = new Set((await readdir(tmpdir())).filter((name) => name.startsWith(ocrPrefix)));
const actions: Array<{ action: string; observed: string }> = [];
let application: ElectronApplication | undefined;
let firstCrashObserved = false;
let secondClosed = false;
let failure: unknown;

async function launch(afterRestart: boolean) {
  return electron.launch({
    args: [
      `--user-data-dir=${userData}`,
      `--qa-user-data-root=${userData}`,
      "--qa-scenario=agent-live-controls",
      "--qa-crash-restart",
      ...(afterRestart ? ["--qa-after-restart"] : []),
      "out/main/qa.js",
    ],
    cwd: root,
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

async function createReadyCase(page: Page) {
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
  await page.getByLabel("민사 회수").click();
  await page.getByLabel(/마스킹된 사건 컨텍스트 전송을 승인/).click();
  const start = page.getByTestId("agent-start");
  await start.waitFor();
  await start.click();
  await page.locator('[data-agent-tool="inspect-masked-case"]').waitFor();
  await page.locator('[data-agent-step]:has-text("다음 판단 준비")').nth(1).waitFor();
  const workspace = page.getByTestId("agent-workspace");
  const authority = await page.evaluate(async () => {
    const api = (window as Window & { haksul: DesktopApi }).haksul;
    const caseId = document.querySelector<HTMLElement>("[data-testid=agent-workspace]")?.dataset
      .caseId;
    if (caseId === undefined || api.listAgentRuns === undefined) throw new Error("No active case");
    const runs = await api.listAgentRuns({ caseId });
    const run = runs.at(-1);
    const digest = document.querySelector<HTMLElement>(".agent-consent-panel code")?.title;
    if (run === undefined || digest === undefined || digest.length === 0) {
      throw new Error("No active Agent authority");
    }
    return { caseId, runId: run.runId, contextDigest: digest };
  });
  const clipping = await workspace.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  if (clipping.clientWidth !== 478 || clipping.scrollWidth > clipping.clientWidth) {
    throw new Error(`Unexpected Agent width ${clipping.clientWidth}/${clipping.scrollWidth}`);
  }
  await page.screenshot({ path: resolve(evidence, "agent-live-controls-restart.png"), fullPage: true });
  actions.push({
    action: "checkpoint before crash",
    observed: "478px production workspace committed inspect-masked-case once and entered decision 2",
  });
  return authority;
}

try {
  await mkdir(evidence, { recursive: true });
  console.log("phase: build");
  await execFileAsync(resolve(root, "node_modules/.bin/electron-vite"), [
    "build",
    "--mode",
    "qa",
    "--entry",
    "src/main/qa.ts",
  ], { cwd: root });
  console.log("phase: first launch");
  application = await launch(false);
  const firstPage = await application.firstWindow();
  console.log("phase: first case");
  const authority = await createReadyCase(firstPage);
  console.log("phase: crash");
  const firstClosed = new Promise<void>((resolveClose) => application?.once("close", resolveClose));
  application.process().kill("SIGKILL");
  await firstClosed;
  firstCrashObserved = true;
  actions.push({ action: "crash full Electron runtime", observed: "main process exited without disposal" });

  console.log("phase: second launch");
  application = await launch(true);
  const secondPage = await application.firstWindow();
  await secondPage.getByRole("heading", { name: /놓치기 쉬운 절차/ }).waitFor();
  console.log("phase: resume");
  const proof = await secondPage.evaluate(async (binding) => {
    const api = (window as Window & { haksul: DesktopApi }).haksul;
    if (
      api.listAgentRuns === undefined ||
      api.resumeAgentRun === undefined ||
      api.subscribeAgentRun === undefined
    ) throw new Error("Agent lifecycle bridge unavailable");
    const recovered = (await api.listAgentRuns({ caseId: binding.caseId })).at(-1);
    if (
      recovered?.runId !== binding.runId ||
      recovered.state.kind !== "interrupted" ||
      recovered.state.interruption.kind !== "application-restarted"
    ) throw new Error("Run was not recovered as application-restarted");
    return new Promise<{
      initialState: string;
      states: string[];
      tools: string[];
    }>((resolveProof, rejectProof) => {
      const states: string[] = [];
      const timer = window.setTimeout(() => rejectProof(new Error("Resume completion timeout")), 20_000);
      const unsubscribe = api.subscribeAgentRun?.(binding, (event) => {
        states.push(event.projection.state.kind);
        if (event.projection.state.kind !== "terminal") return;
        window.clearTimeout(timer);
        unsubscribe?.();
        resolveProof({
          initialState: "active",
          states,
          tools: event.projection.steps
            .filter((step) => step.kind === "tool-finished" && step.outcome === "completed")
            .map((step) => step.toolName),
        });
      });
      void api.resumeAgentRun?.(binding).then((initial) => {
        if (initial.state.kind !== "active") rejectProof(new Error("Resume was not active"));
      }, rejectProof);
    });
  }, authority);
  const expected = ["inspect-masked-case", "search-official-law", "write-local-draft"];
  if (proof.initialState !== "active" || !proof.states.includes("terminal")) {
    throw new Error("Restart resume did not reach active and terminal states");
  }
  for (const tool of expected) {
    if (proof.tools.filter((candidate) => candidate === tool).length !== 1) {
      throw new Error(`Tool execution was not exactly once: ${tool}`);
    }
  }
  actions.push({
    action: "explicitly resume recovered run",
    observed: `${proof.states.join(" -> ")}; each committed tool executed exactly once`,
  });
} catch (error) {
  failure = error;
} finally {
  if (application !== undefined) {
    const process = application.process();
    if (process.exitCode === null && process.signalCode === null) await application.close();
    secondClosed = true;
  }
  await rm(userData, { recursive: true, force: true });
  const userDataRemoved = await access(userData).then(() => false, () => true);
  const ocrAfter = (await readdir(tmpdir())).filter(
    (name) => name.startsWith(ocrPrefix) && !ocrBefore.has(name),
  );
  const receipt = {
    scenario: "agent-live-controls-interrupted-resume",
    status: failure === undefined ? "PASS" : "FAIL",
    route: "Electron crash -> encrypted runtime recovery -> production preload IPC -> runtime",
    actions,
    cleanup: { firstCrashObserved, secondClosed, userDataRemoved, ocrTempArtifacts: ocrAfter },
    error: failure instanceof Error ? failure.message : undefined,
  };
  await writeFile(resolve(evidence, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`, {
    mode: 0o600,
  });
  await writeFile(resolve(evidence, "actions.json"), `${JSON.stringify(actions, null, 2)}\n`, {
    mode: 0o600,
  });
  console.log(JSON.stringify(receipt));
}

if (failure !== undefined) throw failure;
