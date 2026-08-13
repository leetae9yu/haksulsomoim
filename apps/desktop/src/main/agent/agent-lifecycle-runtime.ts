import type { KoreanLawCitation } from "../../integrations/korean-law-mcp/korean-law-mcp";
import type { AgentLifecycleService } from "../ipc-handlers";
import { type AgentRun, agentGoalSchema } from "./agent-contracts";
import type {
  AgentApprovalDecisionIpcRequest,
  AgentRunBinding,
  AgentRunListRequest,
  AgentRunResumeRequest,
} from "./agent-ipc-contracts";
import type { AgentRunRepository } from "./agent-run-repository";
import type { DesktopAgentRuntime } from "./agent-runtime";

type RendererListener = (event: unknown) => void;
type CitationReader = (caseId: string) => Promise<readonly KoreanLawCitation[]>;

export class AgentLifecycleRuntime implements AgentLifecycleService {
  readonly #runtime: DesktopAgentRuntime;
  readonly #runs: AgentRunRepository;
  readonly #readCitations: CitationReader;
  readonly #contexts = new Map<string, string>();
  readonly #knownRuns = new Map<string, Set<string>>();
  readonly #listeners = new Map<string, Set<RendererListener>>();

  constructor(
    runtime: DesktopAgentRuntime,
    runs: AgentRunRepository,
    readCitations: CitationReader,
  ) {
    this.#runtime = runtime;
    this.#runs = runs;
    this.#readCitations = readCitations;
  }

  async openCase(caseId: string) {
    const opened = await this.#runtime.openCase(caseId);
    this.#contexts.set(caseId, opened.contextDigest);
    if (opened.interruptedRun !== undefined) this.#remember(opened.interruptedRun);
    return { caseId, contextDigest: opened.contextDigest };
  }

  async start(request: Readonly<{ caseId: string; goal: unknown; approvedContextDigest: string }>) {
    this.#assertContext(request.caseId, request.approvedContextDigest);
    const result = await this.#runtime.start({
      caseId: request.caseId,
      goal: agentGoalSchema.parse(request.goal),
      approvedContextDigest: request.approvedContextDigest,
    });
    if (result.status === "unavailable") throw new Error("Agent lifecycle is unavailable");
    return this.#record(result.run);
  }

  async get(request: AgentRunBinding) {
    this.#assertContext(request.caseId, request.contextDigest);
    const run = (await this.#runs.load(request.runId)).run;
    this.#assertCase(run, request.caseId);
    return this.#source(run);
  }

  async list(request: AgentRunListRequest) {
    if (!this.#contexts.has(request.caseId)) await this.openCase(request.caseId);
    const runIds = [...(this.#knownRuns.get(request.caseId) ?? [])];
    return Promise.all(
      runIds.map(async (runId) => {
        const run = (await this.#runs.load(runId)).run;
        this.#assertCase(run, request.caseId);
        return this.#source(run);
      }),
    );
  }

  async pause(request: AgentRunBinding) {
    this.#assertContext(request.caseId, request.contextDigest);
    const run = (await this.#runs.load(request.runId)).run;
    this.#assertCase(run, request.caseId);
    if (run.state.kind === "active") throw new Error("Active Agent pause is unavailable");
    return this.#source(run);
  }

  async resume(request: AgentRunResumeRequest) {
    this.#assertContext(request.caseId, request.contextDigest);
    const result = await this.#runtime.resume({
      caseId: request.caseId,
      runId: request.runId,
      approvedContextDigest: request.contextDigest,
    });
    if (result.status === "unavailable") throw new Error("Agent lifecycle is unavailable");
    return this.#record(result.run);
  }

  async cancel(request: AgentRunBinding) {
    this.#assertContext(request.caseId, request.contextDigest);
    return this.#record(
      await this.#runtime.cancel({ caseId: request.caseId, runId: request.runId }),
    );
  }

  async decideApproval(request: AgentApprovalDecisionIpcRequest) {
    this.#assertContext(request.caseId, request.contextDigest);
    const result = await this.#runtime.decideApproval({
      caseId: request.caseId,
      runId: request.runId,
      approvalId: request.approvalId,
      approvalDigest: request.approvalDigest,
      outcome: request.outcome,
    });
    return { status: result.status, run: await this.#record(result.run) };
  }

  subscribe(request: AgentRunBinding, listener: RendererListener): () => void {
    this.#assertContext(request.caseId, request.contextDigest);
    const key = this.#key(request.caseId, request.runId);
    const listeners = this.#listeners.get(key) ?? new Set<RendererListener>();
    listeners.add(listener);
    this.#listeners.set(key, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.#listeners.delete(key);
    };
  }

  async #record(run: AgentRun) {
    this.#remember(run);
    const projection = await this.#source(run);
    const event = { caseId: run.caseId, runId: run.runId, projection };
    for (const listener of this.#listeners.get(this.#key(run.caseId, run.runId)) ?? []) {
      listener(event);
    }
    return projection;
  }

  async #source(run: AgentRun) {
    const officialStep = run.steps.findLast(
      (step) =>
        step.kind === "tool-finished" &&
        step.result.outcome === "completed" &&
        (step.result.toolName === "search-official-law" ||
          step.result.toolName === "read-official-law-detail"),
    );
    const citations =
      officialStep === undefined
        ? []
        : (await this.#readCitations(run.caseId)).slice(0, 24).map((citation) => ({
            citationId: citation.citationId,
            stepId: officialStep.stepId,
            sourceUrl: citation.sourceUrl,
            law: citation.law.trim().slice(0, 160),
            versionDate: citation.versionDate,
            retrievedAt: citation.retrievedAt,
          }));
    return { run, citations };
  }

  #remember(run: AgentRun): void {
    const known = this.#knownRuns.get(run.caseId) ?? new Set<string>();
    known.add(run.runId);
    this.#knownRuns.set(run.caseId, known);
  }

  #assertContext(caseId: string, contextDigest: string): void {
    if (this.#contexts.get(caseId) !== contextDigest) {
      throw new Error("Agent context consent is stale");
    }
  }

  #assertCase(run: AgentRun, caseId: string): void {
    if (run.caseId !== caseId) throw new Error("Agent run belongs to another case");
  }

  #key(caseId: string, runId: string): string {
    return `${caseId}\0${runId}`;
  }
}
