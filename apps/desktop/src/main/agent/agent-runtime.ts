import type { AgentRun } from "./agent-contracts";
import { AgentLoopRunner } from "./agent-loop-runner";
import type { AgentLoopRuntimeDependencies } from "./agent-loop-runtime";
import { AgentLoopService } from "./agent-loop-service";
import type { AgentLoopStartInput } from "./agent-loop-types";
import { AgentRunInvariantError, type AgentRunRepository } from "./agent-run-repository";
import type { AgentRuntimeExternalDependencies } from "./agent-runtime-composition";

export type AgentUnavailableReason = "provider-initialization" | "mcp-initialization";
export type AgentRuntimeResult =
  | Readonly<{ status: "completed"; run: AgentRun }>
  | Readonly<{ status: "unavailable"; reason: AgentUnavailableReason }>;

export type AgentResumeInput = Readonly<{
  caseId: string;
  runId: string;
  approvedContextDigest: string;
}>;

export interface DesktopAgentRuntime {
  openCase(caseId: string): Promise<
    Readonly<{
      contextDigest: string;
      interruptedRun?: AgentRun;
    }>
  >;
  start(input: AgentLoopStartInput): Promise<AgentRuntimeResult>;
  resume(input: AgentResumeInput): Promise<AgentRuntimeResult>;
  cancel(input: Readonly<{ caseId: string; runId: string }>): Promise<AgentRun>;
  dispose(): Promise<void>;
}

type TrackedTask = Readonly<{ caseId: string; promise: Promise<unknown> }>;

export class AgentRuntimeDisposedError extends Error {
  readonly code = "AGENT_RUNTIME_DISPOSED";

  constructor() {
    super("Agent runtime is disposed");
    this.name = "AgentRuntimeDisposedError";
  }
}

export class ComposedAgentRuntime implements DesktopAgentRuntime {
  readonly #dependencies: AgentLoopRuntimeDependencies;
  readonly #external: AgentRuntimeExternalDependencies;
  readonly #runs: AgentRunRepository;
  readonly #service: AgentLoopService;
  readonly #tasks = new Set<TrackedTask>();
  readonly #resumed = new Map<string, AgentLoopRunner>();
  readonly #abort = new AbortController();
  #availability?: Promise<AgentUnavailableReason | undefined>;
  #disposal?: Promise<void>;
  #disposed = false;

  constructor(
    dependencies: AgentLoopRuntimeDependencies,
    external: AgentRuntimeExternalDependencies,
    runs: AgentRunRepository,
  ) {
    this.#dependencies = dependencies;
    this.#external = external;
    this.#runs = runs;
    this.#service = new AgentLoopService(dependencies);
  }

  async openCase(caseId: string) {
    this.#assertOpen();
    const projection = await this.#dependencies.projections.load(caseId);
    const recovered = await this.#runs.recoverActiveCase(caseId);
    return {
      contextDigest: projection.contextDigest,
      ...(recovered === undefined ? {} : { interruptedRun: recovered.run }),
    };
  }

  start(input: AgentLoopStartInput): Promise<AgentRuntimeResult> {
    if (this.#disposed) return Promise.reject(new AgentRuntimeDisposedError());
    return this.#track(input.caseId, async (signal) => {
      const unavailable = await this.#initialize(signal);
      if (unavailable !== undefined) return { status: "unavailable", reason: unavailable };
      return { status: "completed", run: await this.#service.start(input) };
    });
  }

