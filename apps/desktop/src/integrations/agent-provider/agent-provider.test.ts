import { describe, expect, test } from "bun:test";
import { Redactor } from "../../security/redaction";
import {
  type CodexAppServerConnection,
  type CodexAppServerNotification,
  type CodexAppServerRequest,
  type CodexAppServerStartResult,
  createCodexAgentProvider,
  createUserApprovedSuggestionInput,
} from "./agent-provider";

class FakeCodexAppServer implements CodexAppServerConnection {
  readonly requests: CodexAppServerRequest[] = [];
  readonly clientNotifications: string[] = [];
  account: unknown = null;
  loginResponse: unknown = {
    type: "chatgpt",
    loginId: "login-1",
    authUrl: "https://auth.openai.com/oauth/authorize?state=opaque",
  };
  initializationError: Error | undefined;
  closed = false;
  suggestionText = JSON.stringify({
    text: "제출 전 날짜를 확인하세요.",
    citationIds: ["cite-1"],
  });
  private readonly listeners = new Set<
    (notification: CodexAppServerNotification) => void | Promise<void>
  >();

  async request(request: CodexAppServerRequest): Promise<unknown> {
    this.requests.push(structuredClone(request));
    switch (request.method) {
      case "initialize":
        if (this.initializationError !== undefined) throw this.initializationError;
        return { userAgent: "codex-test" };
      case "account/read":
        return { account: this.account, requiresOpenaiAuth: true };
      case "account/login/start":
        return this.loginResponse;
      case "thread/start":
        return { thread: { id: "thread-1" } };
      case "turn/start": {
        const completion = this.emit({
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: { type: "agentMessage", id: "item-1", text: this.suggestionText },
          },
        }).then(() =>
          this.emit({
            method: "turn/completed",
            params: {
              threadId: "thread-1",
              turn: { id: "turn-1", status: "completed", error: null },
            },
          }),
        );
        await completion;
        return { turn: { id: "turn-1" } };
      }
    }
  }

  notify(method: "initialized"): void {
    this.clientNotifications.push(method);
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  onNotification(
    listener: (notification: CodexAppServerNotification) => void | Promise<void>,
  ): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async emit(notification: CodexAppServerNotification): Promise<void> {
    await Promise.all([...this.listeners].map((listener) => listener(notification)));
  }
}

const available = (server: FakeCodexAppServer): CodexAppServerStartResult => ({
  status: "ready",
  connection: server,
});

