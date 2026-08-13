import { awaitRuntimeDeadline, type RuntimeDeadlineTimer } from "./runtime-deadline";

export class LazyRuntimeIntegration<Resource> {
  readonly #factory: (signal: AbortSignal) => Promise<Resource>;
  readonly #cleanup: (resource: Resource) => Promise<void>;
  readonly #signal: AbortSignal;
  readonly #timer: RuntimeDeadlineTimer | undefined;
  readonly #deadlineMs: number;
  #source?: Promise<Resource>;
  #initialization?: Promise<Resource>;
  #cleanupPromise?: Promise<void>;
  #abandoned = false;

  constructor(
    options: Readonly<{
      factory: (signal: AbortSignal) => Promise<Resource>;
      cleanup: (resource: Resource) => Promise<void>;
      signal: AbortSignal;
      timer?: RuntimeDeadlineTimer | undefined;
      deadlineMs: number;
    }>,
  ) {
    this.#factory = options.factory;
    this.#cleanup = options.cleanup;
    this.#signal = options.signal;
    this.#timer = options.timer;
    this.#deadlineMs = options.deadlineMs;
  }

  get(): Promise<Resource> {
    if (this.#initialization !== undefined) return this.#initialization;
    this.#source = Promise.resolve().then(() => this.#factory(this.#signal));
    this.#source.then(
      (resource) => {
        if (this.#abandoned || this.#signal.aborted)
          void this.#cleanupOnce(resource).catch(() => undefined);
      },
      () => undefined,
    );
    this.#initialization = awaitRuntimeDeadline(this.#source, {
      phase: "integration-initialization",
      deadlineMs: this.#deadlineMs,
      timer: this.#timer,
      signal: this.#signal,
    });
    this.#initialization.catch(() => {
      this.#abandoned = true;
    });
    return this.#initialization;
  }

  async dispose(): Promise<void> {
    this.#abandoned = true;
    if (this.#source === undefined) return;
    let resource: Resource;
    try {
      resource = await this.#source;
    } catch {
      return;
    }
    await this.#cleanupOnce(resource);
  }

  #cleanupOnce(resource: Resource): Promise<void> {
    this.#cleanupPromise ??= this.#cleanup(resource);
    return this.#cleanupPromise;
  }
}
