import type { AgentRunProjection } from "../../contracts/desktop-api";

export function acceptAgentProjection(
  current: AgentRunProjection | undefined,
  candidate: AgentRunProjection,
): AgentRunProjection {
  if (current === undefined) return candidate;
  if (current.caseId !== candidate.caseId || current.runId !== candidate.runId) return current;
  if (current.state.kind === "terminal") return current;
  if (candidate.steps.length < current.steps.length) return current;
  const samePrefix = current.steps.every(
    (step, index) => candidate.steps[index]?.stepId === step.stepId,
  );
  if (!samePrefix || candidate.revision < current.revision) return current;
  if (current.state.kind === "interrupted") {
    const higherRevision = candidate.revision > current.revision;
    const resumesRestart =
      current.state.interruption.kind === "application-restarted" &&
      candidate.state.kind === "active";
    const finalizesRestart =
      current.state.interruption.kind === "application-restarted" &&
      (candidate.state.kind === "terminal" ||
        (candidate.state.kind === "interrupted" &&
          candidate.state.interruption.kind === "user-cancelled"));
    return higherRevision && (resumesRestart || finalizesRestart) ? candidate : current;
  }
  if (candidate.revision > current.revision) return candidate;
  if (candidate.steps.length > current.steps.length) return candidate;
  if (current.state.kind !== "active" && candidate.state.kind === "active") return current;
  return candidate;
}

export function acceptAgentProjectionEvent(
  current: AgentRunProjection | undefined,
  candidate: AgentRunProjection,
): AgentRunProjection {
  if (
    current?.state.kind === "interrupted" &&
    (candidate.state.kind === "active" || candidate.state.kind === "paused")
  ) {
    return current;
  }
  return acceptAgentProjection(current, candidate);
}
