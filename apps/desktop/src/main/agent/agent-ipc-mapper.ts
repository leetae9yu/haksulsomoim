import { type AgentRun, agentRunSchema } from "./agent-contracts";
import {
  type AgentRunEvent,
  type AgentRunProjection,
  agentRunEventSchema,
  agentRunProjectionSchema,
} from "./agent-ipc-contracts";

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

export function toAgentRunProjection(value: unknown): AgentRunProjection {
  const projection = agentRunProjectionSchema.safeParse(value);
  if (projection.success) return projection.data;
  const run = agentRunSchema.parse(value);
  return agentRunProjectionSchema.parse({
    caseId: run.caseId,
    runId: run.runId,
    goal: run.goal,
    budget: run.budget,
    state: run.state,
    lastStepId: run.steps.at(-1)?.stepId ?? null,
    pendingApproval: currentApproval(run),
  });
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
