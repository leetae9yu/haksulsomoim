import { type AgentRun, agentGoalSchema, approvalDecisionSchema } from "./agent-contracts";
import {
  cancelAgentRun,
  pauseIdleAgentRun,
  recordAgentApproval,
} from "./agent-loop-boundary-reducer";
import { commitAgentRun } from "./agent-loop-checkpoints";
import { pendingApproval } from "./agent-loop-decisions";
import { AgentLoopAlreadyActiveError, AgentLoopStateError } from "./agent-loop-errors";
import { createActiveAgentRun } from "./agent-loop-reducer";
import { AgentLoopRunner } from "./agent-loop-runner";
import { type AgentLoopRuntimeDependencies, loadAgentProjection } from "./agent-loop-runtime";
import type {
  AgentLoopApprovalInput,
  AgentLoopApprovalResolution,
  AgentLoopRunReference,
  AgentLoopStartInput,
} from "./agent-loop-types";

export type { AgentLoopClock, AgentLoopProvider } from "./agent-loop-types";
export type AgentLoopServiceDependencies = AgentLoopRuntimeDependencies;
export type AgentLoopExecution = Readonly<{
  initial: AgentRun;
  completion: Promise<AgentRun>;
}>;

export class AgentLoopService {
  readonly #dependencies: AgentLoopRuntimeDependencies;
  readonly #active = new Map<string, AgentLoopRunner>();

  constructor(dependencies: AgentLoopRuntimeDependencies) {
    this.#dependencies = dependencies;
  }

  async start(input: AgentLoopStartInput): Promise<AgentRun> {
    return (await this.begin(input)).completion;
  }

