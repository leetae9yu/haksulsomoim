import type { RedactedText } from "../../security/redaction";

export type UserApprovedSuggestionInput = Readonly<{
  approval: "user-approved";
  maskedFacts: readonly Readonly<{ id: string; text: RedactedText }>[];
  citationIds: readonly string[];
}>;

export type AgentSuggestion = Readonly<{
  text: string;
  citationIds: readonly string[];
}>;

export const SUGGESTION_OUTPUT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["text", "citationIds"],
  properties: {
    text: { type: "string" },
    citationIds: { type: "array", items: { type: "string" } },
  },
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export function createUserApprovedSuggestionInput(
  maskedFacts: readonly Readonly<{ id: string; text: RedactedText }>[],
  citationIds: readonly string[],
): UserApprovedSuggestionInput {
  return parseApprovedInput({ approval: "user-approved", maskedFacts, citationIds });
}

export function parseApprovedInput(
  input: UserApprovedSuggestionInput,
): UserApprovedSuggestionInput {
  if (
    !isRecord(input) ||
    !hasExactKeys(input, ["approval", "maskedFacts", "citationIds"]) ||
    input.approval !== "user-approved" ||
    !Array.isArray(input.maskedFacts) ||
    !Array.isArray(input.citationIds)
  ) {
    throw new Error(
      "Suggestion context must contain only user-approved masked facts and citation IDs",
    );
  }

  const maskedFacts: Array<Readonly<{ id: string; text: RedactedText }>> = [];
  for (const fact of input.maskedFacts) {
    if (
      !isRecord(fact) ||
      !hasExactKeys(fact, ["id", "text"]) ||
      typeof fact.id !== "string" ||
      fact.id.length === 0 ||
      typeof fact.text !== "string" ||
      fact.text.length === 0
    ) {
      throw new Error("Every user-approved masked fact must have a non-empty id and text");
    }
    maskedFacts.push(Object.freeze({ id: fact.id, text: fact.text as RedactedText }));
  }

  if (!input.citationIds.every((id): id is string => typeof id === "string" && id.length > 0)) {
    throw new Error("Every user-approved citation ID must be a non-empty string");
  }

  return Object.freeze({
    approval: "user-approved",
    maskedFacts: Object.freeze(maskedFacts),
    citationIds: Object.freeze([...input.citationIds]),
  });
}

export function parseSuggestion(
  text: string,
  approvedCitationIds: readonly string[],
): AgentSuggestion {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Codex returned an invalid structured suggestion");
  }
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["text", "citationIds"]) ||
    typeof value.text !== "string" ||
    !Array.isArray(value.citationIds) ||
    !value.citationIds.every((id): id is string => typeof id === "string")
  ) {
    throw new Error("Codex returned an invalid structured suggestion");
  }
  const approved = new Set(approvedCitationIds);
  if (value.citationIds.some((id) => !approved.has(id))) {
    throw new Error("Codex returned a citation that the user did not approve");
  }
  if (new Set(value.citationIds).size !== value.citationIds.length) {
    throw new Error("Codex returned duplicate citation IDs");
  }
  return Object.freeze({ text: value.text, citationIds: Object.freeze([...value.citationIds]) });
}
