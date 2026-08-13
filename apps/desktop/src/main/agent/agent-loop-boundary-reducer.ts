import {
  type AgentRun,
  type ApprovalDecision,
  agentDecisionSchema,
  agentRunSchema,
} from "./agent-contracts";

function withDuration(run: AgentRun, durationMsRemaining: number) {
  return { ...run.budget, durationMsRemaining };
}

export function pauseIdleAgentRun(
  run: AgentRun,
  reason: "provider-unavailable" | "tool-unavailable" | "context-changed" | "user-paused",
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
  decisionId: string,
  stepId: string,
  durationMsRemaining: number,
): AgentRun {
  const decision = agentDecisionSchema.parse({
    kind: "finish",
    decisionId,
    outcome: { kind: "failed-policy", reason: "context-changed" },
  });
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

export function pauseTimedOutAgentTool(
  run: AgentRun,
  stepId: string,
  durationMsRemaining: number,
): AgentRun {
  const interruption = { kind: "tool-timeout" } as const;
  return agentRunSchema.parse({
    ...run,
    budget: withDuration(run, durationMsRemaining),
    state: { kind: "paused", reason: "tool-unavailable" },
    steps: [...run.steps, { kind: "interrupted", stepId, interruption }],
  });
}

export function pauseAgentRunForUser(
  run: AgentRun,
  stepId: string,
  durationMsRemaining: number,
): AgentRun {
  const interruption = { kind: "user-paused" };
  return agentRunSchema.parse({
    ...run,
    budget: withDuration(run, durationMsRemaining),
    state: { kind: "paused", reason: "user-paused" },
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
