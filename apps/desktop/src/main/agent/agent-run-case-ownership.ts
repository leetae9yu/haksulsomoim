import type { AgentToolLeaseTransition } from "./agent-case-tool-lease";
import { type AgentRun, agentRunSchema } from "./agent-contracts";
import {
  AgentCaseClaimInvariantError,
  type EncryptedAgentCaseClaimStore,
} from "./agent-run-case-claim";
import {
  AgentRunAlreadyExistsError,
  AgentRunNotFoundError,
  type AgentRunSnapshot,
  type EncryptedAgentRunRecordStore,
} from "./agent-run-repository-record";

export function interruptAgentRunForRestart(run: AgentRun, locator: string): AgentRun {
  const interruption = { kind: "application-restarted" };
  const interruptedStep = {
    kind: "interrupted",
    stepId: `restart_${locator.slice(0, 16)}_${run.steps.length}`,
    interruption,
  };
  return agentRunSchema.parse({
    ...run,
    state: { kind: "interrupted", interruption },
    steps: run.steps.length < 41 ? [...run.steps, interruptedStep] : run.steps,
  });
}

export class AgentRunCaseOwnership {
  readonly #runs: EncryptedAgentRunRecordStore;
  readonly #claims: EncryptedAgentCaseClaimStore;

  constructor(runs: EncryptedAgentRunRecordStore, claims: EncryptedAgentCaseClaimStore) {
    this.#runs = runs;
    this.#claims = claims;
  }

  async create(run: AgentRun): Promise<void> {
    await this.#claims.acquire(run.caseId, run.runId);
    const snapshot = { run, cursor: 0 };
    try {
      await this.#runs.write(snapshot, true);
    } catch (error) {
      if (error instanceof AgentRunAlreadyExistsError) {
        return this.#rollback(run.caseId, run.runId, error);
      }
      try {
        await this.#runs.read(run.runId);
      } catch (readError) {
        if (readError instanceof AgentRunNotFoundError) {
          return this.#rollback(run.caseId, run.runId, error);
        }
        throw new AggregateError(
          [error, readError],
          "Agent run publication failed with an unknown durable outcome",
        );
      }
      throw error;
    }
  }

  activeRunId(caseId: string): Promise<string | undefined> {
    return this.#claims.owner(caseId);
  }

  async resume(expected: AgentRunSnapshot, run: AgentRun): Promise<void> {
    await this.#claims.acquire(run.caseId, run.runId);
    try {
      await this.#runs.write({ run, cursor: expected.cursor }, false, expected);
    } catch (error) {
      let published: AgentRunSnapshot;
      try {
        published = await this.#runs.read(run.runId);
      } catch (readError) {
        throw new AggregateError(
          [error, readError],
          "Agent run resume failed with an unknown durable outcome",
        );
      }
      if (JSON.stringify(published.run) === JSON.stringify(run)) return;
      await this.#claims.release(run.caseId, run.runId);
      throw error;
    }
  }

  transitionToolLease(transition: AgentToolLeaseTransition): Promise<void> {
    if (transition.kind === "executing") return this.#claims.beginToolLease(transition.lease);
    if (transition.kind === "settled") return this.#claims.settleToolLease(transition.lease);
    return this.#claims.quarantine(
      transition.lease.caseId,
      transition.lease.runId,
      transition.lease,
    );
  }

  async release(caseId: string, runId: string): Promise<void> {
    const owner = await this.#claims.owner(caseId);
    if (owner === undefined) return;
    this.#assertOwner(owner, runId);
    const snapshot = await this.#runs.read(runId);
    this.#assertCase(snapshot.run, caseId);
    if (snapshot.run.state.kind === "active") {
      throw new AgentCaseClaimInvariantError(
        "Agent case claim cannot be released while its run is active",
      );
    }
    await this.#claims.release(caseId, runId);
  }

  async recover(caseId: string): Promise<AgentRunSnapshot | undefined> {
    if (await this.#claims.isQuarantined(caseId)) {
      throw new AgentCaseClaimInvariantError("Agent case is quarantined by an unresolved tool");
    }
    const runId = await this.#claims.owner(caseId);
    if (runId === undefined) return undefined;
    let snapshot: AgentRunSnapshot;
    try {
      snapshot = await this.#runs.read(runId);
    } catch (error) {
      if (!(error instanceof AgentRunNotFoundError)) throw error;
      await this.#claims.release(caseId, runId);
      return undefined;
    }
    this.#assertCase(snapshot.run, caseId);
    const locator = await this.#runs.locator(runId);
    const recovered =
      snapshot.run.state.kind === "active"
        ? {
            run: interruptAgentRunForRestart(snapshot.run, locator),
            cursor: snapshot.cursor,
          }
        : snapshot;
    if (recovered !== snapshot) await this.#runs.write(recovered, false, snapshot);
    await this.#claims.release(caseId, runId);
    return recovered;
  }

  async #rollback(caseId: string, runId: string, error: unknown): Promise<never> {
    try {
      await this.#claims.release(caseId, runId);
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "Agent run creation failed and its case claim could not be rolled back",
      );
    }
    throw error;
  }

  #assertOwner(owner: string, runId: string): void {
    if (owner !== runId) {
      throw new AgentCaseClaimInvariantError("Agent case claim belongs to another run");
    }
  }

  #assertCase(run: AgentRun, caseId: string): void {
    if (run.caseId !== caseId) {
      throw new AgentCaseClaimInvariantError("Agent case claim and run case do not match");
    }
  }
}