  async begin(input: AgentLoopStartInput): Promise<AgentLoopExecution> {
    const prepared = await this.#dependencies.mutations.run(input.caseId, async () => {
      if (this.#active.has(input.caseId)) throw new AgentLoopAlreadyActiveError(input.caseId);
      const goal = agentGoalSchema.parse(input.goal);
      if (goal.caseId !== input.caseId) throw new AgentLoopStateError("Agent goal case mismatch");
      const projection = await loadAgentProjection(this.#dependencies, input.caseId);
      const runId = this.#dependencies.identifiers.nextRunId();
      const initial = createActiveAgentRun(runId, input.caseId, goal);
      const run =
        projection.contextDigest === input.approvedContextDigest
          ? initial
          : pauseIdleAgentRun(initial, "context-changed", initial.budget.durationMsRemaining);
      if (run.state.kind !== "active") {
        await this.#dependencies.runs.create(run);
        return { run, runner: undefined };
      }
      const runner = new AgentLoopRunner(this.#dependencies, {
        caseId: input.caseId,
        runId,
        approvedContextDigest: input.approvedContextDigest,
        citationIds: projection.citationIds,
        snapshot: { run, cursor: 0 },
      });
      await this.#dependencies.runs.createOwned(run);
      this.#active.set(input.caseId, runner);
      return { run, runner };
    });
    this.#dependencies.publish?.(prepared.run);
    if (prepared.runner === undefined) {
      return { initial: prepared.run, completion: Promise.resolve(prepared.run) };
    }
    return {
      initial: prepared.run,
      completion: this.#completeRunner(prepared.runner),
    };
  }

  quarantinedRuns(): readonly AgentLoopRunReference[] {
    return [...this.#active.values()]
      .filter((runner) => runner.quarantined)
      .map((runner) => ({ caseId: runner.caseId, runId: runner.runId }));
  }

  activeRuns(): readonly AgentLoopRunReference[] {
    return [...this.#active.values()].map((runner) => ({
      caseId: runner.caseId,
      runId: runner.runId,
    }));
  }

  async pause(input: AgentLoopRunReference): Promise<AgentRun> {
    const runner = this.#active.get(input.caseId);
    if (runner === undefined || runner.runId !== input.runId) {
      throw new AgentLoopStateError("The requested Agent run is not active for this case");
    }
    const run = await runner.pause();
    await this.#releaseRunner(runner, run);
    return run;
  }

  async cancel(input: AgentLoopRunReference): Promise<AgentRun> {
    const runner = this.#active.get(input.caseId);
    if (runner !== undefined) {
      if (runner.runId !== input.runId) {
        throw new AgentLoopStateError("The requested Agent run is not active for this case");
      }
      const run = await runner.cancel();
      await this.#releaseRunner(runner, run);
      return run;
    }
    return this.#dependencies.mutations.run(input.caseId, async () => {
      const snapshot = await this.#dependencies.runs.load(input.runId);
      this.#assertCase(snapshot.run, input.caseId);
      if (
        snapshot.run.state.kind === "interrupted" &&
        snapshot.run.state.interruption.kind === "user-cancelled"
      ) {
        return snapshot.run;
      }
      if (snapshot.run.state.kind === "active" || snapshot.run.state.kind === "terminal") {
        throw new AgentLoopStateError("The requested Agent run cannot be cancelled");
      }
      const run = cancelAgentRun(snapshot.run, this.#dependencies.identifiers.nextStepId());
      await commitAgentRun(this.#dependencies.runs, snapshot, run, true);
      this.#dependencies.publish?.(run);
      return run;
    });
  }

  async decideApproval(input: AgentLoopApprovalInput): Promise<AgentLoopApprovalResolution> {
    return this.#dependencies.mutations.run(input.caseId, async () => {
      const active = this.#active.get(input.caseId);
      if (active !== undefined && active.runId !== input.runId) {
        throw new AgentLoopStateError("Another Agent run is active for this case");
      }
      const snapshot = await this.#dependencies.runs.load(input.runId);
      this.#assertCase(snapshot.run, input.caseId);
      const approval = pendingApproval(snapshot.run);
      const projection = await loadAgentProjection(this.#dependencies, input.caseId);
      if (approval !== undefined && projection.contextDigest !== approval.contextDigest) {
        const run = pauseIdleAgentRun(
          snapshot.run,
          "context-changed",
          snapshot.run.budget.durationMsRemaining,
        );
        await commitAgentRun(this.#dependencies.runs, snapshot, run, true);
        return { status: "stale", run };
      }
      if (
        approval === undefined ||
        approval.approvalId !== input.approvalId ||
        approval.approvalDigest !== input.approvalDigest
      ) {
        return { status: "stale", run: snapshot.run };
      }
      const decision = approvalDecisionSchema.parse({
        approvalId: input.approvalId,
        approvalDigest: input.approvalDigest,
        outcome: input.outcome,
      });
      const run = recordAgentApproval(
        snapshot.run,
        decision,
        this.#dependencies.identifiers.nextStepId(),
      );
      await commitAgentRun(this.#dependencies.runs, snapshot, run, true);
      this.#dependencies.publish?.(run);
      return { status: "recorded", run };
    });
  }

  async #completeRunner(runner: AgentLoopRunner): Promise<AgentRun> {
    const run = await runner.drive();
    await this.#releaseRunner(runner, run);
    return run;
  }

  async #releaseRunner(runner: AgentLoopRunner, run: AgentRun): Promise<void> {
    if (run.state.kind === "active") {
      throw new AgentLoopStateError("An active Agent run cannot release case ownership");
    }
    if (runner.quarantined) {
      await this.#dependencies.runs.quarantineOwned(runner.caseId, runner.runId);
      return;
    }
    await this.#dependencies.mutations.run(runner.caseId, async () => {
      if (this.#active.get(runner.caseId) !== runner) return;
      await this.#dependencies.runs.releaseOwned(runner.caseId, runner.runId);
      this.#active.delete(runner.caseId);
    });
  }

  #assertCase(run: AgentRun, caseId: string): void {
    if (run.caseId !== caseId) throw new AgentLoopStateError("Agent run case mismatch");
  }
}
