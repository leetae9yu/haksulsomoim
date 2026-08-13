import type { AgentRunProjection } from "../../contracts/desktop-api";

export function acceptAgentProjection(
  current: AgentRunProjection | undefined,
  candidate: AgentRunProjection,
): AgentRunProjection {
  if (current === undefined) return candidate;
  if (current.caseId !== candidate.caseId || current.runId !== candidate.runId) return current;
  if (current.state.kind === "terminal" || current.state.kind === "interrupted") return current;
  if (candidate.steps.length < current.steps.length) return current;
  const samePrefix = current.steps.every(
    (step, index) => candidate.steps[index]?.stepId === step.stepId,
  );
  if (!samePrefix || candidate.revision < current.revision) return current;
  if (candidate.revision > current.revision) return candidate;
  if (candidate.steps.length > current.steps.length) return candidate;
  if (current.state.kind !== "active" && candidate.state.kind === "active") return current;
  return candidate;
}
