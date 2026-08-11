import { type ChatGptAccount, readChatGptAccount } from "./codex-account";
import {
  type AgentSuggestion,
  parseApprovedInput,
  parseSuggestion,
  SUGGESTION_OUTPUT_SCHEMA,
} from "./suggestion-contracts";
import { UnavailableCodexAgentProvider } from "./unavailable-provider";

export type { ChatGptAccount } from "./codex-account";
export type { AgentSuggestion, UserApprovedSuggestionInput } from "./suggestion-contracts";

export type CodexAppServerMethod =
  | "initialize"
  | "account/read"
  | "account/login/start"
  | "thread/start"
  | "turn/start";

export type CodexAppServerRequest = Readonly<{
  method: CodexAppServerMethod;
  params: unknown;
}>;

export type CodexAppServerNotification = Readonly<{
  method: "account/login/completed" | "account/updated" | "item/completed" | "turn/completed";
  params: unknown;
}>;

export interface CodexAppServerConnection {
  request(request: CodexAppServerRequest): Promise<unknown>;
  notify(method: "initialized"): void;
  close(): void;
  onNotification(
    listener: (notification: CodexAppServerNotification) => void | Promise<void>,
  ): () => void;
}

export type CodexAppServerStartResult =
  | Readonly<{ status: "ready"; connection: CodexAppServerConnection }>
  | Readonly<{ status: "binary-unavailable"; reason: string }>;

export type CodexAppServerLauncher = () => Promise<CodexAppServerStartResult>;

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
  suggest(input: unknown): Promise<AgentSuggestion>;
  dispose(): void;
}

const SIGN_IN_REQUIRED: AgentProviderState = Object.freeze({
  status: "sign-in-required",
  action: "sign-in-with-chatgpt",
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

class AvailableCodexAgentProvider implements CodexAgentProvider {
  #state: AgentProviderState = SIGN_IN_REQUIRED;
  readonly #connection: CodexAppServerConnection;
  readonly #unsubscribe: () => void;

  constructor(connection: CodexAppServerConnection) {
    this.#connection = connection;
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
    const authorizationUrl = new URL(response.authUrl);
    if (authorizationUrl.protocol !== "https:") {
      throw new Error("Codex ChatGPT authorization URL must use HTTPS");
    }
    return Object.freeze({ loginId: response.loginId, authorizationUrl: authorizationUrl.href });
  }

  async suggest(input: unknown): Promise<AgentSuggestion> {
    if (this.#state.status !== "authenticated") {
      throw new Error("ChatGPT sign-in is required before requesting a suggestion");
    }
    const approvedInput = parseApprovedInput(input);
    const threadResponse = await this.#connection.request({
      method: "thread/start",
      params: { ephemeral: true, approvalPolicy: "never", sandbox: "read-only" },
    });
    if (
      !isRecord(threadResponse) ||
      !isRecord(threadResponse.thread) ||
      typeof threadResponse.thread.id !== "string"
    ) {
      throw new Error("Codex app-server returned an invalid thread");
    }

    const threadId = threadResponse.thread.id;
    let agentMessage: string | null = null;
    let resolveCompletion: (() => void) | undefined;
    let rejectCompletion: ((error: Error) => void) | undefined;
    const completion = new Promise<void>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    const timeout = setTimeout(
      () => rejectCompletion?.(new Error("Timed out waiting for Codex turn completion")),
      30_000,
    );
    const unsubscribe = this.#connection.onNotification((notification) => {
      if (!isRecord(notification.params) || notification.params.threadId !== threadId) {
        return;
      }
      if (notification.method === "item/completed") {
        const item = notification.params.item;
        if (isRecord(item) && item.type === "agentMessage" && typeof item.text === "string") {
          agentMessage = item.text;
        }
        return;
      }
      if (notification.method === "turn/completed") {
        const turn = notification.params.turn;
        if (!isRecord(turn) || turn.status !== "completed") {
          const message =
            isRecord(turn) && isRecord(turn.error) && typeof turn.error.message === "string"
              ? turn.error.message
              : "Codex turn did not complete successfully";
          rejectCompletion?.(new Error(message));
          return;
        }
        resolveCompletion?.();
      }
    });

    try {
      const prompt = JSON.stringify({
        task: "Provide a non-binding case-work suggestion using only the approved masked facts and citation IDs.",
        maskedFacts: approvedInput.maskedFacts,
        citationIds: approvedInput.citationIds,
      });
      await this.#connection.request({
        method: "turn/start",
        params: {
          threadId,
          input: [{ type: "text", text: prompt, text_elements: [] }],
          outputSchema: SUGGESTION_OUTPUT_SCHEMA,
        },
      });
      await completion;
      if (agentMessage === null) {
        throw new Error("Codex completed without a structured suggestion");
      }
      return parseSuggestion(agentMessage, approvedInput.citationIds);
    } finally {
      clearTimeout(timeout);
      unsubscribe();
    }
  }

  dispose(): void {
    this.#unsubscribe();
    this.#connection.close();
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
): Promise<CodexAgentProvider> => {
  const started = await launchAppServer();
  if (started.status === "binary-unavailable") {
    return new UnavailableCodexAgentProvider(started.reason);
  }
  const provider = new AvailableCodexAgentProvider(started.connection);
  await provider.initialize();
  return provider;
};
