import type { RedactedText } from "../../security/redaction";
import {
  type AgentCitationProvenance,
  type AgentToolCall,
  type AgentToolResult,
  agentCitationProvenanceSchema,
  agentToolCallSchema,
} from "./agent-contracts";
import { AgentToolPolicyError } from "./agent-loop-errors";
import type { AgentCaseProjection } from "./agent-loop-types";
import type { AgentToolExecutionContext } from "./agent-tool-execution";
import type {
  AgentEncryptedDraftWriter,
  AgentOfficialLawResult,
  AgentOfficialLawTools,
} from "./agent-tool-ports";

export type {
  AgentDraftWriteResult,
  AgentEncryptedDraftWriter,
  AgentOfficialLawResult,
  AgentOfficialLawTools,
} from "./agent-tool-ports";

import { type PreparedAgentObservation, prepareAgentObservation } from "./agent-tool-observation";

export type AgentToolExecution = Readonly<{
  status: "completed" | "pending" | "unavailable";
  value: unknown;
  citationIds: readonly string[];
  citations?: readonly AgentCitationProvenance[];
}>;

type RegistryDependencies = Readonly<{
  law: AgentOfficialLawTools;
  drafts: AgentEncryptedDraftWriter;
  redact(caseId: string, value: string): RedactedText;
}>;

const ID = /^[A-Za-z0-9_-]{1,128}$/;

function validCitationIds(ids: readonly string[]): boolean {
  return ids.every((id) => ID.test(id)) && new Set(ids).size === ids.length;
}

function lawExecution(result: AgentOfficialLawResult): AgentToolExecution {
  if (result.status === "unavailable") {
    return { status: "unavailable", value: { reason: result.reason }, citationIds: [] };
  }
  const citations = agentCitationProvenanceSchema.array().safeParse(result.citations);
  if (
    !validCitationIds(result.citationIds) ||
    !citations.success ||
    (citations.data.length > 0 &&
      JSON.stringify(citations.data.map((citation) => citation.citationId)) !==
        JSON.stringify(result.citationIds))
  ) {
    return {
      status: "unavailable",
      value: { reason: "invalid-law-result" },
      citationIds: [],
    };
  }
  return {
    status: "completed",
    value: result.content,
    citationIds: result.citationIds,
    citations: citations.data,
  };
}

export class AgentToolRegistry {
  readonly #dependencies: RegistryDependencies;

  constructor(dependencies: RegistryDependencies) {
    this.#dependencies = dependencies;
  }

  prepareObservation(
    caseId: string,
    call: AgentToolCall,
    execution: AgentToolExecution,
    priorResults: readonly AgentToolResult[] = [],
  ): PreparedAgentObservation {
    return prepareAgentObservation(
      caseId,
      call,
      execution,
      this.#dependencies.redact,
      priorResults,
    );
  }

  sanitize(caseId: string, call: AgentToolCall): AgentToolCall {
    if (call.toolName !== "search-official-law") return call;
    return agentToolCallSchema.parse({
      ...call,
      query: this.#dependencies.redact(caseId, call.query).slice(0, 2_000),
    });
  }

  validate(
    call: AgentToolCall,
    approvedCitationIds: readonly string[],
    approvedObservations: readonly AgentToolResult[] = [],
  ): readonly string[] {
    const completedObservation = (digest: string) =>
      approvedObservations.find(
        (result) => result.outcome === "completed" && result.observationDigest === digest,
      );
    switch (call.toolName) {
      case "inspect-masked-case":
      case "compute-evidence-gaps":
      case "request-user-input":
      case "request-user-action":
        return [];
      case "search-official-law":
        if (
          call.basisObservationDigest !== undefined &&
          completedObservation(call.basisObservationDigest) === undefined
        ) {
          throw new AgentToolPolicyError(
            "Official-law search basis must be a completed observation",
          );
        }
        return [];
      case "read-official-law-detail":
        if (!approvedCitationIds.includes(call.citationId)) {
          throw new AgentToolPolicyError("Official-law detail requires a cited result");
        }
        return [];
      case "write-local-draft": {
        const source = completedObservation(call.contentDigest);
        if (
          source === undefined ||
          (source.toolName !== "search-official-law" &&
            source.toolName !== "read-official-law-detail") ||
          source.citationIds.length === 0
        ) {
          throw new AgentToolPolicyError(
            "Local drafts require an exact cited official-law observation",
          );
        }
        return source.citationIds;
      }
    }
  }

