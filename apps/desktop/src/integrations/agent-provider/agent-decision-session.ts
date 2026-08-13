import type { AgentDecision } from "../../main/agent/agent-contracts";
import {
  AGENT_DECISION_OUTPUT_SCHEMA,
  type ApprovedAgentDecisionContext,
  parseAgentDecision,
  parseApprovedDecisionContext,
} from "./agent-decision-contracts";
import type {
  CodexAppServerConnection,
  CodexAppServerNotification,
} from "./codex-app-server-protocol";

export interface ProviderTimer {
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
}

export type AgentDecisionSessionOptions = Readonly<{
  timer: ProviderTimer;
  deadlineMs: number;
}>;

export const systemTimer: ProviderTimer = {
  setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

type PendingTurn = {
  readonly token: symbol;
  readonly threadId: string;
  turnId?: string;
  agentMessage?: string;
  timerHandle?: unknown;
  readonly queued: CodexAppServerNotification[];
  readonly resolve: (decision: AgentDecision) => void;
  readonly reject: (error: Error) => void;
  readonly unsubscribe: () => void;
};

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export class AgentDecisionSession {
  readonly #connection: CodexAppServerConnection;
  readonly #timer: ProviderTimer;
  readonly #deadlineMs: number;
  #active: PendingTurn | undefined;
  #disposed = false;

  constructor(connection: CodexAppServerConnection, options: AgentDecisionSessionOptions) {
    this.#connection = connection;
    this.#timer = options.timer;
    this.#deadlineMs = options.deadlineMs;
  }

  async nextDecision(input: ApprovedAgentDecisionContext): Promise<AgentDecision> {
    if (this.#disposed) throw new Error("Codex agent provider is disposed");
    if (this.#active !== undefined) throw new Error("A Codex Agent turn is already active");
    const context = parseApprovedDecisionContext(input);
    const thread = await this.#safeRequest({
      method: "thread/start",
      params: { ephemeral: true, approvalPolicy: "never", sandbox: "read-only" },
    });
    if (!record(thread) || !record(thread.thread) || typeof thread.thread.id !== "string") {
      throw new Error("Codex app-server returned an invalid thread");
    }
    const threadId = thread.thread.id;
    let resolveDecision: (decision: AgentDecision) => void = () => undefined;
    let rejectDecision: (error: Error) => void = () => undefined;
    const completion = new Promise<AgentDecision>((resolve, reject) => {
      resolveDecision = resolve;
      rejectDecision = reject;
    });
    const token = Symbol("codex-turn");
    const unsubscribe = this.#connection.onNotification((event) =>
      this.#consumeNotification(token, event, context),
    );
    const pending: PendingTurn = {
      token,
      threadId,
      queued: [],
      resolve: resolveDecision,
      reject: rejectDecision,
      unsubscribe,
    };
    this.#active = pending;

    try {
      const prompt = JSON.stringify({
        context: {
          approval: context.approval,
          contextDigest: context.contextDigest,
          goal: context.goal,
          maskedFacts: context.maskedFacts,
          citationIds: context.citationIds,
          observations: context.observations,
        },
        request: "Return exactly one next AgentDecision for this approved masked projection.",
      });
      const response = await this.#safeRequest({
        method: "turn/start",
        params: {
          threadId,
          input: [{ type: "text", text: prompt }],
          outputSchema: AGENT_DECISION_OUTPUT_SCHEMA,
        },
      });
      if (!record(response) || !record(response.turn) || typeof response.turn.id !== "string") {
        throw new Error("Codex app-server returned an invalid turn");
      }
      if (this.#active?.token !== token) return completion;
      pending.turnId = response.turn.id;
      for (const notification of pending.queued.splice(0)) {
        this.#consumeNotification(token, notification, context);
      }
      if (this.#active?.token === token) {
        pending.timerHandle = this.#timer.setTimeout(() => this.#timeout(token), this.#deadlineMs);
      }
    } catch (error) {
      if (this.#active?.token === token) this.#settleReject(pending, this.#publicError(error));
    }
    return completion;
  }

  async interrupt(): Promise<void> {
    const pending = this.#active;
    if (pending?.turnId === undefined) return;
    await this.#safeRequest({
      method: "turn/interrupt",
      params: { threadId: pending.threadId, turnId: pending.turnId },
    });
  }

  dispose(): void {
    this.#disposed = true;
    const pending = this.#active;
    if (pending === undefined) return;
    if (pending.turnId !== undefined) {
      void this.#connection
        .request({
          method: "turn/interrupt",
          params: { threadId: pending.threadId, turnId: pending.turnId },
        })
        .catch(() => undefined);
    }
    this.#settleReject(pending, new Error("Codex agent provider was disposed"));
  }

  #consumeNotification(
    token: symbol,
    notification: CodexAppServerNotification,
    context: ReturnType<typeof parseApprovedDecisionContext>,
  ): void {
    const pending = this.#active;
    if (pending?.token !== token || !record(notification.params)) return;
    if (notification.params.threadId !== pending.threadId) return;
    if (pending.turnId === undefined) {
      if (notification.method === "item/completed" || notification.method === "turn/completed") {
        pending.queued.push(notification);
      }
      return;
    }
    if (
      notification.params.threadId !== pending.threadId ||
      ("turnId" in notification.params && notification.params.turnId !== pending.turnId)
    ) {
      return;
    }
    if (notification.method === "item/completed") {
      const item = notification.params.item;
      if (record(item) && item.type === "agentMessage" && typeof item.text === "string") {
        pending.agentMessage = item.text;
      }
      return;
    }
    if (notification.method !== "turn/completed") return;
    const turn = notification.params.turn;
    if (!record(turn) || turn.id !== pending.turnId || turn.status !== "completed") {
      this.#settleReject(pending, new Error("Codex turn did not complete successfully"));
      return;
    }
    if (pending.agentMessage === undefined) {
      this.#settleReject(pending, new Error("Codex completed without a structured Agent decision"));
      return;
    }
    try {
      this.#settleResolve(pending, parseAgentDecision(pending.agentMessage, context));
    } catch (error) {
      this.#settleReject(pending, this.#publicError(error));
    }
  }

  #timeout(token: symbol): void {
    const pending = this.#active;
    if (pending?.token !== token || pending.turnId === undefined) return;
    void this.#connection
      .request({
        method: "turn/interrupt",
        params: { threadId: pending.threadId, turnId: pending.turnId },
      })
      .catch(() => undefined);
    this.#settleReject(pending, new Error("Timed out waiting for Codex turn completion"));
  }

  #settleResolve(pending: PendingTurn, decision: AgentDecision): void {
    this.#cleanup(pending);
    pending.resolve(decision);
  }

  #settleReject(pending: PendingTurn, error: Error): void {
    this.#cleanup(pending);
    pending.reject(error);
  }

  #cleanup(pending: PendingTurn): void {
    if (pending.timerHandle !== undefined) this.#timer.clearTimeout(pending.timerHandle);
    pending.unsubscribe();
    if (this.#active?.token === pending.token) this.#active = undefined;
  }

  async #safeRequest(request: Parameters<CodexAppServerConnection["request"]>[0]) {
    try {
      return await this.#connection.request(request);
    } catch {
      throw new Error("Codex app-server request failed");
    }
  }

  #publicError(error: unknown): Error {
    return error instanceof Error
      ? new Error(error.message)
      : new Error("Codex app-server request failed");
  }
}
