import { createHash, randomBytes } from "node:crypto";
import type { CodexAgentDecisionProvider } from "../../integrations/agent-provider/agent-provider";
import type { KoreanLawMcpAdapter } from "../../integrations/korean-law-mcp/korean-law-mcp";
import type { Redactor } from "../../security/redaction";
import type { RuntimeCaseMutationQueue } from "../runtime-case-mutation-queue";
import type { RuntimeCaseRepository } from "../runtime-case-types";
import type { AgentLoopRuntimeDependencies } from "./agent-loop-runtime";
import type { AgentCaseProjectionReader, AgentLoopClock } from "./agent-loop-types";
import type { AgentRunRepository } from "./agent-run-repository";
import type { AgentExecutionTimer } from "./agent-tool-execution";
import {
  type AgentEncryptedDraftWriter,
  type AgentOfficialLawResult,
  AgentToolRegistry,
} from "./agent-tool-registry";

export type AgentRuntimeExternalDependencies = Readonly<{
  law: KoreanLawMcpAdapter;
  provider(signal?: AbortSignal): Promise<CodexAgentDecisionProvider>;
}>;

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function createAgentProjectionReader(
  cases: RuntimeCaseRepository,
  redactor: Redactor,
): AgentCaseProjectionReader {
  return {
    async load(caseId) {
      const dossier = await cases.read(caseId);
      const facts = [
        { id: "amount-krw", value: `amountKrw: ${dossier.amountKrw}` },
        { id: "criminal-state", value: `criminalState: ${dossier.workflow.criminalState}` },
        { id: "civil-state", value: `civilState: ${dossier.workflow.civilState}` },
        ...dossier.confirmedOcrFacts.map((fact, index) => ({
          id: `confirmed-fact-${index + 1}`,
          value: `${fact.field}: ${fact.value}`,
        })),
      ];
      const maskedFacts = facts.map((fact) => ({
        id: fact.id,
        text: redactor.redact(caseId, fact.value),
      }));
      const citationIds = dossier.retrievedCitations.map((citation) => citation.citationId);
      const workflow = {
        criminalState: dossier.workflow.criminalState,
        civilState: dossier.workflow.civilState,
      };
      return {
        caseId,
        contextDigest: digest({
          maskedFacts,
          citationIds,
          workflow,
          evidence: dossier.evidence.length,
        }),
        maskedFacts,
        citationIds,
        workflow,
        evidenceCount: dossier.evidence.length,
        confirmedFactCount: dossier.confirmedOcrFacts.length,
      };
    },
  };
}

function lawResult(
  result: Awaited<ReturnType<KoreanLawMcpAdapter["execute"]>>,
): AgentOfficialLawResult {
  if (!result.ok) {
    return {
      status: "unavailable",
      reason: result.error.code === "needs_credentials" ? "credentials" : "mcp-unavailable",
    };
  }
  return {
    status: "ok",
    content: result.value.content,
    citationIds: result.value.citations.map((citation) => citation.citationId),
    citations: result.value.citations,
  };
}

export function createAgentLoopDependencies(
  input: Readonly<{
    runs: AgentRunRepository;
    cases: RuntimeCaseRepository;
    redactor: Redactor;
    external: AgentRuntimeExternalDependencies;
    drafts: AgentEncryptedDraftWriter;
    mutations: RuntimeCaseMutationQueue;
    clock?: AgentLoopClock;
    timer?: AgentExecutionTimer;
    toolTimeoutMs?: number;
    toolSettlementGraceMs?: number;
  }>,
): AgentLoopRuntimeDependencies {
  const projections = createAgentProjectionReader(input.cases, input.redactor);
  const id = (prefix: string) => `${prefix}_${randomBytes(12).toString("hex")}`;
  const tools = new AgentToolRegistry({
    law: {
      async search(query, context) {
        return lawResult(await input.external.law.execute("search_law", { query }, context));
      },
      async detail(citationId, context) {
        return lawResult(
          await input.external.law.execute("get_law_text", { citation_id: citationId }, context),
        );
      },
    },
    drafts: input.drafts,
    redact: (caseId, value) => input.redactor.redact(caseId, value),
  });
  return {
    runs: input.runs,
    projections,
    provider: input.external.provider,
    tools,
    mutations: input.mutations,
    clock: input.clock ?? { now: () => performance.now() },
    ...(input.timer === undefined ? {} : { timer: input.timer }),
    ...(input.toolTimeoutMs === undefined ? {} : { toolTimeoutMs: input.toolTimeoutMs }),
    ...(input.toolSettlementGraceMs === undefined
      ? {}
      : { toolSettlementGraceMs: input.toolSettlementGraceMs }),
    identifiers: {
      nextRunId: () => id("run"),
      nextDecisionId: () => id("decision"),
      nextToolCallId: () => id("tool"),
      nextApprovalId: () => id("approval"),
      nextStepId: () => id("step"),
    },
  };
}
