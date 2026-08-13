import type { AgentRun, AgentToolResult } from "./agent-contracts";
import {
  cancelAgentRun,
  pauseFailedProviderTurn,
  pauseIdleAgentRun,
} from "./agent-loop-boundary-reducer";
import { finishAgentTool } from "./agent-loop-reducer";
import {
  type AgentLoopControl,
  type AgentLoopRuntimeDependencies,
  commitControlRun,
  remainingDuration,
} from "./agent-loop-runtime";
import type { AgentToolExecution } from "./agent-tool-registry";

export async function finishAgentToolTurn(
  dependencies: AgentLoopRuntimeDependencies,
  control: AgentLoopControl,
  result: AgentToolResult,
  execution: AgentToolExecution,
): Promise<AgentRun> {
  return dependencies.mutations.run(control.caseId, async () => {
    const current = control.snapshot.run;
    if (current.state.kind !== "active") return current;
    const run = finishAgentTool(
      current,
      result,
      dependencies.identifiers.nextStepId(),
      dependencies.identifiers.nextStepId(),
      remainingDuration(dependencies, control, current),
      execution.status === "pending",
    );
    await commitControlRun(dependencies, control, run, true);
    return run;
  });
}

export async function pauseAgentRunWithoutTurn(
  dependencies: AgentLoopRuntimeDependencies,
  control: AgentLoopControl,
  reason: "provider-unavailable" | "context-changed",
): Promise<AgentRun> {
  return dependencies.mutations.run(control.caseId, async () => {
    const current = control.snapshot.run;
    if (current.state.kind !== "active") return current;
    const run = pauseIdleAgentRun(
      current,
      reason,
      remainingDuration(dependencies, control, current),
    );
    await commitControlRun(dependencies, control, run, true);
    return run;
  });
}

export async function pauseAgentProviderTurn(
  dependencies: AgentLoopRuntimeDependencies,
  control: AgentLoopControl,
): Promise<AgentRun> {
  return dependencies.mutations.run(control.caseId, async () => {
    const current = control.snapshot.run;
    if (current.state.kind !== "active") return current;
    const run = pauseFailedProviderTurn(
      current,
      dependencies.identifiers.nextStepId(),
      remainingDuration(dependencies, control, current),
    );
    await commitControlRun(dependencies, control, run, true);
    return run;
  });
}

export async function cancelActiveAgentRun(
  dependencies: AgentLoopRuntimeDependencies,
  control: AgentLoopControl,
): Promise<AgentRun> {
  return dependencies.mutations.run(control.caseId, async () => {
    const current = control.snapshot.run;
    if (current.state.kind !== "active") return current;
    const run = cancelAgentRun(current, dependencies.identifiers.nextStepId());
    await commitControlRun(dependencies, control, run, true);
    return run;
  });
}