  async execute(
    caseId: string,
    call: AgentToolCall,
    projection: AgentCaseProjection,
    sourceCitationIds: readonly string[] = [],
    context: AgentToolExecutionContext,
  ): Promise<AgentToolExecution> {
    context.signal.throwIfAborted();
    switch (call.toolName) {
      case "inspect-masked-case":
        return {
          status: "completed",
          value: {
            maskedFacts: projection.maskedFacts,
            workflow: projection.workflow,
            evidenceCount: projection.evidenceCount,
            confirmedFactCount: projection.confirmedFactCount,
          },
          citationIds: [],
        };
      case "search-official-law":
        return this.#searchLaw(caseId, call.query, context);
      case "read-official-law-detail":
        return this.#readLaw(call.citationId, context);
      case "compute-evidence-gaps":
        return {
          status: "completed",
          value: {
            gaps: [
              ...(projection.evidenceCount === 0 ? ["evidence-file"] : []),
              ...(projection.confirmedFactCount === 0 ? ["confirmed-facts"] : []),
            ],
          },
          citationIds: [],
        };
      case "write-local-draft":
        return this.#writeDraft(caseId, call, projection, sourceCitationIds, context);
      case "request-user-input":
        return {
          status: "pending",
          value: { kind: "user-input", field: call.field },
          citationIds: [],
        };
      case "request-user-action":
        return {
          status: "pending",
          value: { kind: "user-action", action: call.action },
          citationIds: [],
        };
    }
  }

  async #searchLaw(
    caseId: string,
    query: string,
    context: AgentToolExecutionContext,
  ): Promise<AgentToolExecution> {
    try {
      const safeQuery = this.#dependencies.redact(caseId, query).slice(0, 2_000);
      return lawExecution(await this.#dependencies.law.search(safeQuery, context));
    } catch (error) {
      if (context.signal.aborted) throw error;
      return { status: "unavailable", value: { reason: "mcp-unavailable" }, citationIds: [] };
    }
  }

  async #readLaw(
    citationId: string,
    context: AgentToolExecutionContext,
  ): Promise<AgentToolExecution> {
    try {
      return lawExecution(await this.#dependencies.law.detail(citationId, context));
    } catch (error) {
      if (context.signal.aborted) throw error;
      return { status: "unavailable", value: { reason: "mcp-unavailable" }, citationIds: [] };
    }
  }

  async #writeDraft(
    caseId: string,
    call: Extract<AgentToolCall, { toolName: "write-local-draft" }>,
    projection: AgentCaseProjection,
    citationIds: readonly string[],
    context: AgentToolExecutionContext,
  ): Promise<AgentToolExecution> {
    try {
      const result = await this.#dependencies.drafts.write(
        {
          caseId,
          artifactKind: call.artifactKind,
          contentDigest: call.contentDigest,
          idempotencyKey: call.toolCallId,
          maskedFacts: projection.maskedFacts,
          citationIds: [...new Set(citationIds)].slice(0, 24),
        },
        context,
      );
      return result.status === "ok"
        ? { status: "completed", value: { artifactId: result.artifactId }, citationIds: [] }
        : { status: "unavailable", value: { reason: result.reason }, citationIds: [] };
    } catch (error) {
      if (context.signal.aborted) throw error;
      return {
        status: "unavailable",
        value: { reason: "writer-unavailable" },
        citationIds: [],
      };
    }
  }
}
