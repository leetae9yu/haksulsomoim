import { createHash } from "node:crypto";
import type { RedactedText } from "../../security/redaction";
import { type AgentToolCall, type AgentToolResult, agentToolResultSchema } from "./agent-contracts";
import type { AgentToolExecution } from "./agent-tool-registry";

export const agentObservationTextLimit = 2_000;

export type PreparedAgentObservation = Readonly<{
  result: AgentToolResult;
  summary: RedactedText;
}>;

function serialize(value: unknown): string {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? "unavailable observation" : serialized;
  } catch {
    return "unavailable observation";
  }
}

export function prepareAgentObservation(
  caseId: string,
  call: AgentToolCall,
  execution: AgentToolExecution,
  redact: (caseId: string, value: string) => RedactedText,
): PreparedAgentObservation {
  const summary = redact(
    caseId,
    serialize({
      status: execution.status,
      value: execution.value,
      citationIds: execution.citationIds,
    }),
  ).slice(0, agentObservationTextLimit);
  const observationDigest = createHash("sha256").update(summary).digest("hex");
  const outcome = execution.status === "unavailable" ? "unavailable" : "completed";
  return {
    summary: redact(caseId, summary),
    result: agentToolResultSchema.parse({
      toolName: call.toolName,
      toolCallId: call.toolCallId,
      outcome,
      observationDigest,
    }),
  };
}
