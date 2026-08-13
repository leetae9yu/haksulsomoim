import type { AgentProviderState, CodexAgentDecisionProvider } from "./agent-provider";

export class UnavailableCodexAgentProvider implements CodexAgentDecisionProvider {
  readonly state: AgentProviderState;

  constructor(detail: string) {
    this.state = Object.freeze({
      status: "unavailable",
      mode: "manual",
      reason: "codex-binary-unavailable",
      detail,
    });
  }

  async startChatGptLogin(): Promise<never> {
    throw new Error("The official Codex binary is unavailable; use manual mode");
  }

  async nextDecision(_input: unknown): Promise<never> {
    throw new Error("The official Codex binary is unavailable; use manual mode");
  }

  async interrupt(): Promise<void> {}

  async dispose(): Promise<void> {}
}
