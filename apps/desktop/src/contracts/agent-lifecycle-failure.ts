export const unresolvedAgentToolLeaseError = "AGENT_CASE_UNRESOLVED_TOOL_LEASE";

export type AgentRecoveryIssue = "unresolved-tool" | "unavailable";

export function classifyAgentRecoveryFailure(error: unknown): AgentRecoveryIssue {
  return error instanceof Error && error.message.includes(unresolvedAgentToolLeaseError)
    ? "unresolved-tool"
    : "unavailable";
}
