import { resolve } from "node:path";
import type { Page } from "playwright";

export type DesktopQaScenario =
  | "happy"
  | "malformed"
  | "agent-happy"
  | "agent-approval"
  | "agent-live-controls";
export type QaAction = Readonly<{ action: string; observed: string }>;

async function approveContext(page: Page, actions: QaAction[]) {
  await page.getByLabel("민사 회수").focus();
  await page.keyboard.press("Space");
  await page.getByLabel(/마스킹된 사건 컨텍스트 전송을 승인/).focus();
  await page.keyboard.press("Space");
  const start = page.getByTestId("agent-start");
  await start.waitFor();
  await start.evaluate((button) => {
    if (!(button instanceof HTMLButtonElement) || button.disabled) {
      throw new Error("Agent start did not receive a masked-case digest");
    }
  });
  actions.push({
    action: "approve masked context",
    observed: "renderer opened the current case digest through production IPC",
  });
  return start;
}

async function runHappy(
  page: Page,
  actions: QaAction[],
  start: ReturnType<Page["getByTestId"]>,
  evidenceDirectory: string,
) {
  const completed = page.locator('[data-agent-status="completed"]').waitFor();
  await start.focus();
  await page.keyboard.press("Enter");
  await completed;
  const steps = page.locator("[data-agent-step][data-agent-tool]");
  const tools = await steps.evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute("data-agent-tool")),
  );
  const distinctTools = [...new Set(tools.filter((tool): tool is string => tool !== null))];
  for (const required of ["inspect-masked-case", "search-official-law", "write-local-draft"]) {
    if (!distinctTools.includes(required)) throw new Error(`Agent did not complete ${required}`);
  }
  const laws = page.locator('[data-agent-tool="search-official-law"][data-agent-depends-on]');
  if ((await laws.count()) !== 2) throw new Error("Agent did not complete two causal law searches");
  const firstSource = await laws.nth(0).getAttribute("data-agent-depends-on");
  const firstStep = await laws.nth(0).getAttribute("data-agent-step");
  const secondSource = await laws.nth(1).getAttribute("data-agent-depends-on");
  const secondStep = await laws.nth(1).getAttribute("data-agent-step");
  if (
    firstSource === null ||
    firstStep === null ||
    secondSource !== firstStep ||
    secondStep === null
  ) {
    throw new Error("Law searches do not form an exact persisted observation chain");
  }
  await page
    .locator(`[data-agent-step="${firstSource}"][data-agent-tool="inspect-masked-case"]`)
    .waitFor();
  actions.push({
    action: "prove observation-driven keyboard flow",
    observed:
      "native keyboard controls started the run; law search linked to the persisted inspection",
  });

  const agentCitations = page.locator(".agent-final-plan [data-agent-citation]");
  await agentCitations.nth(1).waitFor();
  const projected = await agentCitations.evaluateAll((nodes) =>
    nodes.map((node) => ({
      id: node.getAttribute("data-agent-citation"),
      step: node.getAttribute("data-agent-citation-step"),
    })),
  );
  const expectedCitations = [
    { id: "a".repeat(64), step: firstStep },
    { id: "b".repeat(64), step: secondStep },
  ];
  if (JSON.stringify(projected) !== JSON.stringify(expectedCitations)) {
    throw new Error("Agent citations are not linked to their exact law observations");
  }
  if (
    (await page
      .locator(
        '.agent-final-plan [data-agent-citation="230af24aa64ea4819039b5a7664367ba865262a9324d8636f427f4c3f21681bf"]',
      )
      .count()) !== 0
  ) {
    throw new Error("Manual guidance citation contaminated the Agent timeline");
  }
  const artifactButton = page.locator("[data-agent-artifact]").first();
  const artifactId = await artifactButton.getAttribute("data-agent-artifact");
  if (artifactId === null) throw new Error("Completed draft exposed no bounded artifact ID");
  await artifactButton.focus();
  await page.keyboard.press("Enter");
  const artifact = page.locator(`[data-agent-artifact-view="${artifactId}"]`);
  await artifact.waitFor();
  await artifact.locator("[data-agent-artifact-citation]").first().waitFor();
  const artifactCitationIds = await artifact
    .locator("[data-agent-artifact-citation]")
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-agent-artifact-citation")));
  if (JSON.stringify(artifactCitationIds) !== JSON.stringify(["b".repeat(64)])) {
    throw new Error("Encrypted artifact did not retain only its causal citation");
  }
  const artifactText = await artifact.innerText();
  if (artifactText.includes("file://") || artifactText.includes("/tmp/")) {
    throw new Error("App-owned artifact view exposed a filesystem path");
  }
  await page.screenshot({
    path: resolve(evidenceDirectory, "agent-happy-artifact.png"),
    fullPage: true,
  });
  actions.push({
    action: "open encrypted cited artifact",
    observed:
      "production IPC opened a bounded draft with only the second law observation citation; manual citation stayed separate",
  });

  const mutated = page.locator('[data-testid="civil-state"][data-state="payment-order-pending"]');
  const mutationVisible = mutated.waitFor();
  await page.getByRole("button", { name: "지급명령 신청 완료를 직접 확인" }).click();
  await mutationVisible;
  const staleRejected = page.locator(
    '[role="alert"]:has-text("암호화 초안을 안전하게 열 수 없습니다.")',
  );
  const rejectionVisible = staleRejected.waitFor();
  await artifactButton.click();
  await rejectionVisible;
  actions.push({
    action: "reject stale artifact open",
    observed:
      "a successful workflow mutation atomically invalidated the pre-mutation digest through production IPC",
  });
  actions.push({
    action: "complete autonomous run",
    observed: `${distinctTools.join(" -> ")} completed with a cited encrypted artifact`,
  });
}

