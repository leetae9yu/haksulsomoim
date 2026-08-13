import { z } from "zod";
import { type AgentRun, type AgentStep, agentRunSchema } from "./agent-contracts";
import {
  type AgentRunEvent,
  type AgentRunProjection,
  type AgentStepSummary,
  agentOfficialCitationProjectionSchema,
  agentRunEventSchema,
  agentRunProjectionSchema,
} from "./agent-ipc-contracts";

const rendererProjectionSourceSchema = z.strictObject({
  run: agentRunSchema,
  citations: z.array(agentOfficialCitationProjectionSchema).max(24).readonly(),
});

function currentApproval(run: AgentRun) {
  for (let index = run.steps.length - 1; index >= 0; index -= 1) {
    const step = run.steps[index];
    if (step?.kind === "approval-decided") return null;
    if (step?.kind === "approval-requested") {
      return {
        approvalId: step.approval.approvalId,
        approvalDigest: step.approval.approvalDigest,
        contextDigest: step.approval.contextDigest,
        action: step.approval.action,
      };
    }
  }
  return null;
}

function terminalSummary(step: Extract<AgentStep, { kind: "terminal" }>) {
  if (step.outcome.kind === "completed") return { kind: "completed" as const };
  if (step.outcome.kind === "budget-exhausted") {
    return { kind: "budget-exhausted" as const, exhausted: step.outcome.exhausted };
  }
  return { kind: "failed-policy" as const, reason: step.outcome.reason };
}

function summarizeStep(step: AgentStep): AgentStepSummary {
  switch (step.kind) {
    case "decision-started":
      return { kind: step.kind, stepId: step.stepId };
    case "decision-recorded":
      return { kind: step.kind, stepId: step.stepId, decisionKind: step.decision.kind };
    case "tool-started":
      return { kind: step.kind, stepId: step.stepId, toolName: step.toolCall.toolName };
    case "tool-finished":
      return {
        kind: step.kind,
        stepId: step.stepId,
        toolName: step.result.toolName,
        outcome: step.result.outcome,
      };
    case "approval-requested":
      return { kind: step.kind, stepId: step.stepId, action: step.approval.action };
    case "approval-decided":
      return { kind: step.kind, stepId: step.stepId, outcome: step.decision.outcome };
    case "interrupted":
      return { kind: step.kind, stepId: step.stepId, reason: step.interruption.kind };
    case "terminal":
      return { kind: step.kind, stepId: step.stepId, outcome: terminalSummary(step) };
  }
}

function projectRun(run: AgentRun, citations: readonly unknown[] = []): AgentRunProjection {
  return agentRunProjectionSchema.parse({
    caseId: run.caseId,
    runId: run.runId,
    goal: run.goal,
    budget: run.budget,
    state: run.state,
    lastStepId: run.steps.at(-1)?.stepId ?? null,
    pendingApproval: currentApproval(run),
    steps: run.steps.map(summarizeStep),
    citations,
  });
}

export function toAgentRunProjection(value: unknown): AgentRunProjection {
  const projection = agentRunProjectionSchema.safeParse(value);
  if (projection.success) return projection.data;
  const source = rendererProjectionSourceSchema.safeParse(value);
  if (source.success) return projectRun(source.data.run, source.data.citations);
  return projectRun(agentRunSchema.parse(value));
}

export function toAgentRunEvent(
  value: unknown,
  binding: Readonly<{ caseId: string; runId: string }>,
): AgentRunEvent | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const event = value as Readonly<{
    caseId?: unknown;
    runId?: unknown;
    run?: unknown;
    projection?: unknown;
  }>;
  if (event.caseId !== binding.caseId || event.runId !== binding.runId) return undefined;
  const projection = toAgentRunProjection(event.run ?? event.projection ?? value);
  if (projection.caseId !== binding.caseId || projection.runId !== binding.runId) return undefined;
  return agentRunEventSchema.parse({
    caseId: binding.caseId,
    runId: binding.runId,
    projection,
  });
}
