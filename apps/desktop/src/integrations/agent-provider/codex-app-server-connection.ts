import type {
  CodexAppServerConnection,
  CodexAppServerNotification,
  CodexAppServerRequest,
  CodexJsonLineProcess,
} from "./codex-app-server-protocol";

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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNotification = (
  value: Record<string, unknown>,
): value is {
  method: CodexAppServerNotification["method"];
  params: unknown;
} => typeof value.method === "string" && NOTIFICATION_METHODS.has(value.method as never);

export class JsonLineConnection implements CodexAppServerConnection {
  readonly #process: CodexJsonLineProcess;
  readonly #pending = new Map<number, PendingRequest>();
  readonly #listeners = new Set<
    (notification: CodexAppServerNotification) => void | Promise<void>
  >();
  #nextId = 1;
  #closed = false;
  readonly #removeLineListener: () => void;
  readonly #removeExitListener: () => void;
  readonly #sanitizeError: (message: string) => string;
  readonly #reportNotificationError: (error: Error) => void;

  constructor(
    process: CodexJsonLineProcess,
    sanitizeError: (message: string) => string,
    reportNotificationError: (error: Error) => void,
  ) {
    this.#process = process;
    this.#sanitizeError = sanitizeError;
    this.#reportNotificationError = reportNotificationError;
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
        reject(
          error instanceof Error
            ? new Error(this.#sanitizeError(error.message))
            : new Error("Failed to write to Codex app-server"),
        );
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

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#removeLineListener();
    this.#removeExitListener();
    this.#rejectPending(new Error("Codex app-server connection closed"));
    await this.#process.close();
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
      this.#handleResponse(message);
      return;
    }
    if (!isNotification(message)) return;
    const notification = Object.freeze({ method: message.method, params: message.params });
    for (const listener of this.#listeners) {
      void Promise.resolve()
        .then(() => listener(notification))
        .catch((error: unknown) => {
          const detail =
            error instanceof Error ? error.message : "Codex notification listener failed";
          this.#reportNotificationError(new Error(this.#sanitizeError(detail)));
        });
    }
  }

  #handleResponse(message: Record<string, unknown>): void {
    const id = message.id;
    if (typeof id !== "number") return;
    const pending = this.#pending.get(id);
    if (pending === undefined) return;
    this.#pending.delete(id);
    if (isRecord(message.error)) {
      const detail =
        typeof message.error.message === "string"
          ? message.error.message
          : "Codex app-server request failed";
      pending.reject(new Error(this.#sanitizeError(detail)));
      return;
    }
    pending.resolve(message.result);
  }

  #handleExit(error?: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#removeLineListener();
    this.#removeExitListener();
    this.#rejectPending(
      error === undefined
        ? new Error("Codex app-server exited")
        : new Error(this.#sanitizeError(error.message)),
    );
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}
