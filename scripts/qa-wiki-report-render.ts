import { basename } from "node:path";
import type { MutableMetrics } from "./qa-wiki-metrics.ts";
import { increment } from "./qa-wiki-metrics.ts";
import type { ParsedCorpus } from "./qa-wiki-parse.ts";
import { sha256 } from "./qa-wiki-public.ts";

const commits = {
  task10: "d37bcc4fd83bf74c073a86b87b3a6555e694778b",
  task11: "4341eba3d91020ea3403bf4979f42d3ff04643f1",
  task12: "593920ec89c9b89a52de07a2d3b5df9a76b78915",
} as const;

export type ReportBlock = Readonly<{
  section: string;
  kind: "paragraph" | "table_row";
  content: string;
  digest: string;
  claimIds: readonly string[];
}>;

function claimIds(content: string): readonly string[] {
  const ids = [...content.matchAll(/\[(CLM-(?:[A-Z]+-\d{4}|AUDIT-[a-f0-9]{16}))\]/g)]
    .map((match) => match[1])
    .filter((id): id is string => id !== undefined);
  return [...new Set(ids)];
}

function blocks(content: string): readonly ReportBlock[] {
  const result: ReportBlock[] = [];
  let section = "preamble";
  let paragraph: string[] = [];
  let table: string[] = [];
  const flushParagraph = (): void => {
    const value = paragraph.join("\n").trim();
    paragraph = [];
    if (value && !value.startsWith("#"))
      result.push({
        section,
        kind: "paragraph",
        content: value,
        digest: sha256(value),
        claimIds: claimIds(value),
      });
  };
  const flushTable = (): void => {
    const rows = table;
    table = [];
    for (const row of rows.slice(2)) {
      const value = row.trim();
      if (value && !/^\|?\s*[-:]+/.test(value))
        result.push({
          section,
          kind: "table_row",
          content: value,
          digest: sha256(value),
          claimIds: claimIds(value),
        });
    }
  };
  for (const line of content.split(/\r?\n/)) {
    if (line.startsWith("## ")) {
      flushParagraph();
      flushTable();
      section = line.slice(3).trim();
    } else if (line.startsWith("|")) {
      flushParagraph();
      table.push(line);
    } else if (!line.trim()) {
      flushParagraph();
      flushTable();
    } else {
      flushTable();
      paragraph.push(line);
    }
  }
  flushParagraph();
  flushTable();
  return result;
}

function qualifier(
  claim: Readonly<{ evidence_status: string; publication_status: string }>,
): string {
  if (claim.evidence_status === "rejected") return "rejected";
  if (claim.publication_status === "withheld") return "withheld";
  if (claim.evidence_status === "reported") return "reported";
  return claim.publication_status === "published" ? "published" : "draft";
}

export function reportBlocks(content: string): readonly ReportBlock[] {
  return blocks(content);
}

export function checkReportRender(corpus: ParsedCorpus, metrics: MutableMetrics): void {
  const structuralMode =
    corpus.records.some((record) => record.record_type === "seed_disposition") &&
    corpus.records.some(
      (record) => record.record_type === "public_render" || record.record_type === "report_render",
    );
  if (!structuralMode) return;
  const report = corpus.files.find(
    (file) => basename(file.path) === "report.md" && !file.path.includes("/_ledgers/"),
  );
  if (report === undefined) return;
  const manifests = corpus.records.filter((record) => record.record_type === "report_render");
  const assertions = corpus.records.filter((record) => record.record_type === "report_assertion");
  metrics["report-assertions"] = assertions.length;
  if (manifests.length !== 1) {
    increment(metrics, "missing-report-render", Math.max(1, manifests.length));
    return;
  }
  const manifest = manifests[0];
  if (manifest === undefined) return;
  if (
    manifest.report_sha256 !== sha256(report.content) ||
    manifest.task10_commit !== commits.task10 ||
    manifest.task11_commit !== commits.task11 ||
    manifest.task12_commit !== commits.task12
  )
    increment(metrics, "report-render-mismatches");
  const files = new Map(
    corpus.files.map((file) => [file.path.replace(/^.*\/_ledgers\//, ""), file.content]),
  );
  for (const [path, digest] of Object.entries(manifest.ledger_sha256s))
    if (files.get(path) === undefined || sha256(files.get(path) ?? "") !== digest)
      increment(metrics, "report-render-mismatches");
  const actual = blocks(report.content);
  const expectedSections = new Set(manifest.required_sections);
  const actualSections = new Set(actual.map((block) => block.section));
  if (
    expectedSections.size !== actualSections.size ||
    [...expectedSections].some((item) => !actualSections.has(item))
  )
    increment(metrics, "report-render-mismatches");
  const claims = new Map(
    corpus.records
      .filter((record) => record.record_type === "claim")
      .map((record) => [record.id, record]),
  );
  const byKey = new Map<string, (typeof assertions)[number]>();
  const actualByKey = new Map(
    actual.map((block) => [`${block.section}\u0000${block.kind}\u0000${block.digest}`, block]),
  );
  for (const assertion of assertions) {
    const key = `${assertion.section}\u0000${assertion.kind}\u0000${assertion.content_sha256}`;
    const block = actualByKey.get(key);
    if (assertion.manifest_id !== manifest.id || byKey.has(key))
      increment(metrics, "report-assertion-mismatches");
    byKey.set(key, assertion);
    for (const binding of assertion.claim_bindings) {
      const claim = claims.get(binding.claim_id);
      const uncited = block?.content.replace(/\s*\[CLM-(?:[A-Z]+-\d{4}|AUDIT-[a-f0-9]{16})\]/g, "");
      if (
        binding.exact_statement === true &&
        (claim === undefined || uncited === undefined || !uncited.includes(claim.statement))
      )
        increment(metrics, "report-proposition-mismatches");
      if (
        claim === undefined ||
        claim.evidence_status !== binding.evidence_status ||
        claim.publication_status !== binding.publication_status ||
        binding.qualifier_class !== qualifier(claim) ||
        (claim.claim_type === "repository_audit" &&
          (binding.repository_fact == null ||
            claim.repository_binding == null ||
            binding.repository_fact.fact_kind !== claim.repository_binding.fact_kind ||
            binding.repository_fact.subject_id !== claim.repository_binding.subject_id ||
            binding.repository_fact.record_id !== claim.repository_binding.record_id ||
            binding.repository_fact.fact_digest !== claim.repository_binding.fact_digest)) ||
        (claim.claim_type !== "repository_audit" && binding.repository_fact != null)
      )
        increment(metrics, "report-assertion-mismatches");
    }
  }
  for (const block of actual) {
    const assertion = byKey.get(`${block.section}\u0000${block.kind}\u0000${block.digest}`);
    if (block.claimIds.length === 0) increment(metrics, "unresolved-report-citations");
    if (assertion === undefined) {
      increment(metrics, "unregistered-report-assertions");
      increment(metrics, "report-assertion-mismatches");
      continue;
    }
    const bound = assertion.claim_bindings.map((binding) => binding.claim_id);
    if (
      bound.length !== block.claimIds.length ||
      [...new Set(bound)].length !== bound.length ||
      bound.some((id) => !block.claimIds.includes(id))
    )
      increment(metrics, "report-assertion-mismatches");
  }
  if (assertions.length !== actual.length)
    increment(metrics, "report-assertion-mismatches", Math.abs(assertions.length - actual.length));
}
