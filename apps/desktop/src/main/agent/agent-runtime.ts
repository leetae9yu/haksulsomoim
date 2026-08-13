import { awaitRuntimeDisposal, type RuntimeDeadlineTimer } from "../runtime-deadline";
import type { AgentRun } from "./agent-contracts";
import { afterAuthoritativeToolSettlement } from "./agent-late-tool-settlement";
import { AgentLoopRunner } from "./agent-loop-runner";
import type { AgentLoopRuntimeDependencies } from "./agent-loop-runtime";
import { AgentLoopService } from "./agent-loop-service";
import type { AgentLoopStartInput } from "./agent-loop-types";
import { AgentRunInvariantError, type AgentRunRepository } from "./agent-run-repository";
import type { AgentRuntimeExternalDependencies } from "./agent-runtime-composition";
import { initializeAgentIntegrations } from "./agent-runtime-initialization";
import type {
  AgentResumeInput,
  AgentRuntimeBeginResult,
  AgentRuntimeResult,
  AgentUnavailableReason,
  DesktopAgentRuntime,
} from "./agent-runtime-types";
import { AgentToolQuarantinedError } from "./agent-tool-execution";

export type {
  AgentResumeInput,
  AgentRuntimeBeginResult,
  AgentRuntimeResult,
  AgentUnavailableReason,
  DesktopAgentRuntime,
} from "./agent-runtime-types";

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
  readonly #listeners = new Set<(run: AgentRun) => void>();
  readonly #abort = new AbortController();
  readonly #timer: RuntimeDeadlineTimer | undefined;
  readonly #initializationDeadlineMs: number;
  readonly #disposalDeadlineMs: number;
  #availability?: Promise<AgentUnavailableReason | undefined>;
  #disposal?: Promise<void>;
  #disposed = false;

  constructor(
    dependencies: AgentLoopRuntimeDependencies,
    external: AgentRuntimeExternalDependencies,
    runs: AgentRunRepository,
    lifecycle: Readonly<{
      timer?: RuntimeDeadlineTimer | undefined;
      initializationDeadlineMs?: number;
      disposalDeadlineMs?: number;
    }> = {},
  ) {
    this.#dependencies = { ...dependencies, publish: (run) => this.#publish(run) };
    this.#timer = lifecycle.timer;
    this.#initializationDeadlineMs = lifecycle.initializationDeadlineMs ?? 30_000;
    this.#disposalDeadlineMs = lifecycle.disposalDeadlineMs ?? 500;
    this.#external = external;
    this.#runs = runs;
    this.#service = new AgentLoopService(this.#dependencies);
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

  begin(input: AgentLoopStartInput): Promise<AgentRuntimeBeginResult> {
    if (this.#disposed) return Promise.reject(new AgentRuntimeDisposedError());
    return this.#track(input.caseId, async (signal) => {
      const unavailable = await this.#initialize(signal);
      if (unavailable !== undefined) return { status: "unavailable", reason: unavailable };
      const execution = await this.#service.begin(input);
      return {
        status: "started",
        run: execution.initial,
        completion: this.#adopt(input.caseId, execution.completion),
      };
    });
  }

  async start(input: AgentLoopStartInput): Promise<AgentRuntimeResult> {
    const begun = await this.begin(input);
    if (begun.status === "unavailable") return begun;
    return { status: "completed", run: await begun.completion };
  }

  beginResume(input: AgentResumeInput): Promise<AgentRuntimeBeginResult> {
    if (this.#disposed) return Promise.reject(new AgentRuntimeDisposedError());
    return this.#track(input.caseId, async (signal) => {
      const unavailable = await this.#initialize(signal);
      if (unavailable !== undefined) return { status: "unavailable", reason: unavailable };
      const execution = await this.#resumeExecution(input);
      return {
        status: "started",
        run: execution.run,
        completion: this.#adopt(input.caseId, execution.completion),
      };
    });
  }

  async resume(input: AgentResumeInput): Promise<AgentRuntimeResult> {
    const begun = await this.beginResume(input);
    if (begun.status === "unavailable") return begun;
    return { status: "completed", run: await begun.completion };
  }

  async pause(input: Readonly<{ caseId: string; runId: string }>): Promise<AgentRun> {
    const resumed = this.#resumed.get(input.caseId);
    if (resumed === undefined) return this.#service.pause(input);
    if (resumed.runId !== input.runId) throw new AgentRunInvariantError("Agent run ID mismatch");
    const run = await resumed.pause();
    await this.#releaseResumed(resumed, run);
    return run;
  }

  decideApproval(input: Parameters<DesktopAgentRuntime["decideApproval"]>[0]) {
    this.#assertOpen();
    return this.#service.decideApproval(input);
  }

  async cancel(input: Readonly<{ caseId: string; runId: string }>): Promise<AgentRun> {
    const resumed = this.#resumed.get(input.caseId);
    if (resumed === undefined) return this.#service.cancel(input);
    if (resumed.runId !== input.runId) throw new AgentRunInvariantError("Agent run ID mismatch");
    const run = await resumed.cancel();
    await this.#releaseResumed(resumed, run);
    return run;
  }

  subscribe(listener: (run: AgentRun) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  dispose(): Promise<void> {
    if (this.#disposal !== undefined) return this.#disposal;
    this.#disposed = true;
    this.#abort.abort();
    this.#disposal = awaitRuntimeDisposal(this.#settle(), {
      phase: "agent-disposal",
      deadlineMs: this.#disposalDeadlineMs,
      timer: this.#timer,
    });
    return this.#disposal;
  }

  async #resumeExecution(input: AgentResumeInput) {
    return this.#dependencies.mutations.run(input.caseId, async () => {
      const snapshot = await this.#runs.load(input.runId);
      if (snapshot.run.caseId !== input.caseId) {
        throw new AgentRunInvariantError("Agent run case mismatch");
      }
      const projection = await this.#dependencies.projections.load(input.caseId);
      if (projection.contextDigest !== input.approvedContextDigest) {
        throw new AgentRunInvariantError("Interrupted Agent context changed before resume");
      }
      const resumed = await this.#runs.resumeOwned(snapshot);
      const runner = new AgentLoopRunner(this.#dependencies, {
        caseId: input.caseId,
        runId: input.runId,
        approvedContextDigest: input.approvedContextDigest,
        citationIds: projection.citationIds,
        snapshot: resumed,
      });
      this.#resumed.set(input.caseId, runner);
      this.#publish(resumed.run);
      return { run: resumed.run, completion: this.#completeResumed(runner) };
    });
  }

  async #completeResumed(runner: AgentLoopRunner): Promise<AgentRun> {
    const run = await runner.drive();
    await this.#releaseResumed(runner, run);
    return run;
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
    const quarantined = [
      ...this.#service.quarantinedRuns(),
      ...[...this.#resumed.values()]
        .filter((runner) => runner.quarantined)
        .map((runner) => ({ caseId: runner.caseId, runId: runner.runId })),
    ].map((run) => new AgentToolQuarantinedError(run.caseId, run.runId));
    const failures = [...cancellations, ...settlements]
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason)
      .filter((error) => !(error instanceof AgentRuntimeDisposedError));
    failures.push(...quarantined);
    if (failures.length > 0) throw new AggregateError(failures, "Agent runtime disposal failed");
  }

  async #initialize(signal: AbortSignal): Promise<AgentUnavailableReason | undefined> {
    this.#assertAdmitted(signal);
    this.#availability ??= initializeAgentIntegrations(this.#external, {
      signal: this.#abort.signal,
      deadlineMs: this.#initializationDeadlineMs,
      timer: this.#timer,
    });
    this.#availability.catch(() => undefined);
    const availability = await this.#availability;
    this.#assertAdmitted(signal);
    return availability;
  }

  #track<Result>(caseId: string, operation: (signal: AbortSignal) => Promise<Result>) {
    return this.#adopt(
      caseId,
      Promise.resolve().then(() => operation(this.#abort.signal)),
    );
  }

  #adopt<Result>(caseId: string, promise: Promise<Result>): Promise<Result> {
    let task: TrackedTask;
    const tracked = promise.finally(() => this.#tasks.delete(task));
    task = { caseId, promise: tracked };
    this.#tasks.add(task);
    return tracked;
  }

  async #releaseResumed(runner: AgentLoopRunner, run: AgentRun): Promise<void> {
    if (run.state.kind === "active") throw new AgentRunInvariantError("Cannot release active run");
    const release = () =>
      this.#dependencies.mutations.run(runner.caseId, async () => {
        if (this.#resumed.get(runner.caseId) !== runner) return;
        await this.#runs.releaseOwned(runner.caseId, runner.runId);
        this.#resumed.delete(runner.caseId);
      });
    if (runner.quarantined) afterAuthoritativeToolSettlement(runner, release);
    else await release();
  }

  #publish(run: AgentRun): void {
    for (const listener of this.#listeners) listener(run);
  }

  #assertAdmitted(signal: AbortSignal): void {
    if (signal.aborted || this.#disposed) throw new AgentRuntimeDisposedError();
  }
  #assertOpen(): void {
    if (this.#disposed) throw new AgentRuntimeDisposedError();
  }
}
