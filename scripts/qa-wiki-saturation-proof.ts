import { createHash } from "node:crypto";
import type { MutableMetrics } from "./qa-wiki-metrics.ts";
import { increment } from "./qa-wiki-metrics.ts";
import type { ParsedCorpus } from "./qa-wiki-parse.ts";

type Record = ParsedCorpus["records"][number];
type Saturation = Extract<Record, { record_type: "saturation" }>;
type Coverage = Extract<Record, { record_type: "coverage" }>;
type Mapping = Saturation["cell_query_mappings"][number];
type Occurrence = Extract<Record, { record_type: "candidate_occurrence" }>;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

export function saturationDigest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

export function terminalQueryIdentity(mapping: Mapping): unknown {
  return {
    request_method: mapping.request_method,
    request_url: mapping.request_url,
    request_body: mapping.request_body,
    response_parser: mapping.response_parser,
    semantic_terms: mapping.semantic_terms,
  };
}

export function terminalResultReceipt(mapping: Mapping): unknown {
  return {
    query_id: mapping.query_id,
    request_started_at: mapping.request_started_at,
    response_received_at: mapping.response_received_at,
    response_status: mapping.response_status,
    response_url: mapping.response_url,
    response_sha256: mapping.response_sha256,
    response_bytes: mapping.response_bytes,
    access_state: mapping.access_state,
    access_error: mapping.access_error,
    result_count: mapping.result_count,
    result_occurrence_ids: mapping.result_occurrence_ids,
    reviewed_at: mapping.reviewed_at,
    adjudication: mapping.adjudication,
    material_novelty_count: mapping.material_novelty_count,
    candidate_queue_before_review: mapping.candidate_queue_before_review,
    candidate_queue_after_review: mapping.candidate_queue_after_review,
  };
}

function normalized(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replaceAll(/\s+/g, " ").trim();
}

function expectedProposition(
  coverage: Coverage,
  claims: ReadonlyMap<string, Extract<Record, { record_type: "claim" }>>,
): string {
  if (coverage.claim_ids.length === 0) return coverage.gap_reason ?? "";
  return coverage.claim_ids.map((id) => claims.get(id)?.statement ?? "").join(" | ");
}

function semanticErrors(
  mapping: Mapping,
  coverage: Coverage | undefined,
  proposition: string,
): number {
  if (
    coverage === undefined ||
    mapping.lane !== coverage.lane ||
    mapping.cell !== coverage.cell ||
    mapping.target_proposition !== proposition
  )
    return 1;
  const query = normalized(mapping.query_text);
  const target = normalized(proposition);
  const terms = mapping.semantic_terms.map(normalized);
  if (
    new Set(terms).size !== terms.length ||
    terms.some((term) => term.length < 2 || !query.includes(term) || !target.includes(term))
  )
    return 1;
  return 0;
}

function receiptErrors(mapping: Mapping): number {
  const responseParts = [mapping.response_status, mapping.response_sha256, mapping.response_bytes];
  const retrieved =
    mapping.access_state === "retrieved" &&
    mapping.response_status !== null &&
    mapping.response_status >= 200 &&
    mapping.response_status < 400 &&
    mapping.response_sha256 !== null &&
    mapping.response_bytes !== null &&
    mapping.access_error === null;
  const accessGap =
    mapping.access_state === "access_gap" &&
    mapping.result_count === 0 &&
    ((mapping.response_status !== null &&
      (mapping.response_status < 200 || mapping.response_status >= 400) &&
      mapping.response_sha256 !== null &&
      mapping.response_bytes !== null &&
      mapping.access_error === null) ||
      (responseParts.every((item) => item === null) && mapping.access_error !== null));
  return Number(
    (!retrieved && !accessGap) ||
      mapping.result_receipt_sha256 !== saturationDigest(terminalResultReceipt(mapping)),
  );
}

function chronologyErrors(mapping: Mapping, searchedAt: string): number {
  return Number(
    mapping.request_started_at > mapping.response_received_at ||
      mapping.response_received_at > mapping.reviewed_at ||
      mapping.reviewed_at > searchedAt,
  );
}

function adjudicationErrors(mapping: Mapping): number {
  const rationale = normalized(mapping.adjudication);
  return Number(
    mapping.adjudication.length < 100 ||
      !rationale.includes(normalized(mapping.query_id)) ||
      !rationale.includes(normalized(mapping.coverage_id)) ||
      !rationale.includes(normalized(mapping.cell)) ||
      !mapping.semantic_terms.some((term) => rationale.includes(normalized(term))),
  );
}

