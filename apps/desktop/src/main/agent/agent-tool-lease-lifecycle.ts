import { agentToolLeaseSchema } from "./agent-case-tool-lease";
import type { AgentRun, AgentToolCall } from "./agent-contracts";
import { AgentLoopStateError } from "./agent-loop-errors";
import type { AgentRunStore } from "./agent-loop-types";
import type { AgentToolExecutionBoundary, AgentToolExecutionOutcome } from "./agent-tool-execution";

export function createExecutingToolLease(run: AgentRun, call: AgentToolCall, timeoutMs: number) {
  const started = [...run.steps]
    .reverse()
    .find((step) => step.kind === "tool-started" && step.toolCall.toolCallId === call.toolCallId);
  if (started?.kind !== "tool-started") {
    throw new AgentLoopStateError("Agent tool lease requires its durable start checkpoint");
  }
  return agentToolLeaseSchema.parse({
    caseId: run.caseId,
    runId: run.runId,
    stepId: started.stepId,
    toolExecutionToken: call.toolCallId,
    startedAt: Date.now(),
    deadline: Date.now() + timeoutMs,
    state: "executing",
  });
}

export async function settleToolLeaseOutcome<Result>(
  runs: AgentRunStore,
  lease: ReturnType<typeof createExecutingToolLease>,
  boundary: AgentToolExecutionBoundary<Result>,
  outcome: AgentToolExecutionOutcome<Result>,
): Promise<Readonly<{ authoritativeSettlement?: Promise<void> }>> {
  if (outcome.kind === "interrupted" && outcome.quarantined) {
    await runs.transitionToolLease({ kind: "quarantined", lease });
    return {
      authoritativeSettlement: boundary.settled.then(() =>
        runs.transitionToolLease({ kind: "settled", lease }),
      ),
    };
  }
  await runs.transitionToolLease({ kind: "settled", lease });
  return {};
}
