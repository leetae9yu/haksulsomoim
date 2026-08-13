import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  type AgentRunProjection,
  type AgentRunStartIpcRequest,
  agentRunProjectionSchema,
} from "../../contracts/desktop-api";
import { AgentWorkspace } from "./AgentWorkspace";
import {
  activeProjection,
  approvalProjection,
  completedProjection,
  contextDigest,
  installWorkspaceApi,
} from "./agent-workspace-test-fixtures";

afterEach(cleanup);

async function ready() {
  await waitFor(() =>
    expect(screen.getByTestId("agent-workspace").dataset.agentProvider).toBe("authenticated"),
  );
}

async function selectGoalAndConsent(
  user: ReturnType<typeof userEvent.setup>,
  goal: "민사 회수" | "형사 고소 준비" = "민사 회수",
) {
  await user.click(screen.getByLabelText(goal));
  await user.click(screen.getByLabelText(/마스킹된 사건 컨텍스트 전송을 승인/));
}

function workspace(caseId = "case-1") {
  return <AgentWorkspace caseId={caseId} contextDigest={contextDigest} officialCitationCount={1} />;
}

describe("Korean Agent workspace", () => {
  test("requires consent, starts a civil goal, and renders real ordered tools with linked citations", async () => {
    const { api, startAgentRun } = installWorkspaceApi();
    const user = userEvent.setup();
    render(workspace());
    await ready();

    expect(screen.getByTestId("agent-start")).toHaveProperty("disabled", true);
    expect(screen.getByTestId("agent-civil-track")).toBeTruthy();
    expect(screen.getByTestId("agent-criminal-track")).toBeTruthy();
    await selectGoalAndConsent(user);
    await user.click(screen.getByTestId("agent-start"));

    expect(startAgentRun).toHaveBeenCalledWith({
      caseId: "case-1",
      contextDigest,
      goal: {
        kind: "civil-recovery",
        caseId: "case-1",
        objective: "prepare-civil-demand",
      },
    });
    await waitFor(() =>
      expect(screen.getByTestId("agent-workspace").dataset.agentStatus).toBe("completed"),
    );
    const tools = [...document.querySelectorAll("[data-agent-tool]")].map((node) =>
      node.getAttribute("data-agent-tool"),
    );
    expect(new Set(tools)).toEqual(new Set(["inspect-masked-case", "search-official-law"]));
    expect(document.querySelectorAll("[data-agent-step]").length).toBeGreaterThanOrEqual(2);
    await user.click(screen.getByRole("link", { name: "민사집행법 공식 원문 열기" }));
    expect(api.openOfficialSource).toHaveBeenCalledWith({
      url: "https://law.go.kr/법령/민사집행법",
    });
    expect(screen.getByTestId("agent-announcement").textContent).toContain("완료");
  });

  test("keeps criminal goals separate and supports native keyboard operation", async () => {
    const startAgentRun = mock(async (request: AgentRunStartIpcRequest) =>
      completedProjection(request.caseId, request.goal),
    );
    installWorkspaceApi({ startAgentRun });
    const user = userEvent.setup();
    render(workspace());
    await ready();

    const criminal = screen.getByLabelText("형사 고소 준비");
    criminal.focus();
    await user.keyboard("[Space]");
    const consent = screen.getByLabelText(/마스킹된 사건 컨텍스트 전송을 승인/);
    consent.focus();
    await user.keyboard("[Space]");
    const start = screen.getByTestId("agent-start");
    start.focus();
    await user.keyboard("[Enter]");

    expect(startAgentRun).toHaveBeenCalledWith(
      expect.objectContaining({
        goal: {
          kind: "criminal-complaint",
          caseId: "case-1",
          objective: "prepare-criminal-complaint",
        },
      }),
    );
  });

  test("denies and approves only the current pending consequential action", async () => {
    const startAgentRun = mock(async () => approvalProjection());
    const decideAgentApproval = mock(async (request) =>
      agentRunProjectionSchema.parse({
        ...activeProjection(request.caseId),
        lastStepId: "step-decided",
        steps: [
          ...activeProjection(request.caseId).steps,
          { kind: "approval-decided" as const, stepId: "step-decided", outcome: request.outcome },
        ],
      }),
    );
    installWorkspaceApi({ startAgentRun, decideAgentApproval });
    const user = userEvent.setup();
    const { rerender } = render(workspace());
    await ready();
    await selectGoalAndConsent(user);
    await user.click(screen.getByTestId("agent-start"));
    const approval = await screen.findByTestId("agent-approval");
    expect(document.activeElement).toBe(approval);
    await user.click(screen.getByRole("button", { name: "거부" }));

    rerender(
      <AgentWorkspace
        key="approve"
        caseId="case-1"
        contextDigest={contextDigest}
        officialCitationCount={1}
      />,
    );
    await ready();
    await selectGoalAndConsent(user);
    await user.click(screen.getByTestId("agent-start"));
    await user.click(await screen.findByRole("button", { name: "승인" }));
    expect(decideAgentApproval.mock.calls.map((call) => call[0]?.outcome)).toEqual([
      "denied",
      "approved",
    ]);
    expect(decideAgentApproval.mock.calls[0]?.[0]).toMatchObject({
      approvalId: "approval-1",
      approvalDigest: contextDigest,
    });
  });

  test("routes pause, explicit resume, and cancellation without executing tools", async () => {
    const startAgentRun = mock(async () => activeProjection());
    const controls = installWorkspaceApi({ startAgentRun });
    const user = userEvent.setup();
    render(workspace());
    await ready();
    await selectGoalAndConsent(user);
    await user.click(screen.getByTestId("agent-start"));

    await user.click(await screen.findByRole("button", { name: "일시정지" }));
    expect(controls.pauseAgentRun).toHaveBeenCalledTimes(1);
    await user.click(await screen.findByRole("button", { name: "명시적으로 재개" }));
    expect(controls.resumeAgentRun).toHaveBeenCalledTimes(1);
    await user.click(await screen.findByRole("button", { name: "실행 취소" }));
    expect(controls.cancelAgentRun).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(screen.getByTestId("agent-workspace").dataset.agentStatus).toBe("cancelled"),
    );
  });

  test("ignores a stale completed response after the active case changes", async () => {
    let resolveRun!: (run: AgentRunProjection) => void;
    const pending = new Promise<AgentRunProjection>((resolve) => {
      resolveRun = resolve;
    });
    installWorkspaceApi({ startAgentRun: mock(async () => pending) });
    const user = userEvent.setup();
    const { rerender } = render(workspace("case-1"));
    await ready();
    await selectGoalAndConsent(user);
    await user.click(screen.getByTestId("agent-start"));
    rerender(workspace("case-2"));
    await act(async () => {
      resolveRun(completedProjection("case-1"));
      await pending;
    });

    expect(screen.getByTestId("agent-workspace").dataset.caseId).toBe("case-2");
    expect(screen.queryByText("민사집행법 공식 원문 열기")).toBeNull();
    expect(document.querySelectorAll("[data-agent-step]")).toHaveLength(0);
  });

  test("announces a sanitized provider-manual state and keeps local goals visible", async () => {
    installWorkspaceApi({
      codexStatus: mock(async () => ({
        status: "offline" as const,
        mode: "manual" as const,
        reason: "REMOTE_SECRET",
      })),
    });
    render(workspace());
    await waitFor(() =>
      expect(screen.getByTestId("agent-workspace").dataset.agentStatus).toBe("manual"),
    );
    expect(screen.getByTestId("agent-workspace").textContent).toContain(
      "수동 절차는 계속 사용할 수 있습니다",
    );
    expect(screen.getByTestId("agent-workspace").textContent).not.toContain("REMOTE_SECRET");
    expect(screen.getByTestId("agent-civil-track")).toBeTruthy();
    expect(screen.getByTestId("agent-criminal-track")).toBeTruthy();
  });
});
