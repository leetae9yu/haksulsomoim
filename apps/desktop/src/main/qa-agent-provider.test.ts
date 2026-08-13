import { describe, expect, test } from "bun:test";
import type { ApprovedAgentDecisionContext } from "../integrations/agent-provider/agent-provider";
import {
  type AgentToolResult,
  agentGoalSchema,
  agentToolResultSchema,
} from "./agent/agent-contracts";
import { createQaAgentProvider } from "./qa-agent-provider";

const contextDigest = "a".repeat(64);
const observationA = agentToolResultSchema.parse({
  toolName: "inspect-masked-case",
  toolCallId: "host-inspect-a",
  outcome: "completed",
  observationDigest: "b".repeat(64),
});
const observationB = agentToolResultSchema.parse({
  ...observationA,
  observationDigest: "c".repeat(64),
});

function context(observations: readonly AgentToolResult[]): ApprovedAgentDecisionContext {
  return {
    approval: "user-approved",
    contextDigest,
    goal: agentGoalSchema.parse({
      kind: "civil-recovery",
      caseId: "case-1",
      objective: "prepare-civil-demand",
    }),
    maskedFacts: [],
    citationIds: observations.length > 1 ? ["citation-1"] : [],
    observations,
  };
}

async function secondDecision(observation: AgentToolResult | undefined) {
  const provider = createQaAgentProvider("agent-happy");
  await provider.nextDecision(context([]));
  return provider.nextDecision(context(observation === undefined ? [] : [observation]));
}

describe("standard desktop QA Agent provider", () => {
  test("requires and consumes the persisted inspection digest before choosing law search", async () => {
    const unavailable = agentToolResultSchema.parse({ ...observationA, outcome: "unavailable" });
    await expect(secondDecision(undefined)).rejects.toThrow("inspection observation");
    await expect(secondDecision(unavailable)).rejects.toThrow("inspection observation");

    const provider = createQaAgentProvider("agent-happy");
    await provider.nextDecision(context([]));
    const fromA = await provider.nextDecision(context([observationA]));
    expect(fromA).toMatchObject({
      kind: "tool",
      toolCall: {
        toolName: "search-official-law",
        basisObservationDigest: observationA.observationDigest,
      },
    });
    await expect(provider.nextDecision(context([observationB]))).rejects.toThrow(
      "observation digest changed",
    );
  });

  test("writes a cited local draft from the completed law observation before finishing", async () => {
    const provider = createQaAgentProvider("agent-happy");
    await provider.nextDecision(context([]));
    await provider.nextDecision(context([observationA]));
    const law = agentToolResultSchema.parse({
      toolName: "search-official-law",
      toolCallId: "host-law",
      outcome: "completed",
      observationDigest: "d".repeat(64),
    });
    const decision = await provider.nextDecision(context([observationA, law]));

    expect(decision).toMatchObject({
      kind: "tool",
      toolCall: {
        toolName: "write-local-draft",
        contentDigest: law.observationDigest,
      },
    });
  });
});
