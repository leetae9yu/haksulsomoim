import { resolve } from "node:path";
import type { Page } from "playwright";

export type DesktopQaScenario = "happy" | "malformed" | "agent-happy" | "agent-approval";
export type QaAction = Readonly<{ action: string; observed: string }>;

export async function runAgentScenario(
  page: Page,
  scenario: Extract<DesktopQaScenario, `agent-${string}`>,
  actions: QaAction[],
  evidenceDirectory: string,
): Promise<void> {
  const workspace = page.getByTestId("agent-workspace");
  await workspace.waitFor();
  await page.locator('[data-agent-provider="authenticated"]').waitFor();
  await page.getByLabel("민사 회수").click();
  await page.getByLabel(/마스킹된 사건 컨텍스트 전송을 승인/).click();
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

  if (scenario === "agent-happy") {
    const completed = page.locator('[data-agent-status="completed"]').waitFor();
    await start.click();
    await completed;
    const tools = await page
      .locator("[data-agent-step][data-agent-tool]")
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-agent-tool")));
    const distinctTools = [...new Set(tools.filter((tool): tool is string => tool !== null))];
    if (distinctTools.length < 2) throw new Error("Agent completed without two distinct tools");
    await page.locator(".agent-final-plan [data-agent-citation]").first().waitFor();
    actions.push({
      action: "complete autonomous run",
      observed: `${distinctTools.join(" -> ")} completed with a cited final plan`,
    });
  } else {
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
  await page.screenshot({
    path: resolve(evidenceDirectory, `${scenario}.png`),
    fullPage: true,
  });
}
