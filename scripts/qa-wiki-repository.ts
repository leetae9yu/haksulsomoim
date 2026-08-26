import { createHash } from "node:crypto";
import type { z } from "zod";
import type { MutableMetrics } from "./qa-wiki-metrics.ts";
import { increment } from "./qa-wiki-metrics.ts";
import type { ParsedCorpus } from "./qa-wiki-parse.ts";
import type { ledgerRecordSchema } from "./qa-wiki-records.ts";
import {
  canonicalSelectedFields,
  jsonlRecord,
  repositoryAuditIdentity,
  repositoryFact,
} from "./qa-wiki-repository-facts.ts";

type Record = z.infer<typeof ledgerRecordSchema>;
type Source = Extract<Record, Readonly<{ record_type: "source" }>>;
type Observation = Extract<Record, Readonly<{ record_type: "observation" }>>;
type Claim = Extract<Record, Readonly<{ record_type: "claim" }>>;
type Verification = Extract<Record, Readonly<{ record_type: "verification" }>>;

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function artifact(corpus: ParsedCorpus, path: string): string | undefined {
  const fixturePath = path.replace(/^wiki\//, "");
  return corpus.files.find(
    (file) => file.path.endsWith(`/${path}`) || file.path.endsWith(`/${fixturePath}`),
  )?.content;
}

function committed(source: Source): string | undefined {
  if (source.repository_commit == null || source.repository_path == null) return undefined;
  const result = Bun.spawnSync(
    ["git", "show", `${source.repository_commit}:${source.repository_path}`],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  return result.exitCode === 0 ? new TextDecoder().decode(result.stdout) : undefined;
}

function observationFact(observation: Observation, source: Source, content: string) {
  if (
    observation.repository_record_id == null ||
    observation.repository_fact_kind == null ||
    observation.repository_selected_fields == null ||
    observation.repository_fact_digest == null
  )
    return undefined;
  const record =
    observation.repository_fact_kind === "repository_text"
      ? {
          record_type: "repository_text",
          id: observation.repository_record_id,
          ...observation.repository_selected_fields,
        }
      : jsonlRecord(content, observation.repository_record_id);
  if (
    record === undefined ||
    (observation.repository_fact_kind === "repository_text" &&
      (observation.repository_selected_fields.path !== source.repository_path ||
        typeof observation.repository_selected_fields.statement !== "string" ||
        !content.includes(observation.repository_selected_fields.statement)))
  )
    return undefined;
  const fact = repositoryFact(
    observation.repository_fact_kind,
    record,
    observation.repository_selected_fields,
  );
  const identity = fact === undefined ? undefined : repositoryAuditIdentity(source, fact);
  if (
    fact === undefined ||
    identity === undefined ||
    observation.id !== identity.observationId ||
    observation.locator !== fact.recordId ||
    observation.excerpt !== JSON.stringify(fact.selectedFields) ||
    observation.excerpt_digest !== sha256(observation.excerpt) ||
    observation.repository_fact_digest !== fact.digest ||
    observation.repository_identity_digest !== identity.digest ||
    source.id !== observation.source_id
  )
    return undefined;
  return { fact, identity };
}

export function checkRepositoryArtifacts(corpus: ParsedCorpus, metrics: MutableMetrics): void {
  const sources = corpus.records.filter(
    (record): record is Source => record.record_type === "source",
  );
  const observations = corpus.records.filter(
    (record): record is Observation => record.record_type === "observation",
  );
  const claims = corpus.records.filter((record): record is Claim => record.record_type === "claim");
  const verifications = corpus.records.filter(
    (record): record is Verification => record.record_type === "verification",
  );
  const repositorySources = sources.filter(
    (source) => source.source_class === "repository_artifact",
  );
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const observationById = new Map(observations.map((observation) => [observation.id, observation]));
  const facts = new Map<string, ReturnType<typeof observationFact>>();
  const identityDigests = new Map<string, string>();
  metrics["repository-sources"] = repositorySources.length;
  metrics["repository-observations"] = observations.filter(
    (item) => sourceById.get(item.source_id)?.source_class === "repository_artifact",
  ).length;
  metrics["repository-claims"] = claims.filter(
    (claim) => claim.claim_type === "repository_audit",
  ).length;
  for (const source of repositorySources) {
    const current =
      source.repository_path == null ? undefined : artifact(corpus, source.repository_path);
    const blob = committed(source);
    if (
      source.repository_path == null ||
      source.repository_blob_sha256 == null ||
      source.content_sha256 == null ||
      source.canonical_url !== `repo://${source.repository_path}` ||
      current === undefined ||
      blob === undefined ||
      sha256(current) !== source.content_sha256 ||
      sha256(blob) !== source.repository_blob_sha256 ||
      source.content_sha256 !== source.repository_blob_sha256
    )
      increment(metrics, "repository-artifact-mismatches");
  }
  for (const observation of observations) {
    const source = sourceById.get(observation.source_id);
    if (source?.source_class !== "repository_artifact") continue;
    const content =
      source.repository_path == null ? undefined : artifact(corpus, source.repository_path);
    const fact = content === undefined ? undefined : observationFact(observation, source, content);
    if (facts.has(observation.id)) increment(metrics, "repository-audit-mismatches");
    facts.set(observation.id, fact);
    if (fact !== undefined) {
      const previous = identityDigests.get(fact.identity.observationId);
      if (previous !== undefined && previous !== fact.identity.digest)
        increment(metrics, "repository-audit-mismatches");
      identityDigests.set(fact.identity.observationId, fact.identity.digest);
    }
    if (observation.locator_type !== "repository_record" || fact === undefined)
      increment(metrics, "repository-artifact-mismatches");
  }
  for (const claim of claims) {
    if (claim.claim_type !== "repository_audit") continue;
    const binding = claim.repository_binding;
    const observation = binding == null ? undefined : observationById.get(binding.observation_id);
    const fact = observation === undefined ? undefined : facts.get(observation.id);
    const linkedVerifications = verifications.filter((item) => item.claim_id === claim.id);
    const confirmations = linkedVerifications.filter(
      (item) =>
        item.claim_id === claim.id &&
        item.method === "automated_check" &&
        item.outcome === "confirmed" &&
        binding != null &&
        item.observation_ids.length === 1 &&
        item.observation_ids[0] === binding.observation_id &&
        item.repository_fact_digest === fact?.fact.digest,
    );
    if (
      binding == null ||
      fact === undefined ||
      claim.supporting_observation_ids.length !== 1 ||
      claim.supporting_observation_ids[0] !== binding.observation_id ||
      binding.source_id !== observation?.source_id ||
      binding.fact_kind !== fact.fact.kind ||
      binding.subject_id !== fact.fact.subjectId ||
      binding.record_id !== fact.fact.recordId ||
      JSON.stringify(canonicalSelectedFields(binding.selected_fields)) !==
        JSON.stringify(canonicalSelectedFields(fact.fact.selectedFields)) ||
      binding.fact_digest !== fact.fact.digest ||
      binding.identity_digest !== fact.identity.digest ||
      binding.proposition !== fact.fact.proposition ||
      claim.statement !== fact.fact.proposition ||
      claim.id !== fact.identity.claimId ||
      claim.evidence_status !== "verified" ||
      claim.publication_status !== "published" ||
      linkedVerifications.length !== 1 ||
      confirmations.length !== 1
    )
      increment(metrics, "repository-audit-mismatches");
  }
  for (const [observationId, fact] of facts) {
    if (fact === undefined) continue;
    const bound = claims.filter(
      (claim) =>
        claim.claim_type === "repository_audit" &&
        claim.repository_binding?.observation_id === observationId,
    );
    if (bound.length !== 1 || bound[0]?.id !== fact.identity.claimId)
      increment(metrics, "repository-audit-mismatches");
  }
}
