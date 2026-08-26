import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  bindSyntheticCounts,
  candidateReviewRecords,
  writeJsonlLedger,
} from "./qa-wiki-candidate-test-support.ts";

const summarySchema = z.record(z.string(), z.number().int().nonnegative());
const ledgerObjectSchema = z.record(z.string(), z.unknown());
const cutoff = "2026-08-25T06:42:44Z";
/** @qa-literal fixture-local-input-derived */
const fixtureOriginTask = { discovery: 5, terminal: 10 } as const;

type CliResult = Readonly<{ exitCode: number; summary: Readonly<Record<string, number>> }>;
type LedgerObject = z.infer<typeof ledgerObjectSchema>;
type InventoryTransform = (records: readonly LedgerObject[]) => readonly LedgerObject[];

const candidateRecords = [
  {
    record_type: "candidate",
    id: "CAD-0001",
    research_cutoff: cutoff,
    candidate_identity: "https://fixture.example/a",
    lanes: ["SCOPE"],
    status: "terminal",
    disposition: "accepted_existing",
    material_novelty: false,
    occurrence_ids: ["CAO-0001", "CAO-0002"],
    caveats: [],
  },
  {
    record_type: "candidate",
    id: "CAD-0002",
    research_cutoff: cutoff,
    candidate_identity: "https://fixture.example/b",
    lanes: ["SCOPE"],
    status: "terminal",
    disposition: "bounded_context",
    material_novelty: false,
    occurrence_ids: ["CAO-0003"],
    caveats: [],
  },
  {
    record_type: "candidate_occurrence",
    id: "CAO-0001",
    research_cutoff: cutoff,
    candidate_id: "CAD-0001",
    candidate_identity: "https://fixture.example/a",
    source_occurrence_id: "CAN-0001",
    candidate_key: "fixture:a:first",
    lane: "SCOPE",
    origin_task: fixtureOriginTask.discovery,
    origin_type: "source_record",
    origin_refs: ["SRC-SCOPE-0001"],
    evidence_refs: ["wiki/_ledgers/sources/SCOPE.md"],
    disposition: "accepted_existing",
    material_novelty: false,
    prompt_text_inert: true,
    resolved_at: "2026-08-25T09:28:34Z",
  },
  {
    record_type: "candidate_occurrence",
    id: "CAO-0002",
    research_cutoff: cutoff,
    candidate_id: "CAD-0001",
    candidate_identity: "https://fixture.example/a",
    source_occurrence_id: "CAN-0002",
    candidate_key: "fixture:a:repeat",
    lane: "SCOPE",
    origin_task: fixtureOriginTask.terminal,
    origin_type: "terminal_wave_result",
    origin_refs: ["A", "A-SCOPE-01"],
    evidence_refs: ["wave-A-results.json"],
    disposition: "duplicate_confirmation",
    material_novelty: false,
    prompt_text_inert: true,
    resolved_at: "2026-08-25T09:34:44Z",
  },
  {
    record_type: "candidate_occurrence",
    id: "CAO-0003",
    research_cutoff: cutoff,
    candidate_id: "CAD-0002",
    candidate_identity: "https://fixture.example/b",
    source_occurrence_id: "CAN-0003",
    candidate_key: "fixture:b:first",
    lane: "SCOPE",
    origin_task: fixtureOriginTask.terminal,
    origin_type: "terminal_wave_result",
    origin_refs: ["B", "B-SCOPE-01"],
    evidence_refs: ["wave-B-results.json"],
    disposition: "bounded_context",
    material_novelty: false,
    prompt_text_inert: true,
    resolved_at: "2026-08-25T09:36:42Z",
  },
] satisfies readonly LedgerObject[];

