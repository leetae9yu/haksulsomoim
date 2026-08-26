import { createHash } from "node:crypto";
import { basename } from "node:path";
import { checkCandidates } from "./qa-wiki-candidates.ts";
import { checkClaims } from "./qa-wiki-claims.ts";
import { checkMethodology } from "./qa-wiki-methodology.ts";
import type { MutableMetrics, WikiSummary } from "./qa-wiki-metrics.ts";
import { createMetrics, hardMetricNames, increment } from "./qa-wiki-metrics.ts";
import type { ParsedCorpus } from "./qa-wiki-parse.ts";
import { checkPublicSurface } from "./qa-wiki-public.ts";
import { checkReport } from "./qa-wiki-report.ts";
import { checkReportRender } from "./qa-wiki-report-render.ts";
import { checkRepositoryArtifacts } from "./qa-wiki-repository.ts";
import { checkSaturation } from "./qa-wiki-saturation.ts";
import { checkSeeds } from "./qa-wiki-seeds.ts";

function duplicateCount(values: readonly string[]): number {
  const seen = new Set<string>();
  let duplicates = 0;
  for (const value of values) {
    if (seen.has(value)) duplicates += 1;
    seen.add(value);
  }
  return duplicates;
}

function markdownIds(corpus: ParsedCorpus): readonly string[] {
  const ids: string[] = [];
  for (const file of corpus.files) {
    const match = /^id:\s*([^\r\n]+)$/m.exec(file.content);
    const id = match?.[1]?.trim();
    if (id !== undefined) ids.push(id);
  }
  return ids;
}

function checkLinks(corpus: ParsedCorpus, metrics: MutableMetrics): void {
  const stems = corpus.files.map((file) => basename(file.path, ".md"));
  for (const file of corpus.files) {
    for (const match of file.content.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)) {
      const target = match[1];
      if (target === undefined) increment(metrics, "dangling-links");
      else if (
        !/^<[^>]+>$/.test(target) &&
        (target.includes("/") || stems.filter((stem) => stem === target).length !== 1)
      )
        increment(metrics, "dangling-links");
    }
  }
}

function checkReferences(corpus: ParsedCorpus, metrics: MutableMetrics): void {
  const known = new Set([...corpus.records.map((record) => record.id), ...markdownIds(corpus)]);
  const check = (id: string | null): void => {
    if (id !== null && !known.has(id)) increment(metrics, "dangling-ledger-ids");
  };
  for (const record of corpus.records) {
    switch (record.record_type) {
      case "source":
        break;
      case "observation":
        check(record.source_id);
        break;
      case "claim":
        for (const id of [
          ...record.supporting_observation_ids,
          ...record.counter_observation_ids,
          ...record.derived_from_claim_ids,
        ])
          check(id);
        if (record.repository_binding != null) {
          check(record.repository_binding.source_id);
          check(record.repository_binding.observation_id);
        }
        break;
      case "verification":
        check(record.claim_id);
        for (const id of record.observation_ids) check(id);
        break;
      case "conflict":
        for (const id of record.claim_ids) check(id);
        check(record.resolved_by_verification_id);
        break;
      case "redirect":
        check(record.from_ref);
        check(record.to_ref);
        break;
      case "coverage":
        for (const id of [...record.claim_ids, ...record.source_ids]) check(id);
        break;
      case "saturation":
        check(record.prior_wave_id);
        break;
      case "candidate":
        for (const id of record.occurrence_ids) check(id);
        break;
      case "candidate_occurrence":
        check(record.candidate_id);
        break;
      case "candidate_review":
        check(record.candidate_occurrence_id);
        check(record.canonical_target?.id ?? null);
        break;
      case "seed_disposition":
      case "public_render":
      case "public_file":
      case "public_citation":
      case "report_render":
      case "report_assertion":
        break;
    }
  }
}

function sourceTextFields(value: unknown): number {
  if (typeof value === "string") {
    try {
      return sourceTextFields(JSON.parse(value));
    } catch {
      return 0;
    }
  }
  if (Array.isArray(value)) return value.reduce((total, item) => total + sourceTextFields(item), 0);
  if (value === null || typeof value !== "object") return 0;
  return Object.entries(value).reduce(
    (total, [key, item]) =>
      total +
      Number(["excerpt", "fulltext"].includes(key.replaceAll(/[_\s-]/g, "").toLowerCase())) +
      sourceTextFields(item),
    0,
  );
}

function caveatSourceTextFields(caveat: string): number {
  const payload = caveat.slice(caveat.indexOf("=") + 1).trim();
  return sourceTextFields(payload);
}

function checkText(corpus: ParsedCorpus, metrics: MutableMetrics): void {
  const pii =
    /(?:\b01[016789]-?\d{3,4}-?\d{4}\b|\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b|\b\d{6}-[1-4]\d{6}\b|(?:국민|신한|우리|하나|농협|기업|카카오|토스)은행\s+\d{2,6}(?:-\d{2,6}){1,3})/g;
  for (const file of corpus.files) {
    increment(metrics, "pii-pattern-hits", file.content.match(pii)?.length ?? 0);
    if (basename(file.path).includes("목록") && /결과\s*[:：]/.test(file.content))
      increment(metrics, "handwritten-index-outcomes");
  }
  for (const record of corpus.records) {
    if ("caveats" in record)
      increment(
        metrics,
        "embedded-source-text-fields",
        record.caveats.reduce((total, caveat) => total + caveatSourceTextFields(caveat), 0),
      );
    if (record.record_type === "observation") {
      if ([...record.excerpt].length > 500) increment(metrics, "overlong-excerpts");
      if (
        createHash("sha256").update(record.excerpt, "utf8").digest("hex") !== record.excerpt_digest
      )
        increment(metrics, "excerpt-digest-mismatches");
    }
  }
}

export function validateCorpus(
  corpus: ParsedCorpus,
): Readonly<{ summary: WikiSummary; hardCount: number }> {
  const metrics = createMetrics(corpus);
  metrics["malformed-inputs"] = corpus.malformedInputs;
  metrics["overlong-excerpts"] = corpus.overlongExcerpts;
  metrics["frontmatter-keyset-mismatches"] = corpus.frontmatterKeysetMismatches;
  metrics["new-frontmatter-keys"] = corpus.newFrontmatterKeys;
  increment(
    metrics,
    "duplicate-canonical-keys",
    duplicateCount(corpus.records.map((record) => record.id)),
  );
  increment(
    metrics,
    "duplicate-canonical-keys",
    duplicateCount(
      corpus.records
        .filter((record) => record.record_type === "source")
        .map((record) => record.canonical_url),
    ),
  );
  checkLinks(corpus, metrics);
  checkReferences(corpus, metrics);
  checkClaims(corpus, metrics);
  checkRepositoryArtifacts(corpus, metrics);
  checkPublicSurface(corpus, metrics);
  checkReport(corpus, metrics);
  checkReportRender(corpus, metrics);
  checkSaturation(corpus, metrics);
  checkCandidates(corpus, metrics);
  checkMethodology(corpus, metrics);
  checkSeeds(corpus, metrics);
  checkText(corpus, metrics);
  return {
    summary: metrics,
    hardCount: hardMetricNames.reduce((total, name) => total + (metrics[name] ?? 0), 0),
  };
}
