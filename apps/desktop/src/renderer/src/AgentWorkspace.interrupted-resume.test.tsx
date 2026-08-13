import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AgentRunEvent, AgentRunProjection } from "../../contracts/desktop-api";
import { agentRunProjectionSchema } from "../../contracts/desktop-api";
import { AgentWorkspace } from "./AgentWorkspace";
import {
  activeProjection,
  contextDigest,
  installWorkspaceApi,
} from "./agent-workspace-test-fixtures";

const interrupted = agentRunProjectionSchema.parse({
  ...activeProjection(),
  revision: 5,
  state: { kind: "interrupted", interruption: { kind: "application-restarted" } },
});
const resumed = agentRunProjectionSchema.parse({
  ...activeProjection(),
  revision: 6,
  state: { kind: "active" },
});

async function loadInterrupted() {
  const user = userEvent.setup();
  await waitFor(() =>
    expect(screen.getByTestId("agent-workspace").dataset.agentStatus).toBe("interrupted"),
  );
  await user.click(screen.getByLabelText(/마스킹된 사건 컨텍스트 전송을 승인/));
  await waitFor(() => expect(screen.getByTitle(contextDigest)).toBeTruthy());
  return user;
}

afterEach(cleanup);

describe("restart-interrupted Agent workspace", () => {
  test("accepts a correlated explicit resume response exactly once", async () => {
    let resolveResume!: (value: AgentRunProjection) => void;
    const pending = new Promise<AgentRunProjection>((resolve) => {
      resolveResume = resolve;
    });
    const resumeAgentRun = mock(async () => pending);
    installWorkspaceApi({
      listAgentRuns: mock(async () => [interrupted]),
      resumeAgentRun,
    });
    render(<AgentWorkspace caseId="case-1" officialCitationCount={1} />);
    const user = await loadInterrupted();
    const resume = screen.getByRole("button", { name: "명시적으로 재개" });

    await user.click(resume);
    expect(resume).toHaveProperty("disabled", true);
    await user.click(resume);
    expect(resumeAgentRun).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveResume(resumed);
      await pending;
    });
    expect(screen.getByTestId("agent-workspace").dataset.agentStatus).toBe("running");
  });

  test("does not revive from an unsolicited active or paused event", async () => {
    let publish: ((event: AgentRunEvent) => void) | undefined;
    installWorkspaceApi({
      listAgentRuns: mock(async () => [interrupted]),
      subscribeAgentRun: mock((_request, listener) => {
        publish = listener;
        return () => undefined;
      }),
    });
    render(<AgentWorkspace caseId="case-1" officialCitationCount={1} />);
    await loadInterrupted();
    await waitFor(() => expect(publish).toBeFunction());

    await act(async () => {
      publish?.({ caseId: interrupted.caseId, runId: interrupted.runId, projection: resumed });
      publish?.({
        caseId: interrupted.caseId,
        runId: interrupted.runId,
        projection: agentRunProjectionSchema.parse({
          ...resumed,
          revision: 7,
          state: { kind: "paused", reason: "user-paused" },
        }),
      });
    });
    expect(screen.getByTestId("agent-workspace").dataset.agentStatus).toBe("interrupted");
  });

  test("rejects a late resume response after cancellation", async () => {
    let publish: ((event: AgentRunEvent) => void) | undefined;
    let resolveResume!: (value: AgentRunProjection) => void;
    const pending = new Promise<AgentRunProjection>((resolve) => {
      resolveResume = resolve;
    });
    installWorkspaceApi({
      listAgentRuns: mock(async () => [interrupted]),
      resumeAgentRun: mock(async () => pending),
      subscribeAgentRun: mock((_request, listener) => {
        publish = listener;
        return () => undefined;
      }),
    });
    render(<AgentWorkspace caseId="case-1" officialCitationCount={1} />);
    const user = await loadInterrupted();
    await waitFor(() => expect(publish).toBeFunction());
    await user.click(screen.getByRole("button", { name: "명시적으로 재개" }));
    const cancelled = agentRunProjectionSchema.parse({
      ...interrupted,
      revision: 7,
      state: { kind: "interrupted", interruption: { kind: "user-cancelled" } },
    });

    await act(async () => {
      publish?.({
        caseId: interrupted.caseId,
        runId: interrupted.runId,
        projection: cancelled,
      });
      resolveResume(resumed);
      await pending;
    });
    expect(screen.getByTestId("agent-workspace").dataset.agentStatus).toBe("cancelled");
  });

  test("rejects a late resume response after the case changes", async () => {
    let resolveResume!: (value: AgentRunProjection) => void;
    const pending = new Promise<AgentRunProjection>((resolve) => {
      resolveResume = resolve;
    });
    installWorkspaceApi({
      listAgentRuns: mock(async ({ caseId }) => (caseId === "case-1" ? [interrupted] : [])),
      resumeAgentRun: mock(async () => pending),
    });
    const { rerender } = render(<AgentWorkspace caseId="case-1" officialCitationCount={1} />);
    const user = await loadInterrupted();
    await user.click(screen.getByRole("button", { name: "명시적으로 재개" }));
    rerender(<AgentWorkspace caseId="case-2" officialCitationCount={1} />);

    await act(async () => {
      resolveResume(resumed);
      await pending;
    });
    expect(screen.getByTestId("agent-workspace").dataset.caseId).toBe("case-2");
    expect(screen.getByTestId("agent-workspace").dataset.agentStatus).toBe("idle");
  });
});