async function runApproval(
  page: Page,
  actions: QaAction[],
  start: ReturnType<Page["getByTestId"]>,
  evidenceDirectory: string,
) {
  const awaitingApproval = page.locator('[data-agent-status="awaiting-approval"]').waitFor();
  await start.click();
  await awaitingApproval;
  const trackBoard = page.locator(".track-board");
  const workflowBefore = await trackBoard.innerText();
  await page.screenshot({
    path: resolve(evidenceDirectory, "agent-approval-pending.png"),
    fullPage: true,
  });
  const denied = page.getByText("사용자 거부 기록").waitFor();
  await page.getByRole("button", { name: "거부" }).click();
  await denied;
  if ((await trackBoard.innerText()) !== workflowBefore) {
    throw new Error("Approval denial mutated the manual workflow");
  }
  actions.push({
    action: "deny consequential action",
    observed: "denied timeline event recorded with zero manual workflow mutation",
  });
}

async function runLiveControls(
  page: Page,
  actions: QaAction[],
  start: ReturnType<Page["getByTestId"]>,
) {
  await start.click();
  await page.locator('[data-agent-status="running"]').waitFor();
  await page.locator('[data-agent-step]:has-text("다음 판단 준비")').first().waitFor();
  await page.getByRole("button", { name: "일시정지" }).click();
  await page.locator('[data-agent-status="paused"]').waitFor();
  await page.getByRole("button", { name: "명시적으로 재개" }).click();
  await page.locator('[data-agent-status="running"]').waitFor();
  await page.locator('[data-agent-step]:has-text("다음 판단 준비")').nth(1).waitFor();
  await page.getByRole("button", { name: "실행 취소" }).click();
  await page.locator('[data-agent-status="cancelled"]').waitFor();
  if ((await page.locator("[data-agent-step][data-agent-tool]").count()) !== 0) {
    throw new Error("Pause/cancel allowed a deferred provider tool to execute");
  }
  actions.push({
    action: "control initial live run",
    observed:
      "subscription rendered initial checkpoints; production pause/resume/cancel executed zero tools",
  });
}

export async function runAgentScenario(
  page: Page,
  scenario: Extract<DesktopQaScenario, `agent-${string}`>,
  actions: QaAction[],
  evidenceDirectory: string,
): Promise<void> {
  const workspace = page.getByTestId("agent-workspace");
  await workspace.waitFor();
  await page.locator('[data-agent-provider="authenticated"]').waitFor();
  const start = await approveContext(page, actions);
  if (scenario === "agent-happy") await runHappy(page, actions, start, evidenceDirectory);
  else if (scenario === "agent-approval") {
    await runApproval(page, actions, start, evidenceDirectory);
  } else await runLiveControls(page, actions, start);

  const clipping = await workspace.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  if (clipping.scrollWidth > clipping.clientWidth) {
    throw new Error("Agent workspace clips horizontally");
  }
  actions.push({
    action: "audit Korean workspace",
    observed: `${clipping.clientWidth}px panel has no horizontal clipping`,
  });
  await page.screenshot({ path: resolve(evidenceDirectory, `${scenario}.png`), fullPage: true });
}
