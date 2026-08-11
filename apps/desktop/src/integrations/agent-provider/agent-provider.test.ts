import { describe, expect, test } from "bun:test";
import {
  type CodexAppServerConnection,
  type CodexAppServerNotification,
  type CodexAppServerRequest,
  type CodexAppServerStartResult,
  createCodexAgentProvider,
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

  close(): void {}

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

  test("delegates ChatGPT login to app-server and returns only an HTTPS browser URL", async () => {
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
    await expect(provider.startChatGptLogin()).rejects.toThrow("HTTPS");
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

    await expect(
      provider.suggest({
        approval: "pending",
        maskedFacts: [{ id: "fact-1", text: "신청인은 [이름]이다." }],
        citationIds: ["cite-1"],
      }),
    ).rejects.toThrow("user-approved");

    const suggestion = await provider.suggest({
      approval: "user-approved",
      maskedFacts: [{ id: "fact-1", text: "신청인은 [이름]이다." }],
      citationIds: ["cite-1"],
    });

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
    expect(JSON.stringify(turnRequest)).toContain("신청인은 [이름]이다.");
    expect(JSON.stringify(turnRequest)).toContain("cite-1");
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
