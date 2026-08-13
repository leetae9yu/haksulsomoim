import { describe, expect, test } from "bun:test";
import type {
  ApprovedAgentDecisionContext,
  CodexAppServerConnection,
  CodexAppServerNotification,
  CodexAppServerRequest,
  CodexAppServerStartResult,
} from "./agent-provider";

class CorrelationServer implements CodexAppServerConnection {
  readonly requests: CodexAppServerRequest[] = [];
  readonly #listeners = new Set<
    (notification: CodexAppServerNotification) => void | Promise<void>
  >();
  readonly #turnWaiters: Array<() => void> = [];
  #thread = 0;
  #turn = 0;

  async request(request: CodexAppServerRequest): Promise<unknown> {
    this.requests.push(structuredClone(request));
    if (request.method === "account/read") {
      return { account: { type: "chatgpt", email: null, planType: "plus" } };
    }
    if (request.method === "thread/start") return { thread: { id: `thread-${++this.#thread}` } };
    if (request.method === "turn/start") {
      const result = { turn: { id: `turn-${++this.#turn}` } };
      this.#turnWaiters.shift()?.();
      return result;
    }
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

  waitForTurn(occurrence: number): Promise<void> {
    const count = this.requests.filter((request) => request.method === "turn/start").length;
    if (count >= occurrence) return Promise.resolve();
    return new Promise((resolve) => this.#turnWaiters.push(resolve));
  }

  async emit(params: Record<string, unknown>): Promise<void> {
    await this.notifyListeners({ method: "item/completed", params });
  }

  async complete(threadId: string, turnId: string): Promise<void> {
    await this.notifyListeners({
      method: "turn/completed",
      params: { threadId, turn: { id: turnId, status: "completed", error: null } },
    });
  }

  async notifyListeners(notification: CodexAppServerNotification): Promise<void> {
    await Promise.all([...this.#listeners].map((listener) => listener(notification)));
  }
}

const ready = (server: CorrelationServer): CodexAppServerStartResult => ({
  status: "ready",
  connection: server,
});
const context = {
  approval: "user-approved",
  contextDigest: "a".repeat(64),
  goal: { kind: "civil-recovery", caseId: "case-1", objective: "prepare-civil-demand" },
  maskedFacts: [{ id: "fact-1", text: "[PERSON_0123456789ABCDEF]" }],
  citationIds: ["cite-1"],
  observations: [],
} as unknown as ApprovedAgentDecisionContext;
const message = (id: string) => ({
  id: `item-${id}`,
  type: "agentMessage",
  text: JSON.stringify({
    kind: "tool",
    decisionId: `decision-${id}`,
    toolCall: { toolName: "inspect-masked-case", toolCallId: `tool-${id}` },
  }),
});

async function emitMalformedItems(server: CorrelationServer, threadId: string, turnId: string) {
  await server.emit({ threadId, item: message("missing-turn") });
  await server.emit({ turnId, item: message("missing-thread") });
  await server.emit({ threadId: "wrong-thread", turnId, item: message("wrong-thread") });
  await server.emit({ threadId, turnId: "wrong-turn", item: message("wrong-turn") });
  await server.emit({ threadId: "", turnId, item: message("empty-thread") });
  await server.emit({ threadId, turnId: "", item: message("empty-turn") });
}

describe("Codex decision notification correlation", () => {
  test("rejects item completion without matching thread and turn identifiers", async () => {
    const server = new CorrelationServer();
    const { createCodexAgentProvider } = await import("./agent-provider");
    const provider = await createCodexAgentProvider(async () => ready(server));

    const first = provider.nextDecision(context);
    await server.waitForTurn(1);
    await emitMalformedItems(server, "thread-1", "turn-1");
    await server.complete("thread-1", "turn-1");
    await expect(first).rejects.toThrow("without a structured Agent decision");

    const replacement = provider.nextDecision(context);
    await server.waitForTurn(2);
    await server.emit({ threadId: "thread-1", turnId: "turn-1", item: message("late") });
    await emitMalformedItems(server, "thread-2", "turn-2");
    await server.complete("thread-2", "turn-2");
    await expect(replacement).rejects.toThrow("without a structured Agent decision");

    const valid = provider.nextDecision(context);
    await server.waitForTurn(3);
    await server.emit({ threadId: "thread-3", turnId: "turn-3", item: message("valid") });
    await server.complete("thread-3", "turn-3");
    await expect(valid).resolves.toMatchObject({ decisionId: "decision-valid" });
  });
});
