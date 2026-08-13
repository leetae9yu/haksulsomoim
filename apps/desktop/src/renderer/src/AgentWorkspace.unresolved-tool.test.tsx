import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentWorkspace } from "./AgentWorkspace";
import { installWorkspaceApi } from "./agent-workspace-test-fixtures";

const unresolvedToolLease = "AGENT_CASE_UNRESOLVED_TOOL_LEASE";

afterEach(cleanup);

describe("unresolved external-tool recovery", () => {
  test("renders a case-specific lock and fails closed on a visible recovery recheck", async () => {
    const listAgentRuns = mock(async () => {
      throw new Error(unresolvedToolLease);
    });
    const controls = installWorkspaceApi({ listAgentRuns });
    const user = userEvent.setup();
    render(<AgentWorkspace caseId="case-1" officialCitationCount={0} />);

    await waitFor(() =>
      expect(screen.getByTestId("agent-workspace").dataset.agentStatus).toBe("unresolved-tool"),
    );
    expect(screen.getByTestId("agent-workspace").dataset.agentProvider).toBe("authenticated");
    expect(screen.getByTestId("agent-start")).toHaveProperty("disabled", true);

    await user.click(screen.getByTestId("agent-recovery-recheck"));
    await waitFor(() => expect(screen.getByTestId("agent-recovery-denied")).toBeTruthy());
    expect(listAgentRuns).toHaveBeenCalledTimes(2);
    expect(controls.startAgentRun).not.toHaveBeenCalled();
    expect(controls.resumeAgentRun).not.toHaveBeenCalled();
  });
});
