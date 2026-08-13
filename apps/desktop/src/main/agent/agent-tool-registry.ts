import type { RedactedText } from "../../security/redaction";
import { type AgentToolCall, agentToolCallSchema } from "./agent-contracts";
import { AgentToolPolicyError } from "./agent-loop-errors";
import type { AgentCaseProjection } from "./agent-loop-types";
import { type PreparedAgentObservation, prepareAgentObservation } from "./agent-tool-observation";

export type AgentOfficialLawResult =
  | Readonly<{ status: "ok"; content: unknown; citationIds: readonly string[] }>
  | Readonly<{ status: "unavailable"; reason: "credentials" | "mcp-unavailable" }>;

export interface AgentOfficialLawTools {
  search(query: string): Promise<AgentOfficialLawResult>;
  detail(citationId: string): Promise<AgentOfficialLawResult>;
}

export type AgentDraftWriteResult =
  | Readonly<{ status: "ok"; artifactId: string }>
  | Readonly<{ status: "unavailable"; reason: "writer-unavailable" }>;

export interface AgentEncryptedDraftWriter {
  write(
    input: Readonly<{
      caseId: string;
      artifactKind: "civil-demand" | "criminal-complaint";
      contentDigest: string;
      idempotencyKey: string;
      maskedFacts: AgentCaseProjection["maskedFacts"];
      citationIds: readonly string[];
    }>,
  ): Promise<AgentDraftWriteResult>;
}

export type AgentToolExecution = Readonly<{
  status: "completed" | "pending" | "unavailable";
  value: unknown;
  citationIds: readonly string[];
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
  if (!validCitationIds(result.citationIds)) {
    return {
      status: "unavailable",
      value: { reason: "invalid-law-result" },
      citationIds: [],
    };
  }
  return { status: "completed", value: result.content, citationIds: result.citationIds };
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
  ): PreparedAgentObservation {
    return prepareAgentObservation(caseId, call, execution, this.#dependencies.redact);
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
    approvedObservationDigests: readonly string[] = [],
  ): void {
    switch (call.toolName) {
      case "inspect-masked-case":
      case "compute-evidence-gaps":
      case "request-user-input":
      case "request-user-action":
        return;
      case "search-official-law":
        if (
          call.basisObservationDigest !== undefined &&
          !approvedObservationDigests.includes(call.basisObservationDigest)
        ) {
          throw new AgentToolPolicyError(
            "Official-law search basis must be a completed observation",
          );
        }
        return;
      case "read-official-law-detail":
        if (!approvedCitationIds.includes(call.citationId)) {
          throw new AgentToolPolicyError("Official-law detail requires a cited result");
        }
        return;
      case "write-local-draft":
        if (!approvedObservationDigests.includes(call.contentDigest)) {
          throw new AgentToolPolicyError("Local drafts require a completed observation");
        }
        if (approvedCitationIds.length === 0) {
          throw new AgentToolPolicyError("Local drafts require an official citation");
        }
        return;
    }
  }

  async execute(
    caseId: string,
    call: AgentToolCall,
    projection: AgentCaseProjection,
    approvedCitationIds: readonly string[] = projection.citationIds,
  ): Promise<AgentToolExecution> {
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
        return this.#searchLaw(caseId, call.query);
      case "read-official-law-detail":
        return this.#readLaw(call.citationId);
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
        return this.#writeDraft(caseId, call, projection, approvedCitationIds);
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

  async #searchLaw(caseId: string, query: string): Promise<AgentToolExecution> {
    try {
      const safeQuery = this.#dependencies.redact(caseId, query).slice(0, 2_000);
      return lawExecution(await this.#dependencies.law.search(safeQuery));
    } catch {
      return { status: "unavailable", value: { reason: "mcp-unavailable" }, citationIds: [] };
    }
  }

  async #readLaw(citationId: string): Promise<AgentToolExecution> {
    try {
      return lawExecution(await this.#dependencies.law.detail(citationId));
    } catch {
      return { status: "unavailable", value: { reason: "mcp-unavailable" }, citationIds: [] };
    }
  }

  async #writeDraft(
    caseId: string,
    call: Extract<AgentToolCall, { toolName: "write-local-draft" }>,
    projection: AgentCaseProjection,
    citationIds: readonly string[],
  ): Promise<AgentToolExecution> {
    try {
      const result = await this.#dependencies.drafts.write({
        caseId,
        artifactKind: call.artifactKind,
        contentDigest: call.contentDigest,
        idempotencyKey: call.toolCallId,
        maskedFacts: projection.maskedFacts,
        citationIds: [...new Set(citationIds)].slice(0, 24),
      });
      return result.status === "ok"
        ? { status: "completed", value: { artifactId: result.artifactId }, citationIds: [] }
        : { status: "unavailable", value: { reason: result.reason }, citationIds: [] };
    } catch {
      return {
        status: "unavailable",
        value: { reason: "writer-unavailable" },
        citationIds: [],
      };
    }
  }
}
