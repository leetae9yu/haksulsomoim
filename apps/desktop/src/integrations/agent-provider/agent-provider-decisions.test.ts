import { describe, expect, test } from "bun:test";
import type {
  ApprovedAgentDecisionContext,
  CodexAppServerConnection,
  CodexAppServerNotification,
  CodexAppServerRequest,
  CodexAppServerStartResult,
} from "./agent-provider";

type RequestWaiter = Readonly<{
  method: CodexAppServerRequest["method"];
  occurrence: number;
  resolve(request: CodexAppServerRequest): void;
}>;

class EventCodexServer implements CodexAppServerConnection {
  readonly requests: CodexAppServerRequest[] = [];
  readonly #listeners = new Set<
    (notification: CodexAppServerNotification) => void | Promise<void>
  >();
  readonly #waiters: RequestWaiter[] = [];
  #thread = 0;
  #turn = 0;

  async request(request: CodexAppServerRequest): Promise<unknown> {
    this.requests.push(structuredClone(request));
    const matching = this.requests.filter((item) => item.method === request.method);
    const waiters = this.#waiters.filter(
      (candidate) => candidate.method === request.method && candidate.occurrence <= matching.length,
    );
    for (const waiter of waiters) {
      this.#waiters.splice(this.#waiters.indexOf(waiter), 1);
      const matched = matching[waiter.occurrence - 1];
      if (matched !== undefined) waiter.resolve(matched);
    }
    if (request.method === "account/read") {
      return { account: { type: "chatgpt", email: null, planType: "plus" } };
    }
    if (request.method === "thread/start") return { thread: { id: `thread-${++this.#thread}` } };
    if (request.method === "turn/start") return { turn: { id: `turn-${++this.#turn}` } };
    return {};
  }

  notify(_method: "initialized"): void {}
  async close(): Promise<void> {}

  onNotification(
    listener: (notification: CodexAppServerNotification) => void | Promise<void>,
  ): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  waitFor(method: CodexAppServerRequest["method"], occurrence = 1): Promise<CodexAppServerRequest> {
    const found = this.requests.filter((request) => request.method === method)[occurrence - 1];
    if (found !== undefined) return Promise.resolve(found);
    return new Promise((resolve) => this.#waiters.push({ method, occurrence, resolve }));
  }

  async complete(threadId: string, turnId: string, text: string, status = "completed") {
    await this.emit({
      method: "item/completed",
      params: { threadId, turnId, item: { id: `item-${turnId}`, type: "agentMessage", text } },
    });
    await this.emit({
      method: "turn/completed",
      params: { threadId, turn: { id: turnId, status, error: null } },
    });
  }

  async emit(notification: CodexAppServerNotification): Promise<void> {
    await Promise.all([...this.#listeners].map((listener) => listener(notification)));
  }
}

class ManualTimer {
  #callback: (() => void) | undefined;
  readonly scheduled: Promise<void>;
  readonly #resolveScheduled: () => void;

  constructor() {
    let resolveScheduled: () => void = () => {};
    this.scheduled = new Promise((resolve) => {
      resolveScheduled = resolve;
    });
    this.#resolveScheduled = resolveScheduled;
  }

  setTimeout(callback: () => void, _milliseconds: number): number {
    this.#callback = callback;
    this.#resolveScheduled();
    return 1;
  }

  clearTimeout(_handle: unknown): void {
    this.#callback = undefined;
  }

  expire(): void {
    const callback = this.#callback;
    this.#callback = undefined;
    callback?.();
  }
}

const ready = (server: EventCodexServer): CodexAppServerStartResult => ({
  status: "ready",
  connection: server,
});

const approvedContext = Object.freeze({
  approval: "user-approved",
  contextDigest: "a".repeat(64),
  goal: { kind: "civil-recovery", caseId: "case-1", objective: "prepare-civil-demand" },
  maskedFacts: Object.freeze([{ id: "fact-1", text: "송금인은 [PERSON_0123456789ABCDEF]입니다." }]),
  citationIds: Object.freeze(["cite-1"]),
  observations: Object.freeze([]),
}) as unknown as ApprovedAgentDecisionContext;

const decision = (decisionId: string, toolCallId: string) =>
  JSON.stringify({
    kind: "tool",
    decisionId,
    toolCall: { toolName: "read-official-law-detail", toolCallId, citationId: "cite-1" },
  });

describe("structured Codex agent decisions", () => {
  test("returns one typed next decision from approved masked context", async () => {
    const server = new EventCodexServer();
    const { createCodexAgentProvider } = await import("./agent-provider");
    const provider = await createCodexAgentProvider(async () => ready(server));

    const resultPromise = provider.nextDecision(approvedContext);
    const request = await server.waitFor("turn/start");
    await server.complete("thread-1", "turn-1", decision("decision-1", "tool-1"));

    await expect(resultPromise as Promise<unknown>).resolves.toEqual({
      kind: "tool",
      decisionId: "decision-1",
      toolCall: {
        toolName: "read-official-law-detail",
        toolCallId: "tool-1",
        citationId: "cite-1",
      },
    });
    expect(request.params).toMatchObject({
      threadId: "thread-1",
      outputSchema: { type: "object" },
    });
    expect(JSON.stringify(request)).toContain("[PERSON_0123456789ABCDEF]");
    expect(JSON.stringify(request)).not.toContain("dynamicTools");
  });

  test("interrupts a timed-out turn and ignores late completion", async () => {
    const server = new EventCodexServer();
    const timer = new ManualTimer();
    const { createCodexAgentProvider } = await import("./agent-provider");
    const provider = await createCodexAgentProvider(async () => ready(server), { timer });

    const timedOut = provider.nextDecision(approvedContext);
    await server.waitFor("turn/start");
    await timer.scheduled;
    timer.expire();
    const interrupt = await server.waitFor("turn/interrupt");
    expect(interrupt.params).toEqual({ threadId: "thread-1", turnId: "turn-1" });
    await expect(timedOut).rejects.toThrow("Timed out waiting for Codex turn completion");

    const replacement = provider.nextDecision(approvedContext);
    await server.waitFor("turn/start", 2);
    let replacementSettled = false;
    void replacement.finally(() => {
      replacementSettled = true;
    });
    await server.complete("thread-1", "turn-1", decision("late-decision", "late-tool"));
    await Promise.resolve();
    expect(replacementSettled).toBe(false);

    await server.complete("thread-2", "turn-2", decision("decision-2", "tool-2"));
    await expect(replacement).resolves.toMatchObject({ decisionId: "decision-2" });
  });

  test("rejects malformed decisions and non-completed turns", async () => {
    const malformed = [
      {
        label: "unknown tool",
        value: {
          kind: "tool",
          decisionId: "decision-1",
          toolCall: { toolName: "shell", toolCallId: "tool-1" },
        },
      },
      {
        label: "extra key",
        value: {
          kind: "finish",
          decisionId: "decision-1",
          outcome: { kind: "completed", summaryDigest: "b".repeat(64) },
          extra: true,
        },
      },
      {
        label: "unapproved citation",
        value: {
          kind: "tool",
          decisionId: "decision-1",
          toolCall: {
            toolName: "read-official-law-detail",
            toolCallId: "tool-1",
            citationId: "cite-2",
          },
        },
      },
      {
        label: "duplicate IDs",
        value: {
          kind: "tool",
          decisionId: "same-id",
          toolCall: { toolName: "inspect-masked-case", toolCallId: "same-id" },
        },
      },
    ];
    for (const item of malformed) {
      const server = new EventCodexServer();
      const { createCodexAgentProvider } = await import("./agent-provider");
      const provider = await createCodexAgentProvider(async () => ready(server));
      const pending = provider.nextDecision(approvedContext);
      await server.waitFor("turn/start");
      await server.complete("thread-1", "turn-1", JSON.stringify(item.value));
      await expect(pending, item.label).rejects.toThrow(/invalid|approve|duplicate/);
      await provider.dispose();
    }

    const server = new EventCodexServer();
    const { createCodexAgentProvider } = await import("./agent-provider");
    const provider = await createCodexAgentProvider(async () => ready(server));
    const failed = provider.nextDecision(approvedContext);
    await server.waitFor("turn/start");
    await server.complete("thread-1", "turn-1", decision("decision-1", "tool-1"), "failed");
    await expect(failed).rejects.toThrow("did not complete successfully");
  });

  test("disposal rejects active work without exposing provider details", async () => {
    const server = new EventCodexServer();
    const timer = new ManualTimer();
    const { createCodexAgentProvider } = await import("./agent-provider");
    const provider = await createCodexAgentProvider(async () => ready(server), { timer });
    const pending = provider.nextDecision(approvedContext);
    await server.waitFor("turn/start");
    await timer.scheduled;
    await provider.dispose();
    await expect(pending).rejects.toThrow("provider was disposed");
    expect(server.requests.at(-1)).toMatchObject({
      method: "turn/interrupt",
      params: { threadId: "thread-1", turnId: "turn-1" },
    });
  });
});
