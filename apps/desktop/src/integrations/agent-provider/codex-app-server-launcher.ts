import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type {
  CodexAppServerConnection,
  CodexAppServerLauncher,
  CodexAppServerNotification,
  CodexAppServerRequest,
} from "./agent-provider";

export interface CodexJsonLineProcess {
  send(line: string): void;
  onLine(listener: (line: string) => void): () => void;
  onExit(listener: (error?: Error) => void): () => void;
  close(): void;
}

export type CodexProcessFactory = (
  command: string,
  args: readonly string[],
) => Promise<CodexJsonLineProcess>;

export interface LaunchCodexAppServerOptions {
  command?: string;
  processFactory?: CodexProcessFactory;
}

type PendingRequest = Readonly<{
  resolve(value: unknown): void;
  reject(error: Error): void;
}>;

const NOTIFICATION_METHODS = new Set<CodexAppServerNotification["method"]>([
  "account/login/completed",
  "account/updated",
  "item/completed",
  "turn/completed",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotification(value: Record<string, unknown>): value is {
  method: CodexAppServerNotification["method"];
  params: unknown;
} {
  return typeof value.method === "string" && NOTIFICATION_METHODS.has(value.method as never);
}

class JsonLineConnection implements CodexAppServerConnection {
  readonly #process: CodexJsonLineProcess;
  readonly #pending = new Map<number, PendingRequest>();
  readonly #listeners = new Set<
    (notification: CodexAppServerNotification) => void | Promise<void>
  >();
  #nextId = 1;
  #closed = false;
  readonly #removeLineListener: () => void;
  readonly #removeExitListener: () => void;

  constructor(process: CodexJsonLineProcess) {
    this.#process = process;
    this.#removeLineListener = process.onLine((line) => this.#handleLine(line));
    this.#removeExitListener = process.onExit((error) => this.#handleExit(error));
  }

  request(request: CodexAppServerRequest): Promise<unknown> {
    if (this.#closed) return Promise.reject(new Error("Codex app-server connection is closed"));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      try {
        this.#process.send(`${JSON.stringify({ id, ...request })}\n`);
      } catch (error) {
        this.#pending.delete(id);
        reject(error instanceof Error ? error : new Error("Failed to write to Codex app-server"));
      }
    });
  }

  notify(method: "initialized"): void {
    if (this.#closed) throw new Error("Codex app-server connection is closed");
    this.#process.send(`${JSON.stringify({ method })}\n`);
  }

  onNotification(
    listener: (notification: CodexAppServerNotification) => void | Promise<void>,
  ): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#removeLineListener();
    this.#removeExitListener();
    this.#rejectPending(new Error("Codex app-server connection closed"));
    this.#process.close();
  }

  #handleLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (!isRecord(message)) return;

    if (typeof message.id === "number") {
      const pending = this.#pending.get(message.id);
      if (pending === undefined) return;
      this.#pending.delete(message.id);
      if (isRecord(message.error)) {
        const detail =
          typeof message.error.message === "string"
            ? message.error.message
            : "Codex app-server request failed";
        pending.reject(new Error(detail));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (isNotification(message)) {
      const notification = Object.freeze({ method: message.method, params: message.params });
      for (const listener of this.#listeners) void listener(notification);
    }
  }

  #handleExit(error?: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#removeLineListener();
    this.#removeExitListener();
    this.#rejectPending(error ?? new Error("Codex app-server exited"));
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}

async function spawnCodexProcess(
  command: string,
  args: readonly string[],
): Promise<CodexJsonLineProcess> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const handleError = (error: Error) => reject(error);
    child.once("error", handleError);
    child.once("spawn", () => {
      child.off("error", handleError);
      const lines = createInterface({ input: child.stdout });
      const lineListeners = new Set<(line: string) => void>();
      const exitListeners = new Set<(error?: Error) => void>();
      lines.on("line", (line) => {
        for (const listener of lineListeners) listener(line);
      });
      child.once("error", (error) => {
        for (const listener of exitListeners) listener(error);
      });
      child.once("exit", () => {
        for (const listener of exitListeners) listener();
      });
      child.stderr.resume();
      resolve({
        send(line) {
          if (!child.stdin.write(line)) {
            throw new Error("Codex app-server stdin is not writable");
          }
        },
        onLine(listener) {
          lineListeners.add(listener);
          return () => lineListeners.delete(listener);
        },
        onExit(listener) {
          exitListeners.add(listener);
          return () => exitListeners.delete(listener);
        },
        close() {
          lines.close();
          child.stdin.end();
          if (!child.killed) child.kill();
        },
      });
    });
  });
}

export const launchCodexAppServer = (
  options: LaunchCodexAppServerOptions = {},
): ReturnType<CodexAppServerLauncher> => {
  const command = options.command ?? "codex";
  const processFactory = options.processFactory ?? spawnCodexProcess;
  return processFactory(command, ["app-server", "--stdio"])
    .then((process) => ({
      status: "ready" as const,
      connection: new JsonLineConnection(process),
    }))
    .catch((error: unknown) => {
      if (isRecord(error) && error.code === "ENOENT") {
        return {
          status: "binary-unavailable" as const,
          reason: "The official Codex app-server binary is unavailable",
        };
      }
      throw error;
    });
};
