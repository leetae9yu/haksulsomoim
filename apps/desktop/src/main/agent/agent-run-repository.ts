import type { AgentRun, AgentStep } from "./agent-contracts";
import { agentRunSchema } from "./agent-contracts";
import { EncryptedAgentCaseClaimStore } from "./agent-run-case-claim";
import { AgentRunCaseOwnership, interruptAgentRunForRestart } from "./agent-run-case-ownership";
import { AgentRepositoryKeyVerifier } from "./agent-run-repository-key";
import { type AgentRunSnapshot, EncryptedAgentRunRecordStore } from "./agent-run-repository-record";
import { AgentRunInvariantError, assertSafeAgentText } from "./agent-run-repository-safety";

export { AgentCaseAlreadyClaimedError, AgentCaseClaimInvariantError } from "./agent-run-case-claim";
export {
  AgentRepositoryKeyMarkerError,
  AgentRepositoryKeyMismatchError,
} from "./agent-run-repository-key";
export {
  AgentRunAlreadyExistsError,
  AgentRunNotFoundError,
  type AgentRunSnapshot,
  ConcurrentAgentRunSaveError,
} from "./agent-run-repository-record";
export { AgentRunInvariantError } from "./agent-run-repository-safety";

export interface AgentRunRepositoryOptions {
  readonly directory: string;
  readonly encryptionKey: Uint8Array;
}
function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
function assertUniqueHistory(steps: readonly AgentStep[]): void {
  const stepIds = new Set<string>();
  const decisionIds = new Set<string>();
  const pendingDecisions = new Set<string>();
  const recordedTools = new Map<string, unknown>();
  const pendingTools = new Map<string, AgentStep & { kind: "tool-started" }>();
  const finishedCalls = new Set<string>();
  for (const step of steps) {
    if (stepIds.has(step.stepId)) {
      throw new AgentRunInvariantError("Agent step idempotency key is duplicated");
    }
    stepIds.add(step.stepId);
    if (step.kind === "decision-started") {
      if (decisionIds.has(step.decisionId)) {
        throw new AgentRunInvariantError("Agent decision idempotency key is duplicated");
      }
      decisionIds.add(step.decisionId);
      pendingDecisions.add(step.decisionId);
    }
    if (step.kind === "decision-recorded") {
      if (!pendingDecisions.delete(step.decision.decisionId)) {
        throw new AgentRunInvariantError("Decision result requires a committed start checkpoint");
      }
      if (step.decision.kind === "tool") {
        recordedTools.set(step.decision.decisionId, step.decision.toolCall);
      }
    }
    if (step.kind === "tool-started") {
      if (!same(recordedTools.get(step.decisionId), step.toolCall)) {
        throw new AgentRunInvariantError("Tool execution requires a committed start checkpoint");
      }
      if (
        pendingTools.has(step.toolCall.toolCallId) ||
        finishedCalls.has(step.toolCall.toolCallId)
      ) {
        throw new AgentRunInvariantError("Agent tool-call idempotency key is duplicated");
      }
      pendingTools.set(step.toolCall.toolCallId, step);
    }
    if (step.kind === "tool-finished") {
      if (finishedCalls.has(step.result.toolCallId)) {
        throw new AgentRunInvariantError("A completed tool result is already committed");
      }
      const started = pendingTools.get(step.result.toolCallId);
      if (!started) {
        throw new AgentRunInvariantError("Tool result requires a committed start checkpoint");
      }
      if (started.toolCall.toolName !== step.result.toolName) {
        throw new AgentRunInvariantError("Tool result tool name differs from its committed start");
      }
      pendingTools.delete(step.result.toolCallId);
      finishedCalls.add(step.result.toolCallId);
    }
    if (step.kind === "interrupted") {
      pendingDecisions.clear();
      recordedTools.clear();
      pendingTools.clear();
    }
  }
}

function hasInFlight(steps: readonly AgentStep[]): boolean {
  const decisions = new Set<string>();
  const tools = new Set<string>();
  for (const step of steps) {
    if (step.kind === "decision-started") decisions.add(step.decisionId);
    if (step.kind === "decision-recorded") decisions.delete(step.decision.decisionId);
    if (step.kind === "tool-started") tools.add(step.toolCall.toolCallId);
    if (step.kind === "tool-finished") tools.delete(step.result.toolCallId);
    if (step.kind === "interrupted") {
      decisions.clear();
      tools.clear();
    }
  }
  return decisions.size > 0 || tools.size > 0;
}

function assertImmutable(existing: AgentRunSnapshot, candidate: AgentRunSnapshot): void {
  if (
    existing.run.runId !== candidate.run.runId ||
    existing.run.caseId !== candidate.run.caseId ||
    !same(existing.run.goal, candidate.run.goal)
  ) {
    throw new AgentRunInvariantError("Agent run identity is immutable");
  }
  if (candidate.run.steps.length < existing.run.steps.length) {
    throw new AgentRunInvariantError("Agent run history is immutable");
  }
  existing.run.steps.forEach((step, index) => {
    if (!same(step, candidate.run.steps[index])) {
      throw new AgentRunInvariantError("Agent run history is immutable");
    }
  });
  if (candidate.cursor < existing.cursor) {
    throw new AgentRunInvariantError("Agent run cursor cannot move backward");
  }
  const historyChanged = candidate.run.steps.length !== existing.run.steps.length;
  if (historyChanged && candidate.cursor !== existing.cursor) {
    throw new AgentRunInvariantError("History and cursor require a separate commit");
  }
  if (
    candidate.cursor > existing.cursor &&
    hasInFlight(candidate.run.steps.slice(0, candidate.cursor))
  ) {
    throw new AgentRunInvariantError("Agent run cursor cannot advance past in-flight work");
  }
}

