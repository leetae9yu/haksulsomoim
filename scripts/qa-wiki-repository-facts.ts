import { createHash } from "node:crypto";

export const repositoryFactKinds = [
  "seed_disposition",
  "coverage_cell",
  "public_file",
  "saturation_wave",
  "repository_text",
] as const;

export type RepositoryFactKind = (typeof repositoryFactKinds)[number];
type Scalar = string | number | boolean | null;
export type SelectedFields = Readonly<Record<string, Scalar>>;
export type RepositoryFact = Readonly<{
  kind: RepositoryFactKind;
  recordKind: string;
  recordId: string;
  subjectId: string;
  selectedFields: SelectedFields;
  digest: string;
  proposition: string;
}>;

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function scalar(value: unknown): value is Scalar {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

export function canonicalSelectedFields(selected: SelectedFields): SelectedFields {
  return Object.fromEntries(
    Object.entries(selected).toSorted(([left], [right]) => left.localeCompare(right)),
  );
}

function fields(
  record: Readonly<Record<string, unknown>>,
  selected: SelectedFields,
): SelectedFields | undefined {
  const entries = Object.entries(canonicalSelectedFields(selected));
  if (
    entries.length === 0 ||
    entries.some(([key, value]) => !scalar(record[key]) || record[key] !== value)
  )
    return undefined;
  return canonicalSelectedFields(selected);
}

function subject(
  kind: RepositoryFactKind,
  record: Readonly<Record<string, unknown>>,
): string | undefined {
  if (kind === "seed_disposition")
    return typeof record.seed_id === "string" ? record.seed_id : undefined;
  return typeof record.id === "string" ? record.id : undefined;
}

function proposition(
  kind: RepositoryFactKind,
  id: string,
  selected: SelectedFields,
): string | undefined {
  switch (kind) {
    case "seed_disposition":
      if (typeof selected.seed_id !== "string" || typeof selected.verdict !== "string")
        return undefined;
      return `Repository seed disposition ${id} sets seed_id ${selected.seed_id}, verdict ${selected.verdict}, scope_fit ${selected.scope_fit}, and source_quality ${selected.source_quality}.`;
    case "coverage_cell":
      return `Repository coverage ${id} sets lane ${selected.lane}, cell ${selected.cell}, and status ${selected.status}.`;
    case "public_file":
      return `Repository public file ${id} sets path ${selected.path} and public_id ${selected.public_id}.`;
    case "saturation_wave":
      return `Repository saturation ${id} sets scope ${selected.scope}, wave ${selected.wave}, candidate_queue_count ${selected.candidate_queue_count}, material_novelty_count ${selected.material_novelty_count}, and status ${selected.status}.`;
    case "repository_text":
      if (typeof selected.path !== "string" || typeof selected.statement !== "string")
        return undefined;
      return `Repository text ${selected.path} at ${id} states: ${selected.statement}`;
  }
}

export function repositoryAuditIdentity(
  source: Readonly<{
    repository_commit?: string | null | undefined;
    repository_path?: string | null | undefined;
  }>,
  fact: RepositoryFact,
): Readonly<{ digest: string; observationId: string; claimId: string }> | undefined {
  if (source.repository_commit === null || source.repository_path === null) return undefined;
  const tuple = JSON.stringify({
    repository_commit: source.repository_commit,
    repository_path: source.repository_path,
    record_kind: fact.recordKind,
    record_id: fact.recordId,
    fact_kind: fact.kind,
    subject_id: fact.subjectId,
    selected_fields: canonicalSelectedFields(fact.selectedFields),
  });
  const digest = sha256(tuple);
  const prefix = digest.slice(0, 16);
  return { digest, observationId: `OBS-AUDIT-${prefix}`, claimId: `CLM-AUDIT-${prefix}` };
}

export function repositoryFact(
  kind: RepositoryFactKind,
  record: Readonly<Record<string, unknown>>,
  selected: SelectedFields,
): RepositoryFact | undefined {
  const recordId = typeof record.id === "string" ? record.id : undefined;
  const recordKind = typeof record.record_type === "string" ? record.record_type : undefined;
  const expectedRecordKind: Record<RepositoryFactKind, string> = {
    seed_disposition: "seed_disposition",
    coverage_cell: "coverage",
    public_file: "public_file",
    saturation_wave: "saturation",
    repository_text: "repository_text",
  };
  if (recordId === undefined || recordKind !== expectedRecordKind[kind]) return undefined;
  const selectedFields = fields(record, selected);
  const subjectId = subject(kind, record);
  if (selectedFields === undefined || subjectId === undefined) return undefined;
  const canonical = JSON.stringify(canonicalSelectedFields(selectedFields));
  const digest = sha256(`${kind}\u0000${recordId}\u0000${canonical}`);
  const statement = proposition(kind, recordId, selectedFields);
  return statement === undefined
    ? undefined
    : { kind, recordKind, recordId, subjectId, selectedFields, digest, proposition: statement };
}

export function jsonlRecord(
  content: string,
  id: string,
): Readonly<Record<string, unknown>> | undefined {
  const block = /```jsonl\r?\n([\s\S]*?)```/.exec(content)?.[1];
  if (block === undefined) return undefined;
  for (const line of block.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const record = JSON.parse(line) as unknown;
    if (
      typeof record === "object" &&
      record !== null &&
      (record as Record<string, unknown>).id === id
    )
      return record as Record<string, unknown>;
  }
  return undefined;
}
