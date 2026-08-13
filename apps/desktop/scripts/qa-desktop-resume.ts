import { resolve } from "node:path";
import { type ElectronApplication, _electron as electron, type Page } from "playwright";
import type { QaAction } from "./qa-desktop-agent.ts";

type ResumeInput = Readonly<{
  desktopRoot: string;
  evidenceDirectory: string;
  userData: string;
  actions: QaAction[];
}>;

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

async function readyCase(page: Page, input: ResumeInput): Promise<void> {
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
  await page.getByTestId("agent-start").click();
  await page.locator('[data-agent-tool="inspect-masked-case"]').waitFor();
  await page.locator('[data-agent-step]:has-text("다음 판단 준비")').nth(1).waitFor();
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
    observed: "visible workspace rendered inspection once before the deferred decision",
  });
}

async function resumeThroughRenderer(page: Page): Promise<void> {
  const workspace = page.getByTestId("agent-workspace");
  await workspace.waitFor();
  await page.locator('[data-agent-status="interrupted"]').waitFor();
  await page.getByText("실행 중단 기록").waitFor();
  if ((await page.locator('[data-agent-tool="inspect-masked-case"]').count()) !== 1) {
    throw new Error("Recovered checkpoint did not contain exactly one inspection result");
  }
  await page.getByLabel(/마스킹된 사건 컨텍스트 전송을 승인/).click();
  const completed = page.locator('[data-agent-status="completed"]').waitFor();
  await page.getByRole("button", { name: "명시적으로 재개" }).click();
  await completed;

  const expected = new Map([
    ["inspect-masked-case", 1],
    ["search-official-law", 2],
    ["write-local-draft", 1],
  ]);
  for (const [tool, count] of expected) {
    const actual = await page.locator(`[data-agent-tool="${tool}"]`).count();
    if (actual !== count) throw new Error(`${tool} completed ${actual} times instead of ${count}`);
  }
  await page.locator("[data-agent-citation]").first().waitFor();
  const artifact = page.getByRole("button", { name: "암호화 초안 열기" });
  await artifact.waitFor();
  const opened = page.locator("[data-agent-artifact-view]").waitFor();
  await artifact.click();
  await opened;
  const width = await workspace.evaluate((node) => ({
    clientWidth: node.clientWidth,
    scrollWidth: node.scrollWidth,
  }));
  if (width.clientWidth !== 478 || width.scrollWidth > width.clientWidth) {
    throw new Error(`Recovered workspace width is ${width.clientWidth}/${width.scrollWidth}`);
  }
}

export async function runAgentResumeScenario(input: ResumeInput): Promise<void> {
  let first = await launch(input, false);
  try {
    await readyCase(await first.firstWindow(), input);
    const closed = new Promise<void>((resolveClose) => first.once("close", resolveClose));
    first.process().kill("SIGKILL");
    await closed;
    input.actions.push({
      action: "crash Electron",
      observed: "first runtime exited without graceful disposal",
    });
    first = await launch(input, true);
    const page = await first.firstWindow();
    await resumeThroughRenderer(page);
    await page.screenshot({
      path: resolve(input.evidenceDirectory, "agent-resume.png"),
      fullPage: true,
    });
    input.actions.push({
      action: "resume with the visible production control",
      observed:
        "renderer recovered the checkpoint and completed with each tool result exactly once",
    });
  } finally {
    const process = first.process();
    if (process.exitCode === null && process.signalCode === null) await first.close();
  }
}
