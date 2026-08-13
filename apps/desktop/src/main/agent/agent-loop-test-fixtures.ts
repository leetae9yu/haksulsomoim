import type { ApprovedAgentDecisionContext } from "../../integrations/agent-provider/agent-provider";
import { Redactor } from "../../security/redaction";
import { RuntimeCaseMutationQueue } from "../runtime-case-mutation-queue";
import { type AgentGoal, type AgentRun, agentGoalSchema } from "./agent-contracts";
import {
  type AgentLoopClock,
  type AgentLoopProvider,
  AgentLoopService,
} from "./agent-loop-service";
import type { AgentCaseProjection, AgentCaseProjectionReader } from "./agent-loop-types";
import {
  AgentCaseAlreadyClaimedError,
  AgentCaseClaimInvariantError,
  type AgentRunSnapshot,
} from "./agent-run-repository";
import { type AgentOfficialLawTools, AgentToolRegistry } from "./agent-tool-registry";

export const DIGEST_A = "a".repeat(64);
export const DIGEST_B = "b".repeat(64);
export const DIGEST_C = "c".repeat(64);

export class MemoryAgentRunStore {
  readonly snapshots = new Map<string, AgentRunSnapshot>();
  readonly saves: AgentRunSnapshot[] = [];
  readonly #owners = new Map<string, string>();

  async create(run: AgentRun): Promise<void> {
    this.snapshots.set(run.runId, structuredClone({ run, cursor: 0 }));
  }

  async createOwned(run: AgentRun): Promise<void> {
    if (this.#owners.has(run.caseId)) throw new AgentCaseAlreadyClaimedError();
    this.#owners.set(run.caseId, run.runId);
    try {
      await this.create(run);
    } catch (error) {
      if (this.#owners.get(run.caseId) === run.runId) this.#owners.delete(run.caseId);
      throw error;
    }
  }

  async releaseOwned(caseId: string, runId: string): Promise<void> {
    const owner = this.#owners.get(caseId);
    if (owner === undefined) return;
    if (owner !== runId) throw new AgentCaseClaimInvariantError("Agent owner mismatch");
    const snapshot = await this.load(runId);
    if (snapshot.run.state.kind === "active") {
      throw new AgentCaseClaimInvariantError("Cannot release an active Agent run");
    }
    this.#owners.delete(caseId);
  }

  async load(runId: string): Promise<AgentRunSnapshot> {
    const snapshot = this.snapshots.get(runId);
    if (snapshot === undefined) throw new Error("unknown run");
    return structuredClone(snapshot);
  }

  async save(snapshot: AgentRunSnapshot): Promise<void> {
    const copy = structuredClone(snapshot);
    this.snapshots.set(snapshot.run.runId, copy);
    this.saves.push(copy);
  }
}

export class MutableProjectionReader implements AgentCaseProjectionReader {
  projection: AgentCaseProjection;

  constructor(caseId = "case-1") {
    const redactor = new Redactor(new Uint8Array(32).fill(3));
    this.projection = {
      caseId,
      contextDigest: DIGEST_A,
      maskedFacts: [
        { id: "amount-krw", text: redactor.redact(caseId, "amountKrw: 5380000") },
        { id: "civil-state", text: redactor.redact(caseId, "civilState: pre-filing") },
      ],
      citationIds: [],
      workflow: { criminalState: "evidence-review", civilState: "pre-filing" },
      evidenceCount: 1,
      confirmedFactCount: 1,
    };
  }

  async load(caseId: string): Promise<AgentCaseProjection> {
    if (caseId !== this.projection.caseId) throw new Error("unknown case");
    return structuredClone(this.projection);
  }
}

type DecisionSource = (
  input: ApprovedAgentDecisionContext,
  index: number,
) => unknown | Promise<unknown>;

export class RecordingProvider implements AgentLoopProvider {
  readonly state: AgentLoopProvider["state"] = { status: "authenticated" };
  readonly inputs: ApprovedAgentDecisionContext[] = [];
  interruptCalls = 0;
  readonly #source: DecisionSource;

  constructor(source: DecisionSource) {
    this.#source = source;
  }

  async nextDecision(input: ApprovedAgentDecisionContext): Promise<unknown> {
    const index = this.inputs.length;
    this.inputs.push(structuredClone(input));
    return this.#source(input, index);
  }

  async interrupt(): Promise<void> {
    this.interruptCalls += 1;
  }
}

export class MutableClock implements AgentLoopClock {
  value = 0;
  now(): number {
    return this.value;
  }
}

export function civilGoal(caseId = "case-1"): AgentGoal {
  return agentGoalSchema.parse({
    kind: "civil-recovery",
    caseId,
    objective: "prepare-civil-demand",
  });
}

export function createLoopHarness(
  provider: AgentLoopProvider,
  options: Readonly<{
    projection?: MutableProjectionReader;
    law?: AgentOfficialLawTools;
    clock?: MutableClock;
  }> = {},
) {
  const runs = new MemoryAgentRunStore();
  const projection = options.projection ?? new MutableProjectionReader();
  const clock = options.clock ?? new MutableClock();
  const lawSearches: string[] = [];
  const lawDetails: string[] = [];
  const draftWrites: string[] = [];
  const draftIdempotencyKeys: string[] = [];
  const defaultLaw: AgentOfficialLawTools = {
    async search(query) {
      lawSearches.push(query);
      return {
        status: "ok",
        content: { law: "민사소송법", article: "지급명령" },
        citationIds: ["citation-1"],
      };
    },
    async detail(citationId) {
      lawDetails.push(citationId);
      return { status: "ok", content: { citationId }, citationIds: [citationId] };
    },
  };
  const law = options.law ?? defaultLaw;
  let runNumber = 0;
  let decisionNumber = 0;
  let toolNumber = 0;
  let approvalNumber = 0;
  let stepNumber = 0;
  const redactor = new Redactor(new Uint8Array(32).fill(4));
  const tools = new AgentToolRegistry({
    law,
    redact: (caseId, value) => redactor.redact(caseId, value),
    drafts: {
      async write(input) {
        draftWrites.push(input.contentDigest);
        draftIdempotencyKeys.push(input.idempotencyKey);
        return { status: "ok", artifactId: `artifact-${draftWrites.length}` };
      },
    },
  });
  const service = new AgentLoopService({
    runs,
    projections: projection,
    provider: async () => provider,
    tools,
    mutations: new RuntimeCaseMutationQueue(),
    clock,
    identifiers: {
      nextRunId: () => `run-${++runNumber}`,
      nextDecisionId: () => `decision-${++decisionNumber}`,
      nextToolCallId: () => `tool-${++toolNumber}`,
      nextApprovalId: () => `approval-${++approvalNumber}`,
      nextStepId: () => `step-${++stepNumber}`,
    },
  });
  return {
    clock,
    draftIdempotencyKeys,
    draftWrites,
    lawDetails,
    lawSearches,
    projection,
    runs,
    service,
  };
}