  resume(input: AgentResumeInput): Promise<AgentRuntimeResult> {
    if (this.#disposed) return Promise.reject(new AgentRuntimeDisposedError());
    return this.#track(input.caseId, async (signal) => {
      const unavailable = await this.#initialize(signal);
      if (unavailable !== undefined) return { status: "unavailable", reason: unavailable };
      const runner = await this.#dependencies.mutations.run(input.caseId, async () => {
        const snapshot = await this.#runs.load(input.runId);
        if (snapshot.run.caseId !== input.caseId) {
          throw new AgentRunInvariantError("Agent run case mismatch");
        }
        const projection = await this.#dependencies.projections.load(input.caseId);
        if (projection.contextDigest !== input.approvedContextDigest) {
          throw new AgentRunInvariantError("Interrupted Agent context changed before resume");
        }
        const resumed = await this.#runs.resumeOwned(snapshot);
        const active = new AgentLoopRunner(this.#dependencies, {
          caseId: input.caseId,
          runId: input.runId,
          approvedContextDigest: input.approvedContextDigest,
          citationIds: projection.citationIds,
          snapshot: resumed,
        });
        this.#resumed.set(input.caseId, active);
        return active;
      });
      const run = await runner.drive();
      await this.#releaseResumed(runner, run);
      return { status: "completed", run };
    });
  }

  async cancel(input: Readonly<{ caseId: string; runId: string }>): Promise<AgentRun> {
    const resumed = this.#resumed.get(input.caseId);
    if (resumed === undefined) return this.#service.cancel(input);
    if (resumed.runId !== input.runId) throw new AgentRunInvariantError("Agent run ID mismatch");
    const run = await resumed.cancel();
    await this.#releaseResumed(resumed, run);
    return run;
  }

  dispose(): Promise<void> {
    if (this.#disposal !== undefined) return this.#disposal;
    this.#disposed = true;
    this.#abort.abort();
    this.#disposal = this.#settle();
    return this.#disposal;
  }

  async #settle(): Promise<void> {
    const cases = [...new Set([...this.#tasks].map((task) => task.caseId))];
    await Promise.all(
      cases.map((caseId) => this.#dependencies.mutations.run(caseId, async () => {})),
    );
    const active = [
      ...this.#service.activeRuns(),
      ...[...this.#resumed.values()].map((runner) => ({
        caseId: runner.caseId,
        runId: runner.runId,
      })),
    ];
    const cancellations = await Promise.allSettled(active.map((run) => this.cancel(run)));
    const settlements = await Promise.allSettled([...this.#tasks].map((task) => task.promise));
    const failures = [...cancellations, ...settlements]
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason)
      .filter((error) => !(error instanceof AgentRuntimeDisposedError));
    if (failures.length > 0) throw new AggregateError(failures, "Agent runtime disposal failed");
  }

  async #initialize(signal: AbortSignal): Promise<AgentUnavailableReason | undefined> {
    this.#assertAdmitted(signal);
    this.#availability ??= (async () => {
      const [mcp, provider] = await Promise.allSettled([
        this.#external.law.discover(),
        this.#external.provider(),
      ]);
      if (provider.status === "rejected") return "provider-initialization";
      if (mcp.status === "rejected" || mcp.value.length === 0) return "mcp-initialization";
      if (typeof provider.value.nextDecision !== "function") return "provider-initialization";
      return undefined;
    })();
    const availability = await this.#availability;
    this.#assertAdmitted(signal);
    return availability;
  }

  async #track<Result>(
    caseId: string,
    operation: (signal: AbortSignal) => Promise<Result>,
  ): Promise<Result> {
    const promise = Promise.resolve().then(() => operation(this.#abort.signal));
    const tracked: TrackedTask = { caseId, promise };
    this.#tasks.add(tracked);
    try {
      return await promise;
    } finally {
      this.#tasks.delete(tracked);
    }
  }

  async #releaseResumed(runner: AgentLoopRunner, run: AgentRun): Promise<void> {
    if (run.state.kind === "active") throw new AgentRunInvariantError("Cannot release active run");
    await this.#dependencies.mutations.run(runner.caseId, async () => {
      if (this.#resumed.get(runner.caseId) !== runner) return;
      await this.#runs.releaseOwned(runner.caseId, runner.runId);
      this.#resumed.delete(runner.caseId);
    });
  }

  #assertAdmitted(signal: AbortSignal): void {
    if (signal.aborted || this.#disposed) throw new AgentRuntimeDisposedError();
  }

  #assertOpen(): void {
    if (this.#disposed) throw new AgentRuntimeDisposedError();
  }
}
