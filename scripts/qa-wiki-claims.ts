import type { z } from "zod";
import type { MutableMetrics } from "./qa-wiki-metrics.ts";
import { increment } from "./qa-wiki-metrics.ts";
import type { ParsedCorpus } from "./qa-wiki-parse.ts";
import type { ledgerRecordSchema } from "./qa-wiki-records.ts";

type LedgerRecord = z.infer<typeof ledgerRecordSchema>;
type Claim = Extract<LedgerRecord, Readonly<{ record_type: "claim" }>>;
type Observation = Extract<LedgerRecord, Readonly<{ record_type: "observation" }>>;
type Source = Extract<LedgerRecord, Readonly<{ record_type: "source" }>>;
type Verification = Extract<LedgerRecord, Readonly<{ record_type: "verification" }>>;

function eligibleVerifiedClaim(
  claim: Claim,
  observations: ReadonlyMap<string, Observation>,
  sources: ReadonlyMap<string, Source>,
  verifications: readonly Verification[],
): boolean {
  if (
    claim.temporal_scope.as_of_date === null &&
    ["legal_rule", "procedural_rule"].includes(claim.claim_type)
  )
    return false;
  const observationsArePrimary = claim.supporting_observation_ids.every((id) => {
    const observation = observations.get(id);
    if (observation === undefined) return false;
    const source = sources.get(observation.source_id);
    return (
      source !== undefined &&
      ((source.access_state === "full_text" &&
        source.source_class.startsWith("primary_official_")) ||
        (claim.claim_type === "repository_audit" &&
          source.source_class === "repository_artifact" &&
          source.access_state === "repository_snapshot")) &&
      !["search_result", "metadata"].includes(observation.locator_type)
    );
  });
  const confirmation = verifications.some(
    (verification) =>
      verification.claim_id === claim.id &&
      ["primary_source_trace", "automated_check"].includes(verification.method) &&
      verification.outcome === "confirmed" &&
      verification.observation_ids.some((id) => claim.supporting_observation_ids.includes(id)),
  );
  return claim.supporting_observation_ids.length > 0 && observationsArePrimary && confirmation;
}

function hasQualifiedNumber(statement: string): boolean {
  const numerical = /\d+(?:[.,]\d+)?\s*(?:%|명|건|원|KRW)/i.test(statement);
  const qualified =
    /(unit|단위)/i.test(statement) &&
    /(population|모집단|대상)/i.test(statement) &&
    /(period|기간)/i.test(statement) &&
    /(metric|지표)/i.test(statement) &&
    /(qualified|한정)/i.test(statement);
  return !numerical || qualified;
}

function conflatesRecoveryStates(statement: string): boolean {
  const terms = [
    "judgment",
    "service",
    "finality",
    "enforceable title",
    "enforcement",
    "debtor registry",
    "actual payment",
    "판결",
    "송달",
    "확정",
    "집행권원",
    "집행",
    "채무자명부",
    "실제 지급",
  ] as const;
  return terms.filter((term) => statement.toLowerCase().includes(term)).length > 1;
}

function checkClaimGraphCycles(claims: readonly Claim[], metrics: MutableMetrics): void {
  const claimById = new Map(claims.map((claim) => [claim.id, claim]));
  const states = new Map<string, "visiting" | "done">();
  const cycleStarts = new Set<string>();
  const visit = (id: string): void => {
    const state = states.get(id);
    if (state === "done") return;
    if (state === "visiting") {
      if (!cycleStarts.has(id)) increment(metrics, "derived-claim-cycles");
      cycleStarts.add(id);
      return;
    }
    const claim = claimById.get(id);
    if (claim === undefined) return;
    states.set(id, "visiting");
    for (const childId of claim.derived_from_claim_ids) visit(childId);
    states.set(id, "done");
  };
  for (const claim of claims) visit(claim.id);
}

function derivedClaimsAreVerified(
  claims: readonly Claim[],
  metrics: MutableMetrics,
  leafIsVerified: (claim: Claim) => boolean,
): void {
  const claimById = new Map(claims.map((claim) => [claim.id, claim]));
  const states = new Map<string, "visiting" | "done">();
  const supportById = new Map<string, boolean>();
  const verifiedLeaves = (id: string): boolean => {
    const state = states.get(id);
    if (state === "done") return supportById.get(id) ?? false;
    if (state === "visiting") return false;
    const claim = claimById.get(id);
    if (claim === undefined) return false;
    states.set(id, "visiting");
    const result =
      claim.derived_from_claim_ids.length === 0
        ? leafIsVerified(claim)
        : claim.derived_from_claim_ids.every(verifiedLeaves);
    states.set(id, "done");
    supportById.set(id, result);
    return result;
  };
  for (const claim of claims) {
    if (
      claim.claim_type === "derived_synthesis" &&
      claim.evidence_status === "verified" &&
      !claim.derived_from_claim_ids.every(verifiedLeaves)
    )
      increment(metrics, "unsupported-derived-claims");
  }
}

export function checkClaims(corpus: ParsedCorpus, metrics: MutableMetrics): void {
  const claims = corpus.records.filter((record) => record.record_type === "claim");
  const sources = corpus.records.filter((record) => record.record_type === "source");
  const observations = corpus.records.filter((record) => record.record_type === "observation");
  const verifications = corpus.records.filter((record) => record.record_type === "verification");
  const coverage = corpus.records.filter((record) => record.record_type === "coverage");
  metrics.sources = sources.length;
  metrics.observations = observations.length;
  metrics.claims = claims.length;
  metrics.verifications = verifications.length;
  metrics["coverage-records"] = coverage.length;
  const observationById = new Map(observations.map((observation) => [observation.id, observation]));
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  for (const claim of claims) {
    if (
      claim.evidence_status === "verified" &&
      ["legal_rule", "procedural_rule"].includes(claim.claim_type) &&
      claim.temporal_scope.as_of_date === null
    ) {
      increment(metrics, "legal-date-missing");
    } else if (
      claim.evidence_status === "verified" &&
      claim.claim_type !== "derived_synthesis" &&
      !eligibleVerifiedClaim(claim, observationById, sourceById, verifications)
    ) {
      increment(metrics, "weak-verified");
    }
    if (
      claim.evidence_status === "gap" &&
      !coverage.some((item) => item.status === "gap" && item.lane === claim.lane)
    )
      increment(metrics, "undocumented-coverage-gaps");
    if (!hasQualifiedNumber(claim.statement)) increment(metrics, "unqualified-numerical-claims");
    if (conflatesRecoveryStates(claim.statement)) increment(metrics, "recovery-state-conflations");
  }
  checkClaimGraphCycles(claims, metrics);
  derivedClaimsAreVerified(
    claims,
    metrics,
    (claim) =>
      claim.evidence_status === "verified" &&
      claim.claim_type !== "derived_synthesis" &&
      eligibleVerifiedClaim(claim, observationById, sourceById, verifications),
  );
}
