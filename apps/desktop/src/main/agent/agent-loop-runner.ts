import type { AgentRun } from "./agent-contracts";
import {
  createHostCompletionDigest,
  parseAndRebindAgentDecision,
  toolResults,
} from "./agent-loop-decisions";
import { AgentLoopStateError } from "./agent-loop-errors";
import {
  type AgentLoopControl,
  type AgentLoopRuntimeDependencies,
  createAgentLoopControl,
} from "./agent-loop-runtime";
import {
  cancelActiveAgentRun,
  finishAgentToolTurn,
  pauseActiveAgentRun,
  pauseAgentProviderTurn,
  pauseAgentRunWithoutTurn,
  pauseAgentToolTimeout,
} from "./agent-loop-settlements";
import { acceptAgentDecision, prepareAgentTurn } from "./agent-loop-turns";
import type { AgentLoopProvider } from "./agent-loop-types";
import type { AgentRunSnapshot } from "./agent-run-repository";
import {
  AgentToolExecutionBoundary,
  type AgentToolExecutionOutcome,
  systemExecutionTimer,
} from "./agent-tool-execution";
import type { AgentToolExecution } from "./agent-tool-registry";

type ProviderTurn =
  | Readonly<{ kind: "decision"; raw: unknown }>
  | Readonly<{ kind: "failed" }>
  | Readonly<{ kind: "cancelled" }>;

async function requestProviderTurn(
  provider: AgentLoopProvider,
  input: Parameters<AgentLoopProvider["nextDecision"]>[0],
): Promise<ProviderTurn> {
  try {
    return { kind: "decision", raw: await provider.nextDecision(input) };
  } catch {
    return { kind: "failed" };
  }
}

async function awaitCancellation(requested: Promise<void>): Promise<ProviderTurn> {
  await requested;
  return { kind: "cancelled" };
}

export class AgentLoopRunner {
  readonly #dependencies: AgentLoopRuntimeDependencies;
  readonly #control: AgentLoopControl;
  #activeTool: AgentToolExecutionBoundary<AgentToolExecution> | undefined;
  #quarantined = false;

