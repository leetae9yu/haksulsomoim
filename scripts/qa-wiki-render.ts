import { basename } from "node:path";
import type { MutableMetrics } from "./qa-wiki-metrics.ts";
import { increment } from "./qa-wiki-metrics.ts";
import type { ParsedCorpus } from "./qa-wiki-parse.ts";
import type { PublicFile } from "./qa-wiki-public.ts";

import {
  citations,
  count,
  expected,
  mismatchCounts,
  publicData,
  sha256,
} from "./qa-wiki-public.ts";

export function checkRenderContract(
  corpus: ParsedCorpus,
  files: readonly PublicFile[],
  metrics: MutableMetrics,
): void {
  const renders = corpus.records.filter((record) => record.record_type === "public_render");
  if (renders.length !== 1) {
    increment(metrics, "missing-public-render", Math.max(1, renders.length));
    return;
  }
  const render = renders[0];
  if (render === undefined) return;
  const ledger = new Map(corpus.files.map((file) => [basename(file.path), file.content]));
  const bindings = [
    ["coverage.md", render.coverage_sha256],
    ["seed-audit.md", render.seed_audit_sha256],
    ["seed-dispositions.md", render.seed_dispositions_sha256],
  ] as const;
  for (const [name, digest] of bindings)
    if (ledger.get(name) === undefined || sha256(ledger.get(name) ?? "") !== digest)
      increment(metrics, "public-render-file-mismatches");
  const fileRecords = corpus.records.filter((record) => record.record_type === "public_file");
  const citationRecords = corpus.records.filter(
    (record) => record.record_type === "public_citation",
  );
  const byName = new Map(files.map((file) => [basename(file.path), file]));
  increment(metrics, "public-render-files", fileRecords.length);
  increment(metrics, "public-render-citations", citationRecords.length);
  const renderedPaths = count(fileRecords, (record) => record.path);
  for (const value of count(fileRecords, (record) => record.id).values())
    if (value > 1) increment(metrics, "public-render-file-mismatches", value - 1);
  for (const name of expected) {
    const record = fileRecords.find((candidate) => candidate.path === name);
    const file = byName.get(name);
    if ((renderedPaths.get(name) ?? 0) !== 1 || record === undefined || file === undefined) {
      increment(metrics, "public-render-file-mismatches");
      continue;
    }
    const data = publicData(file.content);
    const id = typeof data?.id === "string" ? data.id : null;
    if (
      record.manifest_id !== render.id ||
      record.public_id !== id ||
      record.sha256 !== sha256(file.content)
    )
      increment(metrics, "public-render-file-mismatches");
    const disposition = corpus.records.find(
      (candidate) => candidate.record_type === "seed_disposition" && candidate.filename === name,
    );
    if (disposition === undefined || disposition.record_type !== "seed_disposition") {
      if (
        record.seed_id !== null ||
        record.seed_disposition_id !== null ||
        record.task1_seed_sha256 !== null
      )
        increment(metrics, "public-render-file-mismatches");
    } else if (
      record.seed_id !== disposition.seed_id ||
      record.seed_disposition_id !== disposition.id ||
      record.task1_seed_sha256 !== disposition.task1_seed_sha256
    )
      increment(metrics, "public-render-file-mismatches");
  }
  for (const record of fileRecords)
    if (!expected.includes(record.path) || record.manifest_id !== render.id)
      increment(metrics, "public-render-file-mismatches");
  const actual = citations(files);
  const actualCounts = count(
    actual,
    (item) => `${item.path}\u0000${item.digest}\u0000${item.claimId}`,
  );
  const manifestCounts = count(
    citationRecords,
    (record) => `${record.path}\u0000${record.paragraph_sha256}\u0000${record.claim_id}`,
  );
  increment(
    metrics,
    "public-render-citation-mismatches",
    mismatchCounts(actualCounts, manifestCounts),
  );
  const duplicateIds = count(citationRecords, (record) => record.id);
  for (const value of duplicateIds.values())
    if (value > 1) increment(metrics, "public-render-citation-mismatches", value - 1);
  const claims = new Map(
    corpus.records
      .filter((record) => record.record_type === "claim")
      .map((record) => [record.id, record]),
  );
  for (const record of citationRecords) {
    const claim = claims.get(record.claim_id);
    if (
      record.manifest_id !== render.id ||
      claim === undefined ||
      claim.evidence_status !== record.evidence_status ||
      claim.publication_status !== record.publication_status
    )
      increment(metrics, "public-render-citation-mismatches");
  }
}
