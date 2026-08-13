import {
  type AgentDecision,
  type AgentRun,
  type ApprovalDecision,
  agentRunSchema,
} from "./agent-contracts";

function withDuration(run: AgentRun, durationMsRemaining: number) {
  return { ...run.budget, durationMsRemaining };
}

export function pauseIdleAgentRun(
  run: AgentRun,
  reason: "provider-unavailable" | "context-changed",
  durationMsRemaining: number,
): AgentRun {
  return agentRunSchema.parse({
    ...run,
    budget: withDuration(run, durationMsRemaining),
    state: { kind: "paused", reason },
  });
}

export function pauseAgentDecisionForContext(
  run: AgentRun,
  decision: AgentDecision,
  stepId: string,
  durationMsRemaining: number,
): AgentRun {
  return agentRunSchema.parse({
    ...run,
    budget: {
      ...withDuration(run, durationMsRemaining),
      decisionsRemaining: run.budget.decisionsRemaining - 1,
    },
    state: { kind: "paused", reason: "context-changed" },
    steps: [...run.steps, { kind: "decision-recorded", stepId, decision }],
  });
}

export function pauseFailedProviderTurn(
  run: AgentRun,
  stepId: string,
  durationMsRemaining: number,
): AgentRun {
  const interruption = { kind: "provider-timeout" };
  return agentRunSchema.parse({
    ...run,
    budget: withDuration(run, durationMsRemaining),
    state: { kind: "paused", reason: "provider-unavailable" },
    steps: [...run.steps, { kind: "interrupted", stepId, interruption }],
  });
}

export function cancelAgentRun(run: AgentRun, stepId: string): AgentRun {
  const interruption = { kind: "user-cancelled" };
  return agentRunSchema.parse({
    ...run,
    state: { kind: "interrupted", interruption },
    steps: [...run.steps, { kind: "interrupted", stepId, interruption }],
  });
}

export function recordAgentApproval(
  run: AgentRun,
  decision: ApprovalDecision,
  stepId: string,
): AgentRun {
  return agentRunSchema.parse({
    ...run,
    state: { kind: "paused", reason: "approval-required" },
    steps: [...run.steps, { kind: "approval-decided", stepId, decision }],
  });
}