describe("Codex agent provider", () => {
  test("falls back to typed manual mode when the official Codex binary is unavailable", async () => {
    const provider = await createCodexAgentProvider(async () => ({
      status: "binary-unavailable",
      reason: "optional native package is missing",
    }));

    expect(provider.state).toEqual({
      status: "unavailable",
      mode: "manual",
      reason: "codex-binary-unavailable",
      detail: "optional native package is missing",
    });
  });

  test("closes app-server when provider initialization fails", async () => {
    const server = new FakeCodexAppServer();
    server.initializationError = new Error("initialize rejected");

    await expect(createCodexAgentProvider(async () => available(server))).rejects.toThrow(
      "initialize rejected",
    );
    expect(server.closed).toBe(true);
  });

  test("initializes app-server and exposes the exact sign-in-required action with no account", async () => {
    const server = new FakeCodexAppServer();
    const provider = await createCodexAgentProvider(async () => available(server));

    expect(server.requests.slice(0, 2)).toEqual([
      {
        method: "initialize",
        params: {
          clientInfo: { name: "haksulsomoim", title: "Haksulsomoim", version: "0.1.0" },
          capabilities: null,
        },
      },
      { method: "account/read", params: { refreshToken: false } },
    ]);
    expect(server.clientNotifications).toEqual(["initialized"]);
    expect(provider.state).toEqual({
      status: "sign-in-required",
      action: "sign-in-with-chatgpt",
    });
  });

  test("delegates ChatGPT login to app-server and returns only an official OpenAI auth URL", async () => {
    const server = new FakeCodexAppServer();
    const provider = await createCodexAgentProvider(async () => available(server));

    await expect(provider.startChatGptLogin()).resolves.toEqual({
      loginId: "login-1",
      authorizationUrl: "https://auth.openai.com/oauth/authorize?state=opaque",
    });
    expect(server.requests.at(-1)).toEqual({
      method: "account/login/start",
      params: { type: "chatgpt" },
    });

    server.loginResponse = {
      type: "chatgpt",
      loginId: "bad-login",
      authUrl: "http://auth.openai.com/unsafe",
    };
    await expect(provider.startChatGptLogin()).rejects.toThrow("official OpenAI");

    server.loginResponse = {
      type: "chatgpt",
      loginId: "attacker-login",
      authUrl: "https://attacker.example/oauth/authorize",
    };
    await expect(provider.startChatGptLogin()).rejects.toThrow("official OpenAI");
  });

  test("refreshes to authenticated state on official login completion and account updates", async () => {
    const server = new FakeCodexAppServer();
    const provider = await createCodexAgentProvider(async () => available(server));
    await provider.startChatGptLogin();
    server.account = { type: "chatgpt", email: "member@example.com", planType: "plus" };

    await server.emit({
      method: "account/login/completed",
      params: { loginId: "login-1", success: true, error: null },
    });
    expect(provider.state).toEqual({
      status: "authenticated",
      account: { type: "chatgpt", email: "member@example.com", planType: "plus" },
    });

    server.account = { type: "chatgpt", email: null, planType: "pro" };
    await server.emit({
      method: "account/updated",
      params: { authMode: "chatgpt", planType: "pro" },
    });
    expect(provider.state).toEqual({
      status: "authenticated",
      account: { type: "chatgpt", email: null, planType: "pro" },
    });
  });

  test("sends only user-approved masked facts/citation IDs and returns immutable suggestions", async () => {
    const server = new FakeCodexAppServer();
    server.account = { type: "chatgpt", email: null, planType: "plus" };
    const provider = await createCodexAgentProvider(async () => available(server));
    const caseState = { claimantName: "홍길동", status: "draft" };
    const redactor = new Redactor(new Uint8Array(32).fill(0x31));
    const maskedFact = redactor.redactStructured("case-1", "신청인은 홍길동이다.", {
      personName: [caseState.claimantName],
    });
    const approvedInput = createUserApprovedSuggestionInput(
      [{ id: "fact-1", text: maskedFact }],
      ["cite-1"],
    );

    const suggestion = await provider.suggest(approvedInput);

    const threadRequest = server.requests.find((request) => request.method === "thread/start");
    const turnRequest = server.requests.find((request) => request.method === "turn/start");
    expect(threadRequest).toEqual({
      method: "thread/start",
      params: {
        ephemeral: true,
        approvalPolicy: "never",
        sandbox: "read-only",
      },
    });
    expect(JSON.stringify(turnRequest)).toMatch(/신청인은 \[PERSON_[A-Z0-9]{16}\]이다\./);
    expect(JSON.stringify(turnRequest)).toContain("cite-1");
    expect(JSON.stringify(turnRequest)).not.toContain("uniqueItems");
    expect(JSON.stringify(server.requests)).not.toContain("홍길동");
    expect(JSON.stringify(server.requests)).not.toContain("accessToken");
    expect(JSON.stringify(server.requests)).not.toContain("apiKey");
    expect(suggestion).toEqual({ text: "제출 전 날짜를 확인하세요.", citationIds: ["cite-1"] });
    expect(Object.isFrozen(suggestion)).toBe(true);
    expect(Object.isFrozen(suggestion.citationIds)).toBe(true);
    expect(caseState).toEqual({ claimantName: "홍길동", status: "draft" });
    expect("accessToken" in provider).toBe(false);
    expect("apiKey" in provider).toBe(false);
  });
});