function isIdempotentResultRetry(existing: AgentRunSnapshot, candidate: AgentRunSnapshot): boolean {
  if (candidate.run.steps.length !== existing.run.steps.length + 1) return false;
  const retried = candidate.run.steps.at(-1);
  if (retried?.kind !== "tool-finished" || candidate.cursor !== existing.cursor) return false;
  return existing.run.steps.some(
    (step) =>
      step.kind === "tool-finished" &&
      step.result.toolCallId === retried.result.toolCallId &&
      same(step.result, retried.result),
  );
}

export class AgentRunRepository {
  readonly #store: EncryptedAgentRunRecordStore;
  readonly #ownership: AgentRunCaseOwnership;

  constructor(options: AgentRunRepositoryOptions) {
    const { directory, encryptionKey } = options;
    if (directory.length === 0) throw new TypeError("An Agent run directory is required");
    if (encryptionKey.byteLength !== 32) {
      throw new RangeError("AES-256-GCM requires a 32-byte encryption key");
    }
    const verifier = new AgentRepositoryKeyVerifier(directory, encryptionKey);
    this.#store = new EncryptedAgentRunRecordStore(directory, encryptionKey, verifier);
    const claims = new EncryptedAgentCaseClaimStore(directory, encryptionKey, verifier);
    this.#ownership = new AgentRunCaseOwnership(this.#store, claims);
  }

  async create(run: AgentRun): Promise<void> {
    const parsed = agentRunSchema.parse(run);
    assertSafeAgentText(parsed);
    assertUniqueHistory(parsed.steps);
    if (parsed.state.kind === "active") {
      await this.#ownership.create(parsed);
      return;
    }
    await this.#store.write({ run: parsed, cursor: 0 }, true);
  }

  async createOwned(run: AgentRun): Promise<void> {
    const parsed = agentRunSchema.parse(run);
    if (parsed.state.kind !== "active") {
      throw new AgentRunInvariantError("Only active Agent runs may acquire a case claim");
    }
    assertSafeAgentText(parsed);
    assertUniqueHistory(parsed.steps);
    await this.#ownership.create(parsed);
  }

  activeRunId(caseId: string): Promise<string | undefined> {
    if (caseId.length === 0) throw new TypeError("An Agent case ID is required");
    return this.#ownership.activeRunId(caseId);
  }

  recoverActiveCase(caseId: string): Promise<AgentRunSnapshot | undefined> {
    if (caseId.length === 0) throw new TypeError("An Agent case ID is required");
    return this.#ownership.recover(caseId);
  }

  releaseOwned(caseId: string, runId: string): Promise<void> {
    if (caseId.length === 0 || runId.length === 0) {
      throw new TypeError("Agent case and run IDs are required");
    }
    return this.#ownership.release(caseId, runId);
  }

  async resumeOwned(snapshot: AgentRunSnapshot): Promise<AgentRunSnapshot> {
    const previous = { run: agentRunSchema.parse(snapshot.run), cursor: snapshot.cursor };
    if (
      previous.run.state.kind !== "interrupted" &&
      !(previous.run.state.kind === "paused" && previous.run.state.reason === "user-paused")
    ) {
      throw new AgentRunInvariantError("Only interrupted or user-paused Agent runs may be resumed");
    }
    const resumed = {
      run: agentRunSchema.parse({ ...previous.run, state: { kind: "active" } }),
      cursor: previous.cursor,
    };
    assertSafeAgentText(resumed.run);
    assertUniqueHistory(resumed.run.steps);
    await this.#ownership.resume(previous, resumed.run);
    return resumed;
  }

  async readCurrent(runId: string): Promise<AgentRunSnapshot> {
    if (runId.length === 0) throw new TypeError("An Agent run ID is required");
    const snapshot = await this.#store.read(runId);
    assertSafeAgentText(snapshot.run);
    assertUniqueHistory(snapshot.run.steps);
    return snapshot;
  }

  async load(runId: string): Promise<AgentRunSnapshot> {
    const snapshot = await this.readCurrent(runId);
    if (snapshot.run.state.kind !== "active") {
      await this.#ownership.release(snapshot.run.caseId, runId);
      return snapshot;
    }
    if (!hasInFlight(snapshot.run.steps.slice(snapshot.cursor))) return snapshot;
    const recovered = {
      run: interruptAgentRunForRestart(snapshot.run, await this.#store.locator(runId)),
      cursor: snapshot.cursor,
    };
    await this.#store.write(recovered, false, snapshot);
    await this.#ownership.release(snapshot.run.caseId, runId);
    return recovered;
  }

  async save(snapshot: AgentRunSnapshot): Promise<void> {
    const candidate = {
      run: agentRunSchema.parse(snapshot.run),
      cursor: snapshot.cursor,
    };
    const existing = await this.#store.read(candidate.run.runId);
    if (same(existing, candidate)) return;
    assertImmutable(existing, candidate);
    if (isIdempotentResultRetry(existing, candidate)) return;
    assertSafeAgentText(candidate.run);
    assertUniqueHistory(candidate.run.steps);
    await this.#store.write(candidate, false, existing);
  }
}
