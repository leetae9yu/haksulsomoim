import type { AgentRun } from "./agent-contracts";
import { createHostCompletionDigest, parseAndRebindAgentDecision } from "./agent-loop-decisions";
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
} from "./agent-loop-settlements";
import { acceptAgentDecision, prepareAgentTurn } from "./agent-loop-turns";
import type { AgentLoopProvider } from "./agent-loop-types";
import type { AgentRunSnapshot } from "./agent-run-repository";

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
      const execution = await this.#dependencies.tools.execute(
        this.#control.caseId,
        accepted.call,
        accepted.projection,
        [...this.#control.citationIds],
      );
      if (this.#stopping()) return this.#stoppedRun();
      const observation = this.#dependencies.tools.prepareObservation(
        this.#control.caseId,
        accepted.call,
        execution,
      );
      const run = await finishAgentToolTurn(
        this.#dependencies,
        this.#control,
        observation.result,
        execution,
      );
      for (const citationId of execution.citationIds) this.#control.citationIds.add(citationId);
      if (run.state.kind !== "active") return run;
    }
  }

  pause(): Promise<AgentRun> {
    if (this.#control.cancellation !== undefined) return this.#control.cancellation;
    if (this.#control.pause !== undefined) return this.#control.pause;
    const request = this.#persistAndInterrupt("pause");
    this.#control.pause = request;
    this.#control.requestCancellation();
    return request;
  }

  cancel(): Promise<AgentRun> {
    if (this.#control.cancellation !== undefined) return this.#control.cancellation;
    if (this.#control.pause !== undefined) return this.#control.pause;
    this.#control.cancelled = true;
    const request = this.#persistAndInterrupt("cancel");
    this.#control.cancellation = request;
    this.#control.requestCancellation();
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
    if (persistenceFailure !== undefined) throw persistenceFailure;
    if (run === undefined) throw new AgentLoopStateError("Agent settlement did not persist");
    return run;
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
