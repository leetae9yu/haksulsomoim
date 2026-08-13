import { parseApprovedDecisionContext } from "../../integrations/agent-provider/agent-decision-contracts";
import type { RuntimeCaseMutationQueue } from "../runtime-case-mutation-queue";
import type { AgentRun } from "./agent-contracts";
import { commitAgentRun } from "./agent-loop-checkpoints";
import { type ToolCorrelationBinding, toolResults } from "./agent-loop-decisions";
import { AgentLoopClockError, AgentLoopStateError } from "./agent-loop-errors";
import type {
  AgentCaseProjection,
  AgentCaseProjectionReader,
  AgentLoopClock,
  AgentLoopIdentifiers,
  AgentLoopProvider,
  AgentRunStore,
} from "./agent-loop-types";
import type { AgentRunSnapshot } from "./agent-run-repository";
import type { AgentToolRegistry } from "./agent-tool-registry";

export interface AgentLoopRuntimeDependencies {
  readonly runs: AgentRunStore;
  readonly projections: AgentCaseProjectionReader;
  readonly provider: () => Promise<AgentLoopProvider>;
  readonly tools: AgentToolRegistry;
  readonly mutations: RuntimeCaseMutationQueue;
  readonly clock: AgentLoopClock;
  readonly identifiers: AgentLoopIdentifiers;
  readonly publish?: (run: AgentRun) => void;
}

export type AgentLoopControl = {
  readonly caseId: string;
  readonly runId: string;
  readonly approvedContextDigest: string;
  readonly citationIds: Set<string>;
  readonly toolCorrelations: Map<string, ToolCorrelationBinding>;
  snapshot: AgentRunSnapshot;
  provider?: AgentLoopProvider;
  cancellation?: Promise<AgentRun>;
  pause?: Promise<AgentRun>;
  readonly cancellationRequested: Promise<void>;
  readonly requestCancellation: () => void;
  cancelled: boolean;
  lastClock: number;
};

function clockValue(clock: AgentLoopClock): number {
  const value = clock.now();
  if (!Number.isFinite(value)) throw new AgentLoopClockError();
  return value;
}

export function createAgentLoopControl(
  dependencies: AgentLoopRuntimeDependencies,
  caseId: string,
  runId: string,
  approvedContextDigest: string,
  citationIds: readonly string[],
  snapshot: AgentRunSnapshot,
): AgentLoopControl {
  let requestCancellation = (): void => undefined;
  const cancellationRequested = new Promise<void>((resolve) => {
    requestCancellation = resolve;
  });
  return {
    caseId,
    runId,
    approvedContextDigest,
    citationIds: new Set(citationIds),
    toolCorrelations: new Map(),
    snapshot,
    cancellationRequested,
    requestCancellation,
    cancelled: false,
    lastClock: clockValue(dependencies.clock),
  };
}

export function remainingDuration(
  dependencies: AgentLoopRuntimeDependencies,
  control: AgentLoopControl,
  run: AgentRun,
): number {
  const now = clockValue(dependencies.clock);
  if (now < control.lastClock) throw new AgentLoopClockError();
  const elapsed = Math.floor(now - control.lastClock);
  control.lastClock = now;
  return Math.max(0, run.budget.durationMsRemaining - elapsed);
}

export async function commitControlRun(
  dependencies: AgentLoopRuntimeDependencies,
  control: AgentLoopControl,
  run: AgentRun,
  settled: boolean,
): Promise<void> {
  control.snapshot = await commitAgentRun(dependencies.runs, control.snapshot, run, settled);
  dependencies.publish?.(run);
}

export async function loadAgentProjection(
  dependencies: AgentLoopRuntimeDependencies,
  caseId: string,
): Promise<AgentCaseProjection> {
  const projection = await dependencies.projections.load(caseId);
  if (projection.caseId !== caseId) throw new AgentLoopStateError("Agent projection case mismatch");
  return projection;
}

export function approvedDecisionContext(
  run: AgentRun,
  projection: AgentCaseProjection,
  control: AgentLoopControl,
) {
  const citationIds = [...new Set([...projection.citationIds, ...control.citationIds])];
  return parseApprovedDecisionContext({
    approval: "user-approved",
    contextDigest: control.approvedContextDigest,
    goal: run.goal,
    maskedFacts: projection.maskedFacts,
    citationIds,
    observations: toolResults(run),
  });
}
