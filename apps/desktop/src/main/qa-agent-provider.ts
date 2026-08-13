import type {
  ApprovedAgentDecisionContext,
  CodexAgentDecisionProvider,
} from "../integrations/agent-provider/agent-provider";
import {
  type AgentDecision,
  type AgentToolResult,
  agentDecisionSchema,
} from "./agent/agent-contracts";

export type QaAgentScenario =
  | "happy"
  | "malformed"
  | "agent-happy"
  | "agent-approval"
  | "agent-live-controls"
  | "agent-resume"
  | "agent-provider-failure";

function completed(
  input: ApprovedAgentDecisionContext,
  index: number,
  toolName: AgentToolResult["toolName"],
  label: string,
) {
  const result = input.observations[index];
  if (result?.toolName !== toolName || result.outcome !== "completed") {
    throw new Error(`QA Agent requires a completed ${label} observation`);
  }
  return result;
}

class QaAgentProvider implements CodexAgentDecisionProvider {
  readonly state = Object.freeze({
    status: "authenticated" as const,
    account: Object.freeze({ type: "chatgpt" as const, email: null, planType: "qa-fixture" }),
  });
  readonly #scenario: QaAgentScenario;
  readonly #afterRestart: boolean;
  readonly #crashRestart: boolean;
  #inspectionRequested = false;
  #inspectionDigest: string | undefined;
  #rejectDeferredTurn: ((error: Error) => void) | undefined;

  constructor(scenario: QaAgentScenario, afterRestart: boolean, crashRestart: boolean) {
    this.#scenario = scenario;
    this.#afterRestart = afterRestart;
    this.#crashRestart = crashRestart;
    this.#inspectionRequested = afterRestart;
  }

  async nextDecision(input: ApprovedAgentDecisionContext): Promise<AgentDecision> {
    if (this.#scenario === "agent-provider-failure") {
      throw new Error("QA Agent provider is unavailable");
    }
    if (
      (this.#scenario === "agent-live-controls" || this.#scenario === "agent-resume") &&
      (!this.#crashRestart || (!this.#afterRestart && input.observations.length > 0))
    ) {
      return new Promise<never>((_resolve, reject) => {
        this.#rejectDeferredTurn = reject;
      });
    }
    if (this.#scenario === "agent-approval") {
      return agentDecisionSchema.parse({
        kind: "request-approval",
        decisionId: "qa-decision-approval",
        approval: {
          approvalId: "qa-approval",
          approvalDigest: "a".repeat(64),
          caseId: input.goal.caseId,
          decisionId: "qa-decision-approval",
          action: "review-draft",
          contextDigest: input.contextDigest,
        },
      });
    }
    if (input.observations.length === 0) {
      if (this.#inspectionRequested) {
        throw new Error("QA Agent requires a completed inspection observation");
      }
      this.#inspectionRequested = true;
      return agentDecisionSchema.parse({
        kind: "tool",
        decisionId: "qa-decision-inspect",
        toolCall: { toolName: "inspect-masked-case", toolCallId: "qa-tool-inspect" },
      });
    }
    if (!this.#inspectionRequested) throw new Error("QA Agent inspection was not requested");
    const inspection = completed(input, 0, "inspect-masked-case", "inspection");
    if (
      this.#inspectionDigest !== undefined &&
      this.#inspectionDigest !== inspection.observationDigest
    ) {
      throw new Error("QA Agent inspection observation digest changed");
    }
    this.#inspectionDigest ??= inspection.observationDigest;
    if (input.observations.length === 1) {
      return agentDecisionSchema.parse({
        kind: "tool",
        decisionId: "qa-decision-law",
        toolCall: {
          toolName: "search-official-law",
          toolCallId: "qa-tool-law",
          query: `지급명령과 강제집행 요건 ${inspection.observationDigest.slice(0, 12)}`,
          basisObservationDigest: inspection.observationDigest,
        },
      });
    }
    const firstLaw = completed(input, 1, "search-official-law", "first official-law");
    if (input.observations.length === 2) {
      return agentDecisionSchema.parse({
        kind: "tool",
        decisionId: "qa-decision-second-law",
        toolCall: {
          toolName: "search-official-law",
          toolCallId: "qa-tool-second-law",
          query: `민사소송 절차 ${firstLaw.observationDigest.slice(0, 12)}`,
          basisObservationDigest: firstLaw.observationDigest,
        },
      });
    }
    const secondLaw = completed(input, 2, "search-official-law", "second official-law");
    if (input.observations.length === 3) {
      if (input.citationIds.length < 2) throw new Error("QA Agent requires two official citations");
      return agentDecisionSchema.parse({
        kind: "tool",
        decisionId: "qa-decision-draft",
        toolCall: {
          toolName: "write-local-draft",
          toolCallId: "qa-tool-draft",
          artifactKind:
            input.goal.kind === "civil-recovery" ? "civil-demand" : "criminal-complaint",
          contentDigest: secondLaw.observationDigest,
        },
      });
    }
    const draft = completed(input, 3, "write-local-draft", "encrypted-draft");
    if (draft.toolName !== "write-local-draft" || draft.artifactId === undefined) {
      throw new Error("QA Agent requires an encrypted draft artifact");
    }
    if (input.observations.length !== 4) throw new Error("QA Agent received extra observations");
    return agentDecisionSchema.parse({
      kind: "finish",
      decisionId: "qa-decision-finish",
      outcome: { kind: "completed", summaryDigest: "b".repeat(64) },
    });
  }

  async startChatGptLogin(): Promise<never> {
    throw new Error("QA Agent provider is already authenticated");
  }
  async interrupt(): Promise<void> {
    this.#rejectDeferredTurn?.(new Error("QA deferred Agent turn interrupted by host control"));
    this.#rejectDeferredTurn = undefined;
  }
  async suggest(): Promise<never> {
    throw new Error("QA Agent provider does not expose suggestions");
  }
  async dispose(): Promise<void> {
    await this.interrupt();
  }
}

export function createQaAgentProvider(
  scenario: QaAgentScenario,
  options: Readonly<{ afterRestart?: boolean; crashRestart?: boolean }> = {},
): CodexAgentDecisionProvider {
  return new QaAgentProvider(
    scenario,
    options.afterRestart === true,
    options.crashRestart === true,
  );
}
