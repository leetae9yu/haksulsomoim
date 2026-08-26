import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

const jsonlPattern = /```jsonl\r?\n([\s\S]*?)```/;
const ledgerObjectSchema = z.record(z.string(), z.unknown());
const cutoff = "2026-08-25T06:42:44Z";
/** @qa-literal fixture-local-input-derived */
const fixtureResponseStatus = 200;
/** @qa-literal fixture-local-input-derived */
const firstFixtureResponseBytes = 123;
/** @qa-literal fixture-local-input-derived */
const secondFixtureResponseBytes = 456;

export const candidateReviewRecords = [
  {
    record_type: "candidate_review",
    id: "CRV-0001",
    research_cutoff: cutoff,
    candidate_occurrence_id: "CAO-0002",
    query_id: "A-SCOPE-01",
    candidate_url: "https://fixture.example/a",
    disposition: "duplicate_confirmation",
    retrieval: {
      status: "retrieved",
      url: "https://fixture.example/a",
      request_started_at: "2026-08-25T09:34:42Z",
      response_received_at: "2026-08-25T09:34:43Z",
      response_status: fixtureResponseStatus,
      response_sha256: "a".repeat(64),
      response_bytes: firstFixtureResponseBytes,
    },
    canonical_target: {
      record_type: "candidate_occurrence",
      id: "CAO-0001",
      canonical_url: "https://fixture.example/a",
    },
    rationale:
      "Candidate https://fixture.example/a duplicates CAO-0001 for the SCOPE fixture; the exact target confirms the same source identity and cannot change CLM-SCOPE-0001.",
    reviewed_at: "2026-08-25T09:34:44Z",
    material_novelty: false,
    caveats: [],
  },
  {
    record_type: "candidate_review",
    id: "CRV-0002",
    research_cutoff: cutoff,
    candidate_occurrence_id: "CAO-0003",
    query_id: "B-SCOPE-01",
    candidate_url: "https://fixture.example/b",
    disposition: "bounded_context",
    retrieval: {
      status: "retrieved",
      url: "https://fixture.example/b",
      request_started_at: "2026-08-25T09:36:40Z",
      response_received_at: "2026-08-25T09:36:41Z",
      response_status: fixtureResponseStatus,
      response_sha256: "b".repeat(64),
      response_bytes: secondFixtureResponseBytes,
    },
    canonical_target: null,
    rationale:
      "Candidate https://fixture.example/b is bounded context for the SCOPE fixture because it does not address CLM-SCOPE-0001 or resolve COV-SCOPE-0001's documented gap.",
    reviewed_at: "2026-08-25T09:36:42Z",
    material_novelty: false,
    caveats: [],
  },
] as const;

export function bindSyntheticCounts(
  wikiRoot: string,
  candidateRecords: readonly Record<string, unknown>[],
): void {
  const path = join(wikiRoot, "_ledgers", "saturation.md");
  const content = readFileSync(path, "utf8");
  const block = jsonlPattern.exec(content)?.[1];
  if (block === undefined) throw new Error("Missing saturation JSONL block.");
  const occurrences = candidateRecords.filter(
    (record) => record.record_type === "candidate_occurrence",
  );
  const records = block
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => ledgerObjectSchema.parse(JSON.parse(line)))
    .filter((record) => record.status !== "saturated")
    .map((record) => {
      const searchedAt = z.string().parse(record.searched_at);
      const active = occurrences.filter(
        (occurrence) => z.string().parse(occurrence.resolved_at) <= searchedAt,
      );
      return {
        ...record,
        candidate_identity_count: new Set(active.map((item) => item.candidate_identity)).size,
        candidate_occurrence_count: active.length,
      };
    });
  const replacement = `\`\`\`jsonl\n${records.map((record) => JSON.stringify(record)).join("\n")}\n\`\`\``;
  writeFileSync(path, content.replace(jsonlPattern, replacement));
}

export function writeJsonlLedger(path: string, title: string, records: readonly unknown[]): void {
  writeFileSync(
    path,
    `# ${title}\n\n\`\`\`jsonl\n${records.map((record) => JSON.stringify(record)).join("\n")}\n\`\`\`\n`,
  );
}
