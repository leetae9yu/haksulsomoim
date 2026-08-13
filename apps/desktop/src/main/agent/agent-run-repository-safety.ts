import type { AgentRun } from "./agent-contracts";

const SENSITIVE_TEXT = [
  /(?<!\d)\d{6}-?[1-4]\d{6}(?!\d)/u,
  /(?<!\d)01[016789][ -]?\d{3,4}[ -]?\d{4}(?!\d)/u,
  /(?<!\d)\d{2,6}(?:-\d{2,6}){2,4}(?!\d)/u,
  /(?<!\d)(?:19|20)\d{2}[가-힣]{1,4}\d{1,10}(?!\d)/u,
  /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu,
  /\b(?:bearer|api[_-]?key|secret)\s*[:=]\s*\S+/iu,
  /\bsk-[A-Za-z0-9_-]{16,}\b/u,
];

export function hasSensitiveAgentText(run: AgentRun): boolean {
  for (const step of run.steps) {
    const call =
      step.kind === "decision-recorded" && step.decision.kind === "tool"
        ? step.decision.toolCall
        : step.kind === "tool-started"
          ? step.toolCall
          : undefined;
    if (
      call?.toolName === "search-official-law" &&
      SENSITIVE_TEXT.some((pattern) => pattern.test(call.query))
    ) {
      return true;
    }
  }
  return false;
}
