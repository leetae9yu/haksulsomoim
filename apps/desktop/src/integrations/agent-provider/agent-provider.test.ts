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
  initializationError: Error | undefined;
  closed = false;
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
});
