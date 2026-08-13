import type {
  ApprovedAgentDecisionContext,
  CodexAgentDecisionProvider,
} from "../integrations/agent-provider/agent-provider";
import { type AgentDecision, agentDecisionSchema } from "./agent/agent-contracts";

export type QaAgentScenario = "happy" | "malformed" | "agent-happy" | "agent-approval";

class QaAgentProvider implements CodexAgentDecisionProvider {
  readonly state = Object.freeze({
    status: "authenticated" as const,
    account: Object.freeze({ type: "chatgpt" as const, email: null, planType: "qa-fixture" }),
  });
  readonly #scenario: QaAgentScenario;
  #turn = 0;

  constructor(scenario: QaAgentScenario) {
    this.#scenario = scenario;
  }

  async nextDecision(input: ApprovedAgentDecisionContext): Promise<AgentDecision> {
    this.#turn += 1;
    if (this.#scenario === "agent-approval") {
      return agentDecisionSchema.parse({
        kind: "request-approval",
        decisionId: `qa-decision-${this.#turn}`,
        approval: {
          approvalId: `qa-approval-${this.#turn}`,
          approvalDigest: "a".repeat(64),
          caseId: input.goal.caseId,
          decisionId: `qa-decision-${this.#turn}`,
          action: "review-draft",
          contextDigest: input.contextDigest,
        },
      });
    }
    if (this.#turn === 1) {
      return agentDecisionSchema.parse({
        kind: "tool",
        decisionId: "qa-decision-inspect",
        toolCall: { toolName: "inspect-masked-case", toolCallId: "qa-tool-inspect" },
      });
    }
    if (this.#turn === 2) {
      return agentDecisionSchema.parse({
        kind: "tool",
        decisionId: "qa-decision-law",
        toolCall: {
          toolName: "search-official-law",
          toolCallId: "qa-tool-law",
          query: "지급명령과 강제집행 요건",
        },
      });
    }
    return agentDecisionSchema.parse({
      kind: "finish",
      decisionId: "qa-decision-finish",
      outcome: { kind: "completed", summaryDigest: "b".repeat(64) },
    });
  }

  async startChatGptLogin(): Promise<never> {
    throw new Error("QA Agent provider is already authenticated");
  }

  async interrupt(): Promise<void> {}

  async suggest(): Promise<never> {
    throw new Error("QA Agent provider does not expose suggestions");
  }

  async dispose(): Promise<void> {}
}

export function createQaAgentProvider(scenario: QaAgentScenario): CodexAgentDecisionProvider {
  return new QaAgentProvider(scenario);
}
