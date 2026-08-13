export type AgentToolExecutionContext = Readonly<{
  signal: AbortSignal;
  deadline: number;
}>;

export interface AgentExecutionTimer {
  schedule(delayMs: number, callback: () => void): () => void;
}

export const systemExecutionTimer: AgentExecutionTimer = {
  schedule(delayMs, callback) {
    const handle = setTimeout(callback, delayMs);
    return () => clearTimeout(handle);
  },
};

export type AgentToolInterruption = "run-stopped" | "tool-timeout";
export type AgentToolExecutionOutcome<Result> =
  | Readonly<{ kind: "completed"; value: Result }>
  | Readonly<{ kind: "failed"; error: unknown }>
  | Readonly<{
      kind: "interrupted";
      reason: AgentToolInterruption;
      quarantined: boolean;
    }>;

export class AgentToolQuarantinedError extends Error {
  readonly code = "AGENT_TOOL_QUARANTINED";
  readonly caseId: string;
  readonly runId: string;

  constructor(caseId: string, runId: string) {
    super("An external Agent tool ignored cancellation and remains quarantined");
    this.name = "AgentToolQuarantinedError";
    this.caseId = caseId;
    this.runId = runId;
  }
}

export class AgentToolExecutionBoundary<Result> {
  readonly #abort = new AbortController();
  readonly #timer: AgentExecutionTimer;
  readonly #graceMs: number;
  readonly #outcome: Promise<AgentToolExecutionOutcome<Result>>;
  #resolve!: (outcome: AgentToolExecutionOutcome<Result>) => void;
  #cancelDeadline: () => void;
  #cancelGrace?: () => void;
  #interruption?: AgentToolInterruption;
  #finished = false;

  constructor(
    operation: (context: AgentToolExecutionContext) => Promise<Result>,
    options: Readonly<{
      timeoutMs: number;
      graceMs: number;
      timer: AgentExecutionTimer;
      parentSignal?: AbortSignal;
    }>,
  ) {
    this.#timer = options.timer;
    this.#graceMs = options.graceMs;
    this.#outcome = new Promise((resolve) => {
      this.#resolve = resolve;
    });
    const deadline = Date.now() + options.timeoutMs;
    this.#cancelDeadline = options.timer.schedule(options.timeoutMs, () =>
      this.interrupt("tool-timeout"),
    );
    const parentAbort = () => this.interrupt("run-stopped");
    options.parentSignal?.addEventListener("abort", parentAbort, { once: true });
    if (options.parentSignal?.aborted) parentAbort();
    let execution: Promise<Result>;
    try {
      execution = operation({ signal: this.#abort.signal, deadline });
    } catch (error) {
      execution = Promise.reject(error);
    }
    execution.then(
      (value) => this.#settle(value),
      (error) => this.#reject(error),
    );
    this.#outcome.then(() => options.parentSignal?.removeEventListener("abort", parentAbort));
  }

  get outcome(): Promise<AgentToolExecutionOutcome<Result>> {
    return this.#outcome;
  }

  interrupt(reason: AgentToolInterruption): Promise<AgentToolExecutionOutcome<Result>> {
    if (this.#finished || this.#interruption !== undefined) return this.#outcome;
    this.#interruption = reason;
    this.#cancelDeadline();
    this.#abort.abort(reason);
    this.#cancelGrace = this.#timer.schedule(this.#graceMs, () => {
      if (this.#finished) return;
      this.#finished = true;
      this.#resolve({ kind: "interrupted", reason, quarantined: true });
    });
    return this.#outcome;
  }

  #settle(value: Result): void {
    if (this.#finished) return;
    this.#finished = true;
    this.#cancelDeadline();
    this.#cancelGrace?.();
    this.#resolve(
      this.#interruption === undefined
        ? { kind: "completed", value }
        : { kind: "interrupted", reason: this.#interruption, quarantined: false },
    );
  }

  #reject(error: unknown): void {
    if (this.#finished) return;
    if (this.#interruption !== undefined) {
      this.#settle(undefined as Result);
      return;
    }
    this.#finished = true;
    this.#cancelDeadline();
    this.#resolve({ kind: "failed", error });
  }
}
