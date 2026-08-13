import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  type AgentRunEvent,
  type AgentRunProjection,
  agentRunProjectionSchema,
} from "../../contracts/desktop-api";
import { AgentWorkspace } from "./AgentWorkspace";
import {
  activeProjection,
  completedProjection,
  installWorkspaceApi,
} from "./agent-workspace-test-fixtures";

afterEach(cleanup);

describe("live Agent workspace projection", () => {
  test("keeps the terminal timeline when a stale active event arrives for the same run", async () => {
    let publish: ((event: AgentRunEvent) => void) | undefined;
    installWorkspaceApi({
      startAgentRun: mock(async () => activeProjection()),
      subscribeAgentRun: mock((_request, listener) => {
        publish = listener;
        return () => undefined;
      }),
    });
    const user = userEvent.setup();
    render(<AgentWorkspace caseId="case-1" officialCitationCount={1} />);
    await waitFor(() =>
      expect(screen.getByTestId("agent-workspace").dataset.agentProvider).toBe("authenticated"),
    );
    await user.click(screen.getByLabelText("민사 회수"));
    await user.click(screen.getByLabelText(/마스킹된 사건 컨텍스트 전송을 승인/));
    await waitFor(() =>
      expect(screen.getByTestId("agent-start")).toHaveProperty("disabled", false),
    );
    await user.click(screen.getByTestId("agent-start"));
    await waitFor(() => expect(publish).toBeFunction());

    const completed = { ...completedProjection(), revision: 2 };
    const stale = {
      ...completed,
      revision: 1,
      state: { kind: "active" as const },
    };
    await act(async () => {
      publish?.({ caseId: completed.caseId, runId: completed.runId, projection: completed });
      publish?.({ caseId: completed.caseId, runId: completed.runId, projection: stale });
    });

    expect(screen.getByTestId("agent-workspace").dataset.agentStatus).toBe("completed");
    expect(screen.getByRole("heading", { name: "인용된 최종 실행 계획" })).toBeTruthy();
  });

  test("rejects a late active resume response after a terminal subscription event", async () => {
    let publish: ((event: AgentRunEvent) => void) | undefined;
    let resolveResume!: (projection: AgentRunProjection) => void;
    const resume = new Promise<AgentRunProjection>((resolve) => {
      resolveResume = resolve;
    });
    const active = activeProjection();
    const paused = agentRunProjectionSchema.parse({
      ...active,
      revision: 1,
      state: { kind: "paused", reason: "user-paused" },
      lastStepId: "step-user-paused",
      steps: [
        ...active.steps,
        { kind: "interrupted", stepId: "step-user-paused", reason: "user-paused" },
      ],
    });
    installWorkspaceApi({
      startAgentRun: mock(async () => paused),
      resumeAgentRun: mock(async () => resume),
      subscribeAgentRun: mock((_request, listener) => {
        publish = listener;
        return () => undefined;
      }),
    });
    const user = userEvent.setup();
    render(<AgentWorkspace caseId="case-1" officialCitationCount={1} />);
    await waitFor(() =>
      expect(screen.getByTestId("agent-workspace").dataset.agentProvider).toBe("authenticated"),
    );
    await user.click(screen.getByLabelText("민사 회수"));
    await user.click(screen.getByLabelText(/마스킹된 사건 컨텍스트 전송을 승인/));
    await waitFor(() =>
      expect(screen.getByTestId("agent-start")).toHaveProperty("disabled", false),
    );
    await user.click(screen.getByTestId("agent-start"));
    await waitFor(() => expect(publish).toBeFunction());
    await user.click(screen.getByRole("button", { name: "명시적으로 재개" }));

    const terminal = completedProjection();
    const completed = agentRunProjectionSchema.parse({
      ...terminal,
      revision: 3,
      steps: [...paused.steps, ...terminal.steps.slice(2)],
    });
    const resumed = agentRunProjectionSchema.parse({
      ...paused,
      revision: 2,
      state: { kind: "active" },
    });
    await act(async () => {
      publish?.({ caseId: completed.caseId, runId: completed.runId, projection: completed });
      resolveResume(resumed);
      await resume;
    });

    expect(screen.getByTestId("agent-workspace").dataset.agentStatus).toBe("completed");
  });
});
