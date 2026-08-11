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

  close(): void {
    this.closed = true;
    for (const listener of this.#exitListeners) listener();
  }
}

describe("Codex app-server launcher", () => {
  test("returns typed unavailable state when the official binary cannot start", async () => {
    const result = await launchCodexAppServer({
      command: "missing-codex",
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

  test("correlates JSONL responses and forwards account notifications", async () => {
    const process = new FakeCodexProcess();
    const started = await launchCodexAppServer({
      command: "codex",
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
    unsubscribe();
    started.connection.notify("initialized");
    expect(process.sent.at(-1)).toBe(`${JSON.stringify({ method: "initialized" })}\n`);
  });
});
