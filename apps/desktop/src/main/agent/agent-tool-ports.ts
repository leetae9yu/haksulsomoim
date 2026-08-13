import type { KoreanLawCitation } from "../../integrations/korean-law-mcp/korean-law-mcp";
import type { AgentCaseProjection } from "./agent-loop-types";
import type { AgentToolExecutionContext } from "./agent-tool-execution";

export type AgentOfficialLawResult =
  | Readonly<{
      status: "ok";
      content: unknown;
      citationIds: readonly string[];
      citations: readonly KoreanLawCitation[];
    }>
  | Readonly<{ status: "unavailable"; reason: "credentials" | "mcp-unavailable" }>;

export interface AgentOfficialLawTools {
  search(query: string, context: AgentToolExecutionContext): Promise<AgentOfficialLawResult>;
  detail(citationId: string, context: AgentToolExecutionContext): Promise<AgentOfficialLawResult>;
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
    context: AgentToolExecutionContext,
  ): Promise<AgentDraftWriteResult>;
}
