import { z } from "zod";
import {
  type AgentDecision,
  type AgentGoal,
  type AgentToolResult,
  agentDecisionSchema,
  agentGoalSchema,
  agentToolResultSchema,
} from "../../main/agent/agent-contracts";
import type { RedactedText } from "../../security/redaction";

export type ApprovedAgentDecisionContext = Readonly<{
  approval: "user-approved";
  contextDigest: string;
  goal: AgentGoal;
  maskedFacts: readonly Readonly<{ id: string; text: RedactedText }>[];
  citationIds: readonly string[];
  observations: readonly AgentToolResult[];
}>;

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => key in value);
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function parseApprovedDecisionContext(input: ApprovedAgentDecisionContext) {
  if (
    !record(input) ||
    !exactKeys(input, [
      "approval",
      "contextDigest",
      "goal",
      "maskedFacts",
      "citationIds",
      "observations",
    ]) ||
    input.approval !== "user-approved" ||
    typeof input.contextDigest !== "string" ||
    !DIGEST.test(input.contextDigest) ||
    !Array.isArray(input.maskedFacts) ||
    !Array.isArray(input.citationIds) ||
    !Array.isArray(input.observations)
  ) {
    throw new Error("Agent context must be an approved masked projection");
  }
  const goal = agentGoalSchema.parse(input.goal);
  const factIds = new Set<string>();
  const maskedFacts = input.maskedFacts.map((fact) => {
    if (
      !record(fact) ||
      !exactKeys(fact, ["id", "text"]) ||
      typeof fact.id !== "string" ||
      !ID.test(fact.id) ||
      typeof fact.text !== "string" ||
      fact.text.length === 0 ||
      factIds.has(fact.id)
    ) {
      throw new Error("Agent context contains invalid or duplicate masked fact IDs");
    }
    factIds.add(fact.id);
    return Object.freeze({ id: fact.id, text: fact.text as RedactedText });
  });
  const citationIds = parseUniqueIds(input.citationIds, "citation");
  const observations = input.observations.map((item) => agentToolResultSchema.parse(item));
  const observationIds = observations.map((item) => item.toolCallId);
  if (new Set(observationIds).size !== observationIds.length) {
    throw new Error("Agent context contains duplicate observation IDs");
  }
  return Object.freeze({
    approval: "user-approved" as const,
    contextDigest: input.contextDigest,
    goal,
    maskedFacts: Object.freeze(maskedFacts),
    citationIds: Object.freeze(citationIds),
    observations: Object.freeze(observations),
  });
}

function parseUniqueIds(values: readonly unknown[], label: string): string[] {
  if (!values.every((value) => typeof value === "string" && ID.test(value))) {
    throw new Error(`Agent context contains an invalid ${label} ID`);
  }
  const ids = values as string[];
  if (new Set(ids).size !== ids.length) {
    throw new Error(`Agent context contains duplicate ${label} IDs`);
  }
  return [...ids];
}

export function parseAgentDecision(
  text: string,
  context: ReturnType<typeof parseApprovedDecisionContext>,
): AgentDecision {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Codex returned an invalid structured Agent decision");
  }
  const result = agentDecisionSchema.safeParse(parsed);
  if (!result.success) throw new Error("Codex returned an invalid structured Agent decision");
  const decision = result.data;
  if (decision.kind === "tool") {
    if (String(decision.decisionId) === String(decision.toolCall.toolCallId)) {
      throw new Error("Codex returned duplicate Agent decision IDs");
    }
    if (
      decision.toolCall.toolName === "read-official-law-detail" &&
      !context.citationIds.includes(decision.toolCall.citationId)
    ) {
      throw new Error("Codex returned a citation that the user did not approve");
    }
    if (context.observations.some((item) => item.toolCallId === decision.toolCall.toolCallId)) {
      throw new Error("Codex returned duplicate Agent decision IDs");
    }
  }
  if (decision.kind === "request-approval") {
    if (
      decision.approval.decisionId !== decision.decisionId ||
      decision.approval.caseId !== context.goal.caseId ||
      decision.approval.contextDigest !== context.contextDigest
    ) {
      throw new Error("Codex returned an invalid structured Agent decision");
    }
    if (String(decision.approval.approvalId) === String(decision.decisionId)) {
      throw new Error("Codex returned duplicate Agent decision IDs");
    }
  }
  return decision;
}

const generatedSchema = z.toJSONSchema(agentDecisionSchema) as Record<string, unknown>;
const { $schema: _draft, ...documentedSchema } = generatedSchema;
export const AGENT_DECISION_OUTPUT_SCHEMA = Object.freeze({
  ...documentedSchema,
  type: "object",
});
