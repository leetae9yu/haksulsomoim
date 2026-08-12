import { describe, expect, test } from "bun:test";
import type { CodexAppServerNotification } from "./agent-provider";
import { type CodexJsonLineProcess, launchCodexAppServer } from "./codex-app-server-launcher";

class FakeCodexProcess implements CodexJsonLineProcess {
  readonly sent: string[] = [];
  #lineListeners = new Set<(line: string) => void>();
  #exitListeners = new Set<(error?: Error) => void>();
  closed = false;

  send(line: string): void {
    this.sent.push(line);
  }

  onLine(listener: (line: string) => void): () => void {
    this.#lineListeners.add(listener);
    return () => this.#lineListeners.delete(listener);
  }

  onExit(listener: (error?: Error) => void): () => void {
    this.#exitListeners.add(listener);
    return () => this.#exitListeners.delete(listener);
  }

  emit(value: unknown): void {
    const line = JSON.stringify(value);
    for (const listener of this.#lineListeners) listener(line);
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const listener of this.#exitListeners) listener();
  }
}

describe("Codex app-server launcher", () => {
  test("returns typed unavailable state when the official binary cannot start", async () => {
    const result = await launchCodexAppServer({
      command: "/opt/haksulsomoim/missing-codex",
      processFactory: async () => {
        const error = new Error("spawn missing-codex ENOENT");
        Object.assign(error, { code: "ENOENT" });
        throw error;
      },
    });

    expect(result).toEqual({
      status: "binary-unavailable",
      reason: "The official Codex app-server binary is unavailable",
    });
  });

  test("resolves the packaged executable and launches with an allowlisted environment", async () => {
    const process = new FakeCodexProcess();
    let invocation:
      | { command: string; args: readonly string[]; env: Readonly<Record<string, string>> }
      | undefined;
    const started = await launchCodexAppServer({
      resolveExecutable: () => "/opt/haksulsomoim/codex",
      environment: {
        HOME: "/home/member",
        PATH: "/attacker-controlled",
        LAW_OC: "law-secret-that-must-not-leak",
        OPENAI_API_KEY: "also-must-not-leak",
      },
      processFactory: async (command, args, env) => {
        invocation = { command, args, env };
        return process;
      },
    });

    expect(started.status).toBe("ready");
    expect(invocation).toEqual({
      command: "/opt/haksulsomoim/codex",
      args: ["app-server", "--stdio"],
      env: { HOME: "/home/member" },
    });
  });

  test("handles rejected async notification listeners without an unhandled rejection", async () => {
    const process = new FakeCodexProcess();
    let report!: (error: Error) => void;
    const reported = new Promise<Error>((resolve) => {
      report = resolve;
    });
    const started = await launchCodexAppServer({
      command: "/opt/haksulsomoim/codex",
      processFactory: async () => process,
      onNotificationError: report,
    });
    if (started.status !== "ready") throw new Error("Expected ready Codex app-server");
    started.connection.onNotification(async () => {
      throw new Error("notification failed");
    });

    process.emit({ method: "account/updated", params: {} });
    await expect(reported).resolves.toMatchObject({ message: "notification failed" });
  });

  test("awaits child close before connection disposal resolves", async () => {
    let finishClose!: () => void;
    const closeFinished = new Promise<void>((resolve) => {
      finishClose = resolve;
    });
    const process = new FakeCodexProcess();
    process.close = async () => {
      process.closed = true;
      await closeFinished;
    };
    const started = await launchCodexAppServer({
      command: "/opt/haksulsomoim/codex",
      processFactory: async () => process,
    });
    if (started.status !== "ready") throw new Error("Expected ready Codex app-server");

    let disposed = false;
    const disposal = started.connection.close().then(() => {
      disposed = true;
    });
    await Promise.resolve();
    expect(disposed).toBe(false);
    finishClose();
    await disposal;
    expect(disposed).toBe(true);
  });

  test("correlates JSONL responses, sanitizes server errors, and forwards notifications", async () => {
    const process = new FakeCodexProcess();
    const secret = "law-secret-that-must-not-leak";
    const started = await launchCodexAppServer({
      command: "/opt/haksulsomoim/codex",
      environment: { LAW_OC: secret },
      processFactory: async () => process,
    });
    expect(started.status).toBe("ready");
    if (started.status !== "ready") throw new Error("Expected ready Codex app-server");

    const notifications: CodexAppServerNotification[] = [];
    const unsubscribe = started.connection.onNotification((notification) => {
      notifications.push(notification);
    });
    const response = started.connection.request({
      method: "account/read",
      params: { refreshToken: false },
    });
    expect(process.sent).toEqual([
      `${JSON.stringify({
        id: 1,
        method: "account/read",
        params: { refreshToken: false },
      })}\n`,
    ]);

    process.emit({ id: 1, result: { account: null } });
    process.emit({ method: "account/updated", params: { authMode: "chatgpt" } });

    expect(await response).toEqual({ account: null });
    expect(notifications).toEqual([{ method: "account/updated", params: { authMode: "chatgpt" } }]);
    const rejected = started.connection.request({
      method: "account/read",
      params: { refreshToken: false },
    });
    process.emit({ id: 2, error: { message: `server echoed ${secret}` } });
    await expect(rejected).rejects.toThrow("server echoed [REDACTED]");

    unsubscribe();
    started.connection.notify("initialized");
    expect(process.sent.at(-1)).toBe(`${JSON.stringify({ method: "initialized" })}\n`);
  });
});
