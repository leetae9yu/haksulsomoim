import { createHash } from "node:crypto";
import type { AgentRun } from "./agent-contracts";
import {
  type AgentOfficialCitationProjection,
  agentOfficialCitationProjectionSchema,
} from "./agent-ipc-projections";

export function projectAgentCitations(run: AgentRun): readonly AgentOfficialCitationProjection[] {
  const records = run.steps.flatMap((step) =>
    step.kind === "tool-finished" &&
    step.result.outcome === "completed" &&
    (step.result.toolName === "search-official-law" ||
      step.result.toolName === "read-official-law-detail")
      ? step.result.citations.map((citation) => ({ stepId: step.stepId, citation }))
      : [],
  );
  const seen = new Set<string>();
  const distinct = records.filter((record) => {
    const key = JSON.stringify(record.citation);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const idCounts = new Map<string, number>();
  for (const { citation } of distinct) {
    idCounts.set(citation.citationId, (idCounts.get(citation.citationId) ?? 0) + 1);
  }
  return agentOfficialCitationProjectionSchema.array().parse(
    distinct.slice(0, 24).map(({ stepId, citation }) => ({
      citationId:
        idCounts.get(citation.citationId) === 1
          ? citation.citationId
          : createHash("sha256").update(JSON.stringify(citation)).digest("hex"),
      stepId,
      sourceUrl: citation.sourceUrl,
      law: citation.law,
      versionDate: citation.versionDate,
      retrievedAt: citation.retrievedAt,
    })),
  );
}
