import { type AgentRun, agentGoalSchema, approvalDecisionSchema } from "./agent-contracts";
import { pauseIdleAgentRun, recordAgentApproval } from "./agent-loop-boundary-reducer";
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

export class AgentLoopService {
  readonly #dependencies: AgentLoopRuntimeDependencies;
  readonly #active = new Map<string, AgentLoopRunner>();

  constructor(dependencies: AgentLoopRuntimeDependencies) {
    this.#dependencies = dependencies;
  }

  async start(input: AgentLoopStartInput): Promise<AgentRun> {
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
        run,
      });
      await this.#dependencies.runs.create(run);
      this.#active.set(input.caseId, runner);
      return { run, runner };
    });
    if (prepared.runner === undefined) return prepared.run;
    try {
      return await prepared.runner.drive();
    } finally {
      if (this.#active.get(input.caseId) === prepared.runner) {
        this.#active.delete(input.caseId);
      }
    }
  }

  async cancel(input: AgentLoopRunReference): Promise<AgentRun> {
    const runner = this.#active.get(input.caseId);
    if (runner === undefined || runner.runId !== input.runId) {
      throw new AgentLoopStateError("The requested Agent run is not active for this case");
    }
    return runner.cancel();
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
      return { status: "recorded", run };
    });
  }

  #assertCase(run: AgentRun, caseId: string): void {
    if (run.caseId !== caseId) throw new AgentLoopStateError("Agent run case mismatch");
  }
}
