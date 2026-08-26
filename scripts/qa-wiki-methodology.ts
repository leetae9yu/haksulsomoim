import { basename } from "node:path";
import type { MutableMetrics } from "./qa-wiki-metrics.ts";
import { increment } from "./qa-wiki-metrics.ts";
import type { ParsedCorpus } from "./qa-wiki-parse.ts";

type CorpusRecord = ParsedCorpus["records"][number];
type RecordOf<T extends CorpusRecord["record_type"]> = Extract<CorpusRecord, { record_type: T }>;

function isRecordType<T extends CorpusRecord["record_type"]>(type: T) {
  return (record: CorpusRecord): record is RecordOf<T> => record.record_type === type;
}

const genericCandidateRationale =
  /(?:changes?|alters?) no (?:claim|status|gap|conflict)|no (?:claim|status|gap|conflict)[^.!]{0,80}(?:changes?|resolved)|(?:canonical|source|identity).*already adjudicated|no material claim beyond accepted records/i;

function candidateReviewErrors(corpus: ParsedCorpus): number {
  const occurrences = corpus.records
    .filter(isRecordType("candidate_occurrence"))
    .filter((record) => record.origin_type === "terminal_wave_result");
  const reviews = corpus.records.filter(isRecordType("candidate_review"));
  const sources = new Map(
    corpus.records.filter(isRecordType("source")).map((record) => [record.id, record]),
  );
  const occurrenceById = new Map(
    corpus.records
      .filter(isRecordType("candidate_occurrence"))
      .map((record) => [record.id, record]),
  );
  let errors = 0;
  for (const occurrence of occurrences) {
    const matched = reviews.filter((review) => review.candidate_occurrence_id === occurrence.id);
    if (matched.length !== 1) {
      errors += Math.max(1, matched.length);
      continue;
    }
    const review = matched[0];
    if (review === undefined) continue;
    const retrieval = review.retrieval;
    if (
      review.candidate_url !== occurrence.candidate_identity ||
      review.disposition !== occurrence.disposition ||
      !occurrence.origin_refs.includes(review.query_id) ||
      retrieval === null ||
      retrieval.url !== review.candidate_url ||
      retrieval.request_started_at > retrieval.response_received_at ||
      retrieval.response_received_at > review.reviewed_at ||
      review.reviewed_at !== occurrence.resolved_at ||
      review.material_novelty !== occurrence.material_novelty ||
      (retrieval.status === "retrieved" &&
        (retrieval.response_status === null ||
          retrieval.response_sha256 === null ||
          retrieval.response_bytes === null)) ||
      (retrieval.status === "unavailable" &&
        (retrieval.response_status !== null ||
          retrieval.response_sha256 !== null ||
          retrieval.response_bytes !== null)) ||
      review.rationale.length < 60 ||
      genericCandidateRationale.test(review.rationale)
    )
      errors += 1;
    const target = review.canonical_target;
    if (
      review.disposition === "duplicate_confirmation" ||
      review.disposition === "superseded_by_canonical"
    ) {
      if (target === null) {
        errors += 1;
      } else if (target.record_type === "source") {
        const source = sources.get(target.id);
        if (source === undefined || source.canonical_url !== target.canonical_url) errors += 1;
      } else {
        const prior = occurrenceById.get(target.id);
        if (
          prior === undefined ||
          prior.id >= occurrence.id ||
          prior.candidate_identity !== target.canonical_url
        )
          errors += 1;
      }
    } else if (target !== null) {
      errors += 1;
    }
  }
  errors += reviews.filter(
    (review) => !occurrences.some((item) => item.id === review.candidate_occurrence_id),
  ).length;
  return errors;
}

function statisticDefinitionErrors(corpus: ParsedCorpus): number {
  const claims = corpus.records.filter(isRecordType("claim"));
  const conflicts = corpus.records
    .filter(isRecordType("conflict"))
    .filter((record) => record.conflict_type === "statistic_definition");
  const verifications = corpus.records.filter(isRecordType("verification"));
  let errors = 0;
  for (const conflict of conflicts) {
    const linked = claims.filter((claim) => conflict.claim_ids.includes(claim.id));
    const verification = verifications.find(
      (item) => item.id === conflict.resolved_by_verification_id,
    );
    const support = linked.flatMap((claim) => claim.supporting_observation_ids);
    const counters = linked.flatMap((claim) => claim.counter_observation_ids);
    if (
      linked.length !== conflict.claim_ids.length ||
      counters.length === 0 ||
      linked.some((claim) => claim.publication_status !== "withheld") ||
      conflict.status === "open" ||
      verification === undefined ||
      verification.outcome !== "insufficient" ||
      !verification.observation_ids.some((id) => support.includes(id)) ||
      counters.some((id) => !verification.observation_ids.includes(id))
    )
      errors += 1;
  }
  for (const claim of claims.filter(
    (item) => item.claim_type === "statistic" && item.counter_observation_ids.length > 0,
  ))
    if (!conflicts.some((conflict) => conflict.claim_ids.includes(claim.id))) errors += 1;
  return errors;
}

function renderChronologyErrors(corpus: ParsedCorpus): number {
  const renders = [
    ...corpus.records.filter(isRecordType("public_render")),
    ...corpus.records.filter(isRecordType("report_render")),
  ];
  let errors = renders.filter((record) => record.rendered_at <= record.research_cutoff).length;
  const publicRender = renders.find((record) => record.record_type === "public_render");
  const reportRender = renders.find((record) => record.record_type === "report_render");
  if (
    publicRender !== undefined &&
    reportRender !== undefined &&
    reportRender.rendered_at < publicRender.rendered_at
  )
    errors += 1;
  return errors;
}

export function checkMethodology(corpus: ParsedCorpus, metrics: MutableMetrics): void {
  const task10 = corpus.files.some((file) => basename(file.path) === "candidates.md");
  const reviews = corpus.records.filter(isRecordType("candidate_review"));
  metrics["terminal-candidate-reviews"] = reviews.length;
  if (task10)
    increment(metrics, "invalid-terminal-candidate-reviews", candidateReviewErrors(corpus));
  increment(metrics, "unadjudicated-statistic-definitions", statisticDefinitionErrors(corpus));
  increment(metrics, "backdated-render-timestamps", renderChronologyErrors(corpus));
}
