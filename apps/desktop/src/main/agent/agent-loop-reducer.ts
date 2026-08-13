import {
  type AgentDecision,
  type AgentGoal,
  type AgentRun,
  type AgentToolCall,
  type AgentToolResult,
  agentDecisionSchema,
  agentRunSchema,
  type TerminalOutcome,
} from "./agent-contracts";

export type AgentDecisionReduction = Readonly<{
  run: AgentRun;
  toolCall?: AgentToolCall;
}>;

function budget(run: AgentRun, durationMsRemaining: number, decisions?: number, tools?: number) {
  return {
    decisionsRemaining: decisions ?? run.budget.decisionsRemaining,
    toolsRemaining: tools ?? run.budget.toolsRemaining,
    durationMsRemaining,
  };
}

function terminal(
  run: AgentRun,
  outcome: TerminalOutcome,
  stepId: string,
  durationMsRemaining: number,
  steps = run.steps,
): AgentRun {
  return agentRunSchema.parse({
    ...run,
    budget: budget(run, durationMsRemaining),
    state: { kind: "terminal", outcome },
    steps: [...steps, { kind: "terminal", stepId, outcome }],
  });
}

export function createActiveAgentRun(runId: string, caseId: string, goal: AgentGoal): AgentRun {
  return agentRunSchema.parse({
    runId,
    caseId,
    goal,
    budget: { decisionsRemaining: 12, toolsRemaining: 8, durationMsRemaining: 300_000 },
    state: { kind: "active" },
    steps: [],
  });
}

export function beginAgentDecision(
  run: AgentRun,
  decisionId: string,
  stepId: string,
  terminalStepId: string,
  durationMsRemaining: number,
): Readonly<{ run: AgentRun; started: boolean }> {
  if (durationMsRemaining === 0) {
    return {
      run: terminal(run, { kind: "budget-exhausted", exhausted: "duration" }, terminalStepId, 0),
      started: false,
    };
  }
  return {
    run: agentRunSchema.parse({
      ...run,
      budget: budget(run, durationMsRemaining),
      steps: [...run.steps, { kind: "decision-started", stepId, decisionId }],
    }),
    started: true,
  };
}

function decisionSteps(run: AgentRun, decision: AgentDecision, stepId: string) {
  return [...run.steps, { kind: "decision-recorded", stepId, decision }];
}

export function recordAgentDecision(
  run: AgentRun,
  decision: AgentDecision,
  stepId: string,
  boundaryStepId: string,
  durationMsRemaining: number,
): AgentDecisionReduction {
  const decisionsRemaining = run.budget.decisionsRemaining - 1;
  const nextBudget = budget(run, durationMsRemaining, decisionsRemaining);
  const steps = decisionSteps(run, decision, stepId);
  if (decision.kind === "finish") {
    return {
      run: agentRunSchema.parse({
        ...run,
        budget: nextBudget,
        state: { kind: "terminal", outcome: decision.outcome },
        steps: [...steps, { kind: "terminal", stepId: boundaryStepId, outcome: decision.outcome }],
      }),
    };
  }
  const exhausted =
    durationMsRemaining === 0 ? "duration" : decisionsRemaining === 0 ? "decisions" : undefined;
  if (exhausted !== undefined) {
    const outcome: TerminalOutcome = { kind: "budget-exhausted", exhausted };
    return {
      run: agentRunSchema.parse({
        ...run,
        budget: nextBudget,
        state: { kind: "terminal", outcome },
        steps: [...steps, { kind: "terminal", stepId: boundaryStepId, outcome }],
      }),
    };
  }
  if (decision.kind === "request-approval") {
    return {
      run: agentRunSchema.parse({
        ...run,
        budget: nextBudget,
        state: { kind: "paused", reason: "approval-required" },
        steps: [
          ...steps,
          { kind: "approval-requested", stepId: boundaryStepId, approval: decision.approval },
        ],
      }),
    };
  }
  return {
    run: agentRunSchema.parse({ ...run, budget: nextBudget, steps }),
    toolCall: decision.toolCall,
  };
}

export function failAgentDecision(
  run: AgentRun,
  decisionId: string,
  recordedStepId: string,
  terminalStepId: string,
  durationMsRemaining: number,
): AgentRun {
  const decision = agentDecisionSchema.parse({
    kind: "finish",
    decisionId,
    outcome: { kind: "failed-policy", reason: "unknown-tool" },
  });
  return recordAgentDecision(run, decision, recordedStepId, terminalStepId, durationMsRemaining)
    .run;
}

export function beginAgentTool(
  run: AgentRun,
  decisionId: string,
  toolCall: AgentToolCall,
  stepId: string,
): AgentRun {
  return agentRunSchema.parse({
    ...run,
    steps: [...run.steps, { kind: "tool-started", stepId, decisionId, toolCall }],
  });
}

export function finishAgentTool(
  run: AgentRun,
  result: AgentToolResult,
  resultStepId: string,
  boundaryStepId: string,
  durationMsRemaining: number,
  pending: boolean,
): AgentRun {
  const toolsRemaining = run.budget.toolsRemaining - 1;
  const nextBudget = budget(run, durationMsRemaining, undefined, toolsRemaining);
  const steps = [...run.steps, { kind: "tool-finished", stepId: resultStepId, result }];
  if (pending || result.outcome === "unavailable") {
    return agentRunSchema.parse({
      ...run,
      budget: nextBudget,
      state: {
        kind: "paused",
        reason: pending ? "approval-required" : "provider-unavailable",
      },
      steps,
    });
  }
  const exhausted =
    durationMsRemaining === 0 ? "duration" : toolsRemaining === 0 ? "tools" : undefined;
  if (exhausted === undefined) {
    return agentRunSchema.parse({ ...run, budget: nextBudget, steps });
  }
  const outcome: TerminalOutcome = { kind: "budget-exhausted", exhausted };
  return agentRunSchema.parse({
    ...run,
    budget: nextBudget,
    state: { kind: "terminal", outcome },
    steps: [...steps, { kind: "terminal", stepId: boundaryStepId, outcome }],
  });
}