function runCandidateCorpus(transform?: InventoryTransform): CliResult {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "qa-wiki-candidates-"));
  const wikiRoot = join(fixtureRoot, "wiki");
  cpSync(join(import.meta.dir, "..", "wiki"), wikiRoot, { recursive: true });
  try {
    for (const path of [
      "report.md",
      "_ledgers/report-render.md",
      "_ledgers/public-render.md",
      "_ledgers/seed-dispositions.md",
      "_ledgers/claims/task-13-derived.md",
      "_ledgers/verification/task-13-derived.md",
      "_ledgers/sources/task-13-repository.md",
      "_ledgers/observations/task-13-repository.md",
    ])
      rmSync(join(wikiRoot, path), { force: true });
    writeFileSync(join(wikiRoot, "seed-dispositions.md"), "# Candidate fixture link target\n");
    bindSyntheticCounts(wikiRoot, candidateRecords);
    writeJsonlLedger(
      join(wikiRoot, "_ledgers", "candidates.md"),
      "Candidate fixture",
      transform?.(candidateRecords) ?? candidateRecords,
    );
    writeJsonlLedger(
      join(wikiRoot, "_ledgers", "candidate-reviews.md"),
      "Candidate review fixture",
      candidateReviewRecords,
    );
    const result = spawnSync("bun", ["run", "qa:wiki", wikiRoot], {
      cwd: join(import.meta.dir, ".."),
      encoding: "utf8",
    });
    const parsed = summarySchema.safeParse(JSON.parse(result.stdout.trim()));
    if (!parsed.success) throw new Error(parsed.error.message);
    return { exitCode: result.status ?? 1, summary: parsed.data };
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

function occurrenceIds(record: LedgerObject): readonly string[] {
  return z.array(z.string()).parse(record.occurrence_ids);
}

describe("Given a tracked Task 10 candidate inventory", () => {
  test("When validating the linked fixture Then recomputed candidate counts pass", () => {
    const candidates = candidateRecords.filter((record) => record.record_type === "candidate");
    const occurrences = candidateRecords.filter(
      (record) => record.record_type === "candidate_occurrence",
    );
    const result = runCandidateCorpus();
    if (result.exitCode !== 0) throw new Error(JSON.stringify(result.summary));
    expect(result.exitCode).toBe(0);
    expect(result.summary["candidate-identity-records"]).toBe(candidates.length);
    expect(result.summary["candidate-occurrence-records"]).toBe(occurrences.length);
    expect(result.summary["candidate-provenance-links"]).toBe(
      candidates.flatMap((record) => record.occurrence_ids).length,
    );
    expect(result.summary["terminal-candidate-records"]).toBe(
      candidates.filter((record) => record.status === "terminal").length,
    );
  });

  test("When two candidate rows share an identity Then duplicate identity fails", () => {
    const result = runCandidateCorpus((records) =>
      records.map((record) =>
        record.id === "CAD-0002"
          ? { ...record, candidate_identity: "https://fixture.example/a" }
          : record,
      ),
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.summary["duplicate-candidate-identities"]).toBeGreaterThan(0);
  });

  test("When two occurrence rows share an ID Then duplicate occurrence fails", () => {
    const result = runCandidateCorpus((records) => {
      const duplicate = records.find((record) => record.id === "CAO-0003");
      if (duplicate === undefined) throw new Error("Missing occurrence fixture.");
      return [...records, duplicate];
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.summary["duplicate-candidate-occurrence-ids"]).toBeGreaterThan(0);
  });

  test("When an occurrence has no provenance link Then orphan occurrence fails", () => {
    const result = runCandidateCorpus((records) =>
      records.map((record) =>
        record.id === "CAD-0001" ? { ...record, occurrence_ids: ["CAO-0001"] } : record,
      ),
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.summary["orphan-candidate-occurrences"]).toBeGreaterThan(0);
  });

  test("When an occurrence is linked twice Then double-linked occurrence fails", () => {
    const result = runCandidateCorpus((records) =>
      records.map((record) =>
        record.id === "CAD-0001"
          ? { ...record, occurrence_ids: [...occurrenceIds(record), "CAO-0003"] }
          : record,
      ),
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.summary["double-linked-candidate-occurrences"]).toBeGreaterThan(0);
  });

  test("When an occurrence loses its candidate row Then missing identity fails", () => {
    const result = runCandidateCorpus((records) =>
      records.filter((record) => record.id !== "CAD-0002"),
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.summary["missing-candidate-identities"]).toBeGreaterThan(0);
  });

  test("When a candidate remains queued Then inventory queue fails", () => {
    const result = runCandidateCorpus((records) =>
      records.map((record) =>
        record.id === "CAD-0002" ? { ...record, status: "queued" } : record,
      ),
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.summary["candidate-inventory-queue"]).toBeGreaterThan(0);
  });
});
