import { basename } from "node:path";
import type { MutableMetrics } from "./qa-wiki-metrics.ts";
import { increment } from "./qa-wiki-metrics.ts";
import type { ParsedCorpus } from "./qa-wiki-parse.ts";

const task10LedgerNames = [
  "candidates.md",
  "conflicts.md",
  "redirects.md",
  "saturation.md",
] as const;

function duplicateExcess(values: readonly string[]): number {
  return values.length - new Set(values).size;
}

export function checkCandidates(corpus: ParsedCorpus, metrics: MutableMetrics): void {
  const candidates = corpus.records.filter((record) => record.record_type === "candidate");
  const occurrences = corpus.records.filter(
    (record) => record.record_type === "candidate_occurrence",
  );
  const saturation = corpus.records.filter((record) => record.record_type === "saturation");
  const task10Required = corpus.files.some((file) =>
    task10LedgerNames.some((name) => basename(file.path) === name),
  );
  const identities = candidates.map((record) => record.candidate_identity);
  const occurrenceIds = occurrences.map((record) => record.id);
  const sourceOccurrenceIds = occurrences.map((record) => record.source_occurrence_id);
  const provenanceIds = candidates.flatMap((record) => record.occurrence_ids);
  const queue = candidates.filter((record) => record.status !== "terminal");

  metrics["candidate-identity-records"] = candidates.length;
  metrics["candidate-occurrence-records"] = occurrences.length;
  metrics["candidate-provenance-links"] = provenanceIds.length;
  metrics["terminal-candidate-records"] = candidates.length - queue.length;
  metrics["candidate-identities"] = new Set(identities).size;
  metrics["candidate-occurrences"] = new Set(occurrenceIds).size;
  metrics["candidate-queue-count"] = queue.length;
  if (!task10Required) return;
  if (candidates.length === 0 || occurrences.length === 0)
    increment(metrics, "missing-candidate-inventory");
  increment(metrics, "duplicate-candidate-identities", duplicateExcess(identities));
  increment(
    metrics,
    "duplicate-candidate-occurrence-ids",
    duplicateExcess(occurrenceIds) + duplicateExcess(sourceOccurrenceIds),
  );
  increment(metrics, "candidate-inventory-queue", queue.length);
  if (provenanceIds.length !== new Set(occurrenceIds).size)
    increment(metrics, "candidate-provenance-count-mismatch");
  const latest = saturation
    .filter((record) => record.scope === "global" && record.status === "saturated")
    .toSorted((left, right) => left.searched_at.localeCompare(right.searched_at))
    .at(-1);
  if (latest !== undefined && candidates.length - queue.length !== latest.candidate_identity_count)
    increment(metrics, "terminal-candidate-count-mismatch");

  const candidatesById = new Map(candidates.map((record) => [record.id, record]));
  const occurrencesById = new Map(occurrences.map((record) => [record.id, record]));
  const linkCounts = new Map<string, number>();
  for (const occurrenceId of provenanceIds)
    linkCounts.set(occurrenceId, (linkCounts.get(occurrenceId) ?? 0) + 1);
  increment(
    metrics,
    "orphan-candidate-occurrences",
    occurrences.filter((record) => (linkCounts.get(record.id) ?? 0) === 0).length,
  );
  increment(
    metrics,
    "double-linked-candidate-occurrences",
    [...linkCounts.values()].filter((count) => count > 1).length,
  );
  increment(
    metrics,
    "missing-candidate-occurrences",
    [...linkCounts.keys()].filter((id) => !occurrencesById.has(id)).length,
  );
  increment(
    metrics,
    "missing-candidate-identities",
    occurrences.filter((record) => !candidatesById.has(record.candidate_id)).length,
  );
  let provenanceMismatches = 0;
  for (const occurrence of occurrences) {
    const candidate = candidatesById.get(occurrence.candidate_id);
    if (
      candidate !== undefined &&
      (candidate.candidate_identity !== occurrence.candidate_identity ||
        !candidate.occurrence_ids.includes(occurrence.id))
    )
      provenanceMismatches += 1;
  }
  for (const candidate of candidates)
    for (const occurrenceId of candidate.occurrence_ids) {
      const occurrence = occurrencesById.get(occurrenceId);
      if (occurrence !== undefined && occurrence.candidate_id !== candidate.id)
        provenanceMismatches += 1;
    }
  increment(metrics, "candidate-provenance-mismatches", provenanceMismatches);

  for (const state of saturation) {
    const active = occurrences.filter((record) => record.resolved_at <= state.searched_at);
    const identityCount = new Set(active.map((record) => record.candidate_identity)).size;
    const occurrenceCount = new Set(active.map((record) => record.id)).size;
    if (state.candidate_identity_count !== identityCount)
      increment(metrics, "candidate-identity-count-mismatch");
    if (state.candidate_occurrence_count !== occurrenceCount)
      increment(metrics, "candidate-occurrence-count-mismatch");
  }
}