function occurrenceErrors(mapping: Mapping, corpus: ParsedCorpus): number {
  const occurrences = corpus.records.filter(
    (record): record is Occurrence =>
      record.record_type === "candidate_occurrence" &&
      mapping.result_occurrence_ids.includes(record.id),
  );
  const reviews = corpus.records.filter((record) => record.record_type === "candidate_review");
  let errors = Number(
    mapping.result_count !== mapping.result_occurrence_ids.length ||
      new Set(mapping.result_occurrence_ids).size !== mapping.result_occurrence_ids.length ||
      occurrences.length !== mapping.result_occurrence_ids.length ||
      mapping.candidate_queue_before_review !== mapping.result_count ||
      mapping.candidate_queue_after_review !== 0,
  );
  for (const occurrence of occurrences) {
    const matched = reviews.filter(
      (review) =>
        review.candidate_occurrence_id === occurrence.id && review.query_id === mapping.query_id,
    );
    if (
      occurrence.origin_type !== "terminal_wave_result" ||
      occurrence.lane !== mapping.lane ||
      !occurrence.origin_refs.includes(mapping.query_id) ||
      occurrence.resolved_at > mapping.reviewed_at ||
      matched.length !== 1
    )
      errors += 1;
  }
  return errors;
}

export function checkCellAdequateWave(
  record: Saturation,
  coverage: readonly Coverage[],
  corpus: ParsedCorpus,
  metrics: MutableMetrics,
): boolean {
  if (record.coverage_proof_status !== "cell_adequate") return false;
  const claims = new Map(
    corpus.records.filter((item) => item.record_type === "claim").map((item) => [item.id, item]),
  );
  const byId = new Map(coverage.map((item) => [item.id, item]));
  const mappings = record.cell_query_mappings;
  const mappingIds = mappings.map((item) => item.coverage_id);
  const queryIds = mappings.map((item) => item.query_identity_sha256);
  const receiptOccurrenceIds = mappings.flatMap((item) => item.result_occurrence_ids);
  const mappedQueryIds = new Set(mappings.map((item) => item.query_id));
  const waveOccurrenceIds = corpus.records
    .filter(
      (item): item is Occurrence =>
        item.record_type === "candidate_occurrence" &&
        item.origin_type === "terminal_wave_result" &&
        item.origin_refs.some((ref) => mappedQueryIds.has(ref)),
    )
    .map((item) => item.id);
  let structureErrors = Math.abs(mappings.length - coverage.length);
  structureErrors += mappingIds.length - new Set(mappingIds).size;
  structureErrors += coverage.filter((item) => !mappingIds.includes(item.id)).length;
  structureErrors += queryIds.length - new Set(queryIds).size;
  structureErrors +=
    mappings.map((item) => item.query_text).length -
    new Set(mappings.map((item) => item.query_text)).size;
  structureErrors += receiptOccurrenceIds.length - new Set(receiptOccurrenceIds).size;
  const unboundOccurrences =
    waveOccurrenceIds.filter((id) => !receiptOccurrenceIds.includes(id)).length +
    receiptOccurrenceIds.filter((id) => !waveOccurrenceIds.includes(id)).length;
  let semantic = 0;
  let receipts = 0;
  let chronology = 0;
  let adjudications = 0;
  let occurrences = unboundOccurrences;
  for (const mapping of mappings) {
    const cell = byId.get(mapping.coverage_id);
    const proposition = cell === undefined ? "" : expectedProposition(cell, claims);
    semantic += semanticErrors(mapping, cell, proposition);
    receipts += receiptErrors(mapping);
    chronology += chronologyErrors(mapping, record.searched_at);
    adjudications += adjudicationErrors(mapping);
    occurrences += occurrenceErrors(mapping, corpus);
    if (
      mapping.query_identity_sha256 !== saturationDigest(terminalQueryIdentity(mapping)) ||
      !record.query_identity_sha256s.includes(mapping.query_identity_sha256)
    )
      structureErrors += 1;
  }
  if (
    record.query_identity_sha256s.length !== mappings.length ||
    record.query_identity_sha256s.some(
      (id, index) => id !== mappings[index]?.query_identity_sha256,
    ) ||
    record.query_manifest_sha256 !== saturationDigest(record.query_identity_sha256s)
  )
    structureErrors += 1;
  const novelty = mappings.reduce((total, item) => total + item.material_novelty_count, 0);
  if (novelty !== record.material_novelty_count) structureErrors += 1;
  increment(metrics, "inadequate-terminal-query-mappings", structureErrors);
  increment(metrics, "unrelated-terminal-query-mappings", semantic);
  increment(metrics, "invalid-terminal-query-receipts", receipts);
  increment(metrics, "invalid-terminal-query-chronology", chronology);
  increment(metrics, "generic-terminal-query-adjudications", adjudications);
  increment(metrics, "unbound-terminal-result-occurrences", occurrences);
  const valid =
    structureErrors + semantic + receipts + chronology + adjudications + occurrences === 0;
  if (valid) {
    increment(metrics, "cell-adequate-terminal-waves");
    increment(metrics, "terminal-receipted-cell-queries", mappings.length);
  }
  return valid;
}
