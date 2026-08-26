import { basename } from "node:path";
import type { MutableMetrics } from "./qa-wiki-metrics.ts";
import { increment } from "./qa-wiki-metrics.ts";
import type { ParsedCorpus } from "./qa-wiki-parse.ts";

type SeedAuditEntry = Readonly<{ id: string; filename: string; sha256: string }>;

function seedId(filename: string): string | undefined {
  if (filename === "전체_사례_목록.md") return "INDEX-0001";
  return /^(P(?:10|[1-9])|R(?:10|[1-9]))_/.exec(filename)?.[1];
}

function parseAudit(content: string): readonly SeedAuditEntry[] | undefined {
  const entries: SeedAuditEntry[] = [];
  for (const line of content.split(/\r?\n/)) {
    if (!line.startsWith("| ") || line.includes("---") || line.startsWith("| type")) continue;
    const columns = line.split("|").map((value) => value.trim());
    const filename = columns[3];
    const sha256 = columns[5];
    if (filename === undefined || sha256 === undefined) return undefined;
    const id = seedId(filename);
    if (id === undefined || !/^[a-f0-9]{64}$/.test(sha256)) return undefined;
    entries.push({ id, filename, sha256 });
  }
  return entries.length > 0 ? entries : undefined;
}

export function checkSeeds(corpus: ParsedCorpus, metrics: MutableMetrics): void {
  const audit = corpus.files.find((file) => basename(file.path) === "seed-audit.md");
  const dispositions = corpus.records.filter((record) => record.record_type === "seed_disposition");
  if (audit === undefined) {
    if (dispositions.length > 0) increment(metrics, "seed-audit-mismatches");
    return;
  }
  if (dispositions.length === 0) return;
  const entries = parseAudit(audit.content);
  metrics["seed-audit-files"] = entries?.length ?? 0;
  metrics["seed-disposition-records"] = dispositions.length;
  if (entries === undefined) {
    increment(metrics, "seed-audit-mismatches");
    return;
  }
  const byId = new Map(dispositions.map((record) => [record.seed_id, record]));
  const auditIds = new Set(entries.map((entry) => entry.id));
  const filenames = new Set(entries.map((entry) => entry.filename));
  if (auditIds.size !== entries.length || filenames.size !== entries.length)
    increment(metrics, "seed-audit-mismatches");
  for (const entry of entries) {
    const disposition = byId.get(entry.id);
    if (
      disposition === undefined ||
      disposition.filename !== entry.filename ||
      disposition.task1_seed_sha256 !== entry.sha256
    )
      increment(metrics, "seed-audit-mismatches");
  }
  for (const disposition of dispositions)
    if (!auditIds.has(disposition.seed_id)) increment(metrics, "seed-audit-mismatches");
}
