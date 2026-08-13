import { type AgentRun, type AgentStep, agentRunSchema } from "./agent-contracts";

export const digest = "a".repeat(64);
export const alternateDigest = "b".repeat(64);

export function activeRun(runId = "run-1", caseId = "case-private-1"): AgentRun {
  return agentRunSchema.parse({
    runId,
    caseId,
    goal: { kind: "civil-recovery", caseId, objective: "prepare-civil-demand" },
    budget: {
      decisionsRemaining: 12,
      toolsRemaining: 8,
      durationMsRemaining: 300_000,
    },
    state: { kind: "active" },
    steps: [],
  });
}

export function decisionStarted(stepId = "step-1", decisionId = "decision-1"): AgentStep {
  return {
    kind: "decision-started",
    stepId,
    decisionId,
  } as AgentStep;
}

export function decisionRecorded(stepId = "step-2"): AgentStep {
  return {
    kind: "decision-recorded",
    stepId,
    decision: {
      kind: "tool",
      decisionId: "decision-1",
      toolCall: {
        toolName: "search-official-law",
        toolCallId: "tool-call-1",
        query: "masked payment order requirements",
      },
    },
  } as AgentStep;
}

export function toolStarted(stepId = "step-3"): AgentStep {
  return {
    kind: "tool-started",
    stepId,
    decisionId: "decision-1",
    toolCall: {
      toolName: "search-official-law",
      toolCallId: "tool-call-1",
      query: "masked payment order requirements",
    },
  } as AgentStep;
}

export function toolFinished(stepId = "step-4", resultDigest = digest): AgentStep {
  return {
    kind: "tool-finished",
    stepId,
    result: {
      toolName: "search-official-law",
      toolCallId: "tool-call-1",
      outcome: "completed",
      observationDigest: resultDigest,
    },
  } as AgentStep;
}

export function withSteps(run: AgentRun, steps: readonly AgentStep[]): AgentRun {
  return agentRunSchema.parse({ ...run, steps });
}
