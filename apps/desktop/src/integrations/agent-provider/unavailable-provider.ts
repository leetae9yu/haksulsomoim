import type { AgentProviderState, CodexAgentProvider } from "./agent-provider";

export class UnavailableCodexAgentProvider implements CodexAgentProvider {
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

  async suggest(_input: unknown): Promise<never> {
    throw new Error("The official Codex binary is unavailable; use manual mode");
  }

  async dispose(): Promise<void> {}
}
