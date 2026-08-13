import { resolve } from "node:path";
import { type ElectronApplication, _electron as electron, type Page } from "playwright";
import type { DesktopApi } from "../src/contracts/desktop-api";
import type { QaAction } from "./qa-desktop-agent.ts";

type ResumeInput = Readonly<{
  desktopRoot: string;
  evidenceDirectory: string;
  userData: string;
  actions: QaAction[];
}>;
type Binding = Readonly<{ caseId: string; runId: string; contextDigest: string }>;

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

async function launch(input: ResumeInput, afterRestart: boolean): Promise<ElectronApplication> {
  return electron.launch({
    args: [
      `--user-data-dir=${input.userData}`,
      `--qa-user-data-root=${input.userData}`,
      "--qa-scenario=agent-resume",
      "--qa-crash-restart",
      ...(afterRestart ? ["--qa-after-restart"] : []),
      "out/main/qa.js",
    ],
    cwd: input.desktopRoot,
  });
}

async function readyCase(page: Page, input: ResumeInput): Promise<Binding> {
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
  await start.click();
  await page.locator('[data-agent-tool="inspect-masked-case"]').waitFor();
  await page.locator('[data-agent-step]:has-text("다음 판단 준비")').nth(1).waitFor();
  const binding = await page.evaluate(async () => {
    const api = (window as Window & { haksul: DesktopApi }).haksul;
    const caseId = document.querySelector<HTMLElement>("[data-testid=agent-workspace]")?.dataset
      .caseId;
    const contextDigest = document.querySelector<HTMLElement>(".agent-consent-panel code")?.title;
    if (caseId === undefined || contextDigest === undefined || api.listAgentRuns === undefined) {
      throw new Error("Agent production lifecycle is unavailable");
    }
    const run = (await api.listAgentRuns({ caseId })).at(-1);
    if (run === undefined || run.state.kind !== "active")
      throw new Error("Agent run is not active");
    return { caseId, runId: run.runId, contextDigest };
  });
  const width = await page.getByTestId("agent-workspace").evaluate((node) => ({
    clientWidth: node.clientWidth,
    scrollWidth: node.scrollWidth,
  }));
  if (width.clientWidth !== 478 || width.scrollWidth > width.clientWidth) {
    throw new Error(`Korean workspace width is ${width.clientWidth}/${width.scrollWidth}`);
  }
  await page.screenshot({
    path: resolve(input.evidenceDirectory, "agent-resume-before-crash.png"),
    fullPage: true,
  });
  input.actions.push({
    action: "create case, evidence, and initial Agent checkpoint",
    observed: "inspection completed once before the provider's second decision",
  });
  return binding;
}

async function explicitResume(page: Page, binding: Binding): Promise<readonly string[]> {
  return page.evaluate(async (request) => {
    const api = (window as Window & { haksul: DesktopApi }).haksul;
    if (
      api.listAgentRuns === undefined ||
      api.resumeAgentRun === undefined ||
      api.subscribeAgentRun === undefined
    ) {
      throw new Error("Production Agent resume bridge is unavailable");
    }
    const recovered = (await api.listAgentRuns({ caseId: request.caseId })).at(-1);
    if (
      recovered?.runId !== request.runId ||
      recovered.state.kind !== "interrupted" ||
      recovered.state.interruption.kind !== "application-restarted"
    ) {
      throw new Error("Crash recovery did not require an application-restarted resume");
    }
    return await new Promise<readonly string[]>((resolveTools, reject) => {
      const deadline = window.setTimeout(
        () => reject(new Error("Agent resume did not complete before its bounded deadline")),
        20_000,
      );
      const unsubscribe = api.subscribeAgentRun?.(request, (event) => {
        if (event.projection.state.kind !== "terminal") return;
        window.clearTimeout(deadline);
        unsubscribe?.();
        resolveTools(
          event.projection.steps.flatMap((step) =>
            step.kind === "tool-finished" && step.outcome === "completed" ? [step.toolName] : [],
          ),
        );
      });
      void api.resumeAgentRun?.(request).then((run) => {
        if (run.state.kind !== "active")
          reject(new Error("Explicit resume did not enter active state"));
      }, reject);
    });
  }, binding);
}

export async function runAgentResumeScenario(input: ResumeInput): Promise<void> {
  let first = await launch(input, false);
  try {
    const binding = await readyCase(await first.firstWindow(), input);
    const closed = new Promise<void>((resolveClose) => first.once("close", resolveClose));
    first.process().kill("SIGKILL");
    await closed;
    input.actions.push({
      action: "crash Electron",
      observed: "first runtime exited without graceful disposal",
    });
    first = await launch(input, true);
    const page = await first.firstWindow();
    const tools = await explicitResume(page, binding);
    const expected = [
      "inspect-masked-case",
      "search-official-law",
      "search-official-law",
      "write-local-draft",
    ];
    if (JSON.stringify(tools) !== JSON.stringify(expected)) {
      throw new Error(`Crash resume duplicated or lost a tool result: ${JSON.stringify(tools)}`);
    }
    await page.screenshot({
      path: resolve(input.evidenceDirectory, "agent-resume.png"),
      fullPage: true,
    });
    input.actions.push({
      action: "subscribe then explicitly resume",
      observed: "recovered encrypted run completed with each persisted tool result exactly once",
    });
  } finally {
    const process = first.process();
    if (process.exitCode === null && process.signalCode === null) await first.close();
  }
}