  constructor(
    dependencies: AgentLoopRuntimeDependencies,
    input: Readonly<{
      caseId: string;
      runId: string;
      approvedContextDigest: string;
      citationIds: readonly string[];
      snapshot: AgentRunSnapshot;
    }>,
  ) {
    this.#dependencies = dependencies;
    this.#control = createAgentLoopControl(
      dependencies,
      input.caseId,
      input.runId,
      input.approvedContextDigest,
      input.citationIds,
      input.snapshot,
    );
  }

  get caseId(): string {
    return this.#control.caseId;
  }

  get runId(): string {
    return this.#control.runId;
  }

  get quarantined(): boolean {
    return this.#quarantined;
  }

  async drive(): Promise<AgentRun> {
    try {
      this.#control.provider = await this.#dependencies.provider();
    } catch {
      return pauseAgentRunWithoutTurn(this.#dependencies, this.#control, "provider-unavailable");
    }
    while (true) {
      const prepared = await prepareAgentTurn(this.#dependencies, this.#control);
      if (prepared.kind === "stop") return prepared.run;
      const turn = await Promise.race([
        requestProviderTurn(this.#control.provider, prepared.context),
        awaitCancellation(this.#control.cancellationRequested),
      ]);
      if (turn.kind === "cancelled" || this.#stopping()) return this.#stoppedRun();
      if (turn.kind === "failed") {
        return pauseAgentProviderTurn(this.#dependencies, this.#control);
      }
      const decision = parseAndRebindAgentDecision(
        turn.raw,
        {
          decisionId: prepared.decisionId,
          toolCallId: this.#dependencies.identifiers.nextToolCallId(),
          approvalId: this.#dependencies.identifiers.nextApprovalId(),
          completionDigest: createHostCompletionDigest(prepared.context.observations),
        },
        this.#control.caseId,
        this.#control.approvedContextDigest,
      );
      const accepted = await acceptAgentDecision(
        this.#dependencies,
        this.#control,
        prepared.decisionId,
        decision,
      );
      if (accepted.kind === "stop") return accepted.run;
      if (accepted.kind === "continue") continue;
      if (this.#stopping()) return this.#stoppedRun();
      const outcome = await this.#executeTool(accepted);
      if (outcome.kind !== "completed") {
        this.#quarantined = outcome.kind === "interrupted" && outcome.quarantined;
        if (this.#stopping()) return this.#stoppedRun();
        return pauseAgentToolTimeout(this.#dependencies, this.#control);
      }
      this.#activeTool = undefined;
      const observation = this.#dependencies.tools.prepareObservation(
        this.#control.caseId,
        accepted.call,
        outcome.value,
        toolResults(accepted.run),
      );
      const run = await finishAgentToolTurn(
        this.#dependencies,
        this.#control,
        observation.result,
        outcome.value,
      );
      for (const citationId of observation.result.citationIds) {
        this.#control.citationIds.add(citationId);
      }
      if (run.state.kind !== "active") return run;
    }
  }

  pause(): Promise<AgentRun> {
    if (this.#control.cancellation !== undefined) return this.#control.cancellation;
    if (this.#control.pause !== undefined) return this.#control.pause;
    this.#control.requestCancellation();
    this.#activeTool?.interrupt("run-stopped");
    const request = this.#persistAndInterrupt("pause");
    this.#control.pause = request;
    return request;
  }

  cancel(): Promise<AgentRun> {
    if (this.#control.cancellation !== undefined) return this.#control.cancellation;
    if (this.#control.pause !== undefined) return this.#control.pause;
    this.#control.cancelled = true;
    this.#control.requestCancellation();
    this.#activeTool?.interrupt("run-stopped");
    const request = this.#persistAndInterrupt("cancel");
    this.#control.cancellation = request;
    return request;
  }

  async #persistAndInterrupt(kind: "pause" | "cancel"): Promise<AgentRun> {
    let persistenceFailure: unknown;
    let run: AgentRun | undefined;
    try {
      run = await (kind === "pause"
        ? pauseActiveAgentRun(this.#dependencies, this.#control)
        : cancelActiveAgentRun(this.#dependencies, this.#control));
    } catch (error) {
      persistenceFailure = error;
    }
    try {
      await this.#control.provider?.interrupt();
    } catch (interruptFailure) {
      if (persistenceFailure !== undefined) {
        throw new AggregateError(
          [persistenceFailure, interruptFailure],
          "Agent settlement persistence and transport interruption failed",
        );
      }
      // A durably persisted host pause or cancellation remains authoritative.
    }
    const toolOutcome = await this.#activeTool?.outcome;
    if (toolOutcome?.kind === "interrupted") this.#quarantined = toolOutcome.quarantined;
    if (persistenceFailure !== undefined) throw persistenceFailure;
    if (run === undefined) throw new AgentLoopStateError("Agent settlement did not persist");
    return run;
  }

  #executeTool(
    accepted: Extract<Awaited<ReturnType<typeof acceptAgentDecision>>, { kind: "execute" }>,
  ): Promise<AgentToolExecutionOutcome<AgentToolExecution>> {
    const timeoutMs = Math.max(
      1,
      Math.min(this.#dependencies.toolTimeoutMs ?? 30_000, accepted.run.budget.durationMsRemaining),
    );
    const boundary = new AgentToolExecutionBoundary(
      (context) =>
        this.#dependencies.tools.execute(
          this.#control.caseId,
          accepted.call,
          accepted.projection,
          accepted.citationIds,
          context,
        ),
      {
        timeoutMs,
        graceMs: this.#dependencies.toolSettlementGraceMs ?? 250,
        timer: this.#dependencies.timer ?? systemExecutionTimer,
      },
    );
    this.#activeTool = boundary;
    return boundary.outcome;
  }

  #stopping(): boolean {
    return this.#control.cancelled || this.#control.pause !== undefined;
  }

  async #stoppedRun(): Promise<AgentRun> {
    const settlement = this.#control.cancellation ?? this.#control.pause;
    if (settlement !== undefined) return settlement;
    throw new AgentLoopStateError("Agent settlement was not persisted");
  }
}
