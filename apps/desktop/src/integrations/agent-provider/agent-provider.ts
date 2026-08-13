import type { AgentDecision } from "../../main/agent/agent-contracts";
import { sanitizeSecret } from "../../security/redaction";
import type { ApprovedAgentDecisionContext } from "./agent-decision-contracts";
import { AgentDecisionSession, type ProviderTimer, systemTimer } from "./agent-decision-session";
import { type ChatGptAccount, readChatGptAccount } from "./codex-account";
import type {
  CodexAppServerConnection,
  CodexAppServerLauncher,
  CodexAppServerNotification,
} from "./codex-app-server-protocol";
import { UnavailableCodexAgentProvider } from "./unavailable-provider";

export type { ApprovedAgentDecisionContext } from "./agent-decision-contracts";
export type { ProviderTimer } from "./agent-decision-session";
export type { ChatGptAccount } from "./codex-account";
export type {
  CodexAppServerConnection,
  CodexAppServerLauncher,
  CodexAppServerMethod,
  CodexAppServerNotification,
  CodexAppServerRequest,
  CodexAppServerStartResult,
} from "./codex-app-server-protocol";

export type AgentProviderState =
  | Readonly<{
      status: "unavailable";
      mode: "manual";
      reason: "codex-binary-unavailable";
      detail: string;
    }>
  | Readonly<{
      status: "sign-in-required";
      action: "sign-in-with-chatgpt";
    }>
  | Readonly<{
      status: "authenticated";
      account: ChatGptAccount;
    }>;

export interface CodexAgentProvider {
  readonly state: AgentProviderState;
  startChatGptLogin(): Promise<Readonly<{ loginId: string; authorizationUrl: string }>>;
  dispose(): Promise<void>;
}

export interface CodexAgentDecisionProvider extends CodexAgentProvider {
  nextDecision(input: ApprovedAgentDecisionContext): Promise<AgentDecision>;
  interrupt(): Promise<void>;
}

const SIGN_IN_REQUIRED: AgentProviderState = Object.freeze({
  status: "sign-in-required",
  action: "sign-in-with-chatgpt",
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

class AvailableCodexAgentProvider implements CodexAgentDecisionProvider {
  #state: AgentProviderState = SIGN_IN_REQUIRED;
  readonly #connection: CodexAppServerConnection;
  readonly #decisions: AgentDecisionSession;
  readonly #unsubscribe: () => void;

  constructor(connection: CodexAppServerConnection, timer: ProviderTimer) {
    this.#connection = connection;
    this.#decisions = new AgentDecisionSession(connection, { timer, deadlineMs: 30_000 });
    this.#unsubscribe = connection.onNotification((notification) =>
      this.#handleAccountNotification(notification),
    );
  }

  get state(): AgentProviderState {
    return this.#state;
  }

  async initialize(): Promise<void> {
    await this.#connection.request({
      method: "initialize",
      params: {
        clientInfo: { name: "haksulsomoim", title: "Haksulsomoim", version: "0.1.0" },
        capabilities: null,
      },
    });
    this.#connection.notify("initialized");
    await this.#refreshAccount();
  }

  async startChatGptLogin(): Promise<Readonly<{ loginId: string; authorizationUrl: string }>> {
    const response = await this.#connection.request({
      method: "account/login/start",
      params: { type: "chatgpt" },
    });
    if (
      !isRecord(response) ||
      response.type !== "chatgpt" ||
      typeof response.loginId !== "string" ||
      typeof response.authUrl !== "string"
    ) {
      throw new Error("Codex app-server returned an invalid ChatGPT login response");
    }
    let authorizationUrl: URL;
    try {
      authorizationUrl = new URL(response.authUrl);
    } catch {
      throw new Error("Codex ChatGPT authorization URL must use an official OpenAI auth host");
    }
    if (
      authorizationUrl.protocol !== "https:" ||
      authorizationUrl.hostname !== "auth.openai.com" ||
      authorizationUrl.username !== "" ||
      authorizationUrl.password !== ""
    ) {
      throw new Error("Codex ChatGPT authorization URL must use an official OpenAI auth host");
    }
    return Object.freeze({ loginId: response.loginId, authorizationUrl: authorizationUrl.href });
  }

  async nextDecision(input: ApprovedAgentDecisionContext): Promise<AgentDecision> {
    if (this.#state.status !== "authenticated") {
      throw new Error("ChatGPT sign-in is required before requesting an Agent decision");
    }
    return this.#decisions.nextDecision(input);
  }

  async interrupt(): Promise<void> {
    await this.#decisions.interrupt();
  }

  async dispose(): Promise<void> {
    this.#decisions.dispose();
    this.#unsubscribe();
    await this.#connection.close();
  }

  async #refreshAccount(): Promise<void> {
    const response = await this.#connection.request({
      method: "account/read",
      params: { refreshToken: false },
    });
    const account = readChatGptAccount(response);
    this.#state =
      account === null ? SIGN_IN_REQUIRED : Object.freeze({ status: "authenticated", account });
  }

  async #handleAccountNotification(notification: CodexAppServerNotification): Promise<void> {
    if (notification.method === "account/updated") {
      await this.#refreshAccount();
      return;
    }
    if (
      notification.method === "account/login/completed" &&
      isRecord(notification.params) &&
      notification.params.success === true
    ) {
      await this.#refreshAccount();
    }
  }
}

export const createCodexAgentProvider = async (
  launchAppServer: CodexAppServerLauncher,
  options: Readonly<{ timer?: ProviderTimer }> = {},
): Promise<CodexAgentDecisionProvider> => {
  const started = await launchAppServer();
  if (started.status === "binary-unavailable") {
    return new UnavailableCodexAgentProvider(sanitizeSecret(started.reason, process.env.LAW_OC));
  }
  const provider = new AvailableCodexAgentProvider(
    started.connection,
    options.timer ?? systemTimer,
  );
  try {
    await provider.initialize();
    return provider;
  } catch (error) {
    await provider.dispose();
    throw error;
  }
};
