import type { AgentRun, AgentStep } from "./agent-contracts";
import { agentRunSchema } from "./agent-contracts";
import { type AgentRunSnapshot, EncryptedAgentRunRecordStore } from "./agent-run-repository-record";

export {
  AgentRunAlreadyExistsError,
  AgentRunNotFoundError,
  type AgentRunSnapshot,
  ConcurrentAgentRunSaveError,
} from "./agent-run-repository-record";

export interface AgentRunRepositoryOptions {
  readonly directory: string;
  readonly encryptionKey: Uint8Array;
}

export class AgentRunInvariantError extends Error {
  readonly code = "AGENT_RUN_INVARIANT";

  constructor(message: string) {
    super(message);
    this.name = "AgentRunInvariantError";
  }
}

const SENSITIVE_TEXT = [
  /(?<!\d)\d{6}-?[1-4]\d{6}(?!\d)/u,
  /(?<!\d)01[016789][ -]?\d{3,4}[ -]?\d{4}(?!\d)/u,
  /(?<!\d)\d{2,6}(?:-\d{2,6}){2,4}(?!\d)/u,
  /(?<!\d)(?:19|20)\d{2}[가-힣]{1,4}\d{1,10}(?!\d)/u,
  /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu,
  /\b(?:bearer|api[_-]?key|secret)\s*[:=]\s*\S+/iu,
  /\bsk-[A-Za-z0-9_-]{16,}\b/u,
] as const;

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertSafeText(run: AgentRun): void {
  for (const step of run.steps) {
    const call =
      step.kind === "decision-recorded" && step.decision.kind === "tool"
        ? step.decision.toolCall
        : step.kind === "tool-started"
          ? step.toolCall
          : undefined;
    if (call?.toolName !== "search-official-law") continue;
    if (SENSITIVE_TEXT.some((pattern) => pattern.test(call.query))) {
      throw new AgentRunInvariantError("Persisted Agent text must be redacted");
    }
  }
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

function interrupted(run: AgentRun, locator: string): AgentRun {
  const interruption = { kind: "application-restarted" as const };
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

export class AgentRunRepository {
  readonly #store: EncryptedAgentRunRecordStore;

  constructor(options: AgentRunRepositoryOptions) {
    if (options.directory.length === 0) throw new TypeError("An Agent run directory is required");
    if (options.encryptionKey.byteLength !== 32) {
      throw new RangeError("AES-256-GCM requires a 32-byte encryption key");
    }
    this.#store = new EncryptedAgentRunRecordStore(options.directory, options.encryptionKey);
  }

  async create(run: AgentRun): Promise<void> {
    const parsed = agentRunSchema.parse(run);
    assertSafeText(parsed);
    assertUniqueHistory(parsed.steps);
    await this.#store.write({ run: parsed, cursor: 0 }, true);
  }

  async load(runId: string): Promise<AgentRunSnapshot> {
    if (runId.length === 0) throw new TypeError("An Agent run ID is required");
    const snapshot = await this.#store.read(runId);
    assertSafeText(snapshot.run);
    assertUniqueHistory(snapshot.run.steps);
    if (
      snapshot.run.state.kind === "interrupted" ||
      !hasInFlight(snapshot.run.steps.slice(snapshot.cursor))
    ) {
      return snapshot;
    }
    const recovered = {
      run: interrupted(snapshot.run, this.#store.locator(runId)),
      cursor: snapshot.cursor,
    };
    await this.#store.write(recovered, false, snapshot);
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
    assertSafeText(candidate.run);
    assertUniqueHistory(candidate.run.steps);
    await this.#store.write(candidate, false, existing);
  }
}
