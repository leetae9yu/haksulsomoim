export interface RuntimeDeadlineTimer {
  schedule(delayMs: number, callback: () => void): () => void;
}

export const systemRuntimeDeadlineTimer: RuntimeDeadlineTimer = {
  schedule(delayMs, callback) {
    const handle = setTimeout(callback, delayMs);
    return () => clearTimeout(handle);
  },
};

export class RuntimeDeadlineError extends Error {
  readonly code = "RUNTIME_DEADLINE_EXCEEDED";
  readonly phase: string;

  constructor(phase: string) {
    super(`Runtime deadline exceeded during ${phase}`);
    this.name = "RuntimeDeadlineError";
    this.phase = phase;
  }
}

export class RuntimeInitializationAbortedError extends Error {
  readonly code = "RUNTIME_INITIALIZATION_ABORTED";

  constructor() {
    super("Runtime initialization was aborted");
    this.name = "RuntimeInitializationAbortedError";
  }
}

export async function awaitRuntimeDisposal(
  operation: Promise<void>,
  options: Readonly<{
    phase: string;
    deadlineMs: number;
    timer?: RuntimeDeadlineTimer | undefined;
  }>,
): Promise<void> {
  try {
    await awaitRuntimeDeadline(operation, options);
  } catch (error) {
    if (error instanceof AggregateError) throw error;
    throw new AggregateError([error], "Runtime disposal failed");
  }
}

export function awaitRuntimeDeadline<T>(
  operation: Promise<T>,
  options: Readonly<{
    phase: string;
    deadlineMs: number;
    timer?: RuntimeDeadlineTimer | undefined;
    signal?: AbortSignal;
  }>,
): Promise<T> {
  const timer = options.timer ?? systemRuntimeDeadlineTimer;
  return new Promise<T>((resolve, reject) => {
    let finished = false;
    const finish = (settle: () => void) => {
      if (finished) return;
      finished = true;
      cancelDeadline();
      options.signal?.removeEventListener("abort", abort);
      settle();
    };
    const abort = () => finish(() => reject(new RuntimeInitializationAbortedError()));
    const cancelDeadline = timer.schedule(options.deadlineMs, () =>
      finish(() => reject(new RuntimeDeadlineError(options.phase))),
    );
    options.signal?.addEventListener("abort", abort, { once: true });
    operation.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
    if (options.signal?.aborted) abort();
  });
}
