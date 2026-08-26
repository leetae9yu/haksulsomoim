import { describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  expectedCorpusMetrics,
  mutateSaturation,
  removeCoverageRecord,
  runTask10Corpus,
  terminalRecord,
} from "./qa-wiki-saturation-support.ts";

/** @qa-literal generic-threshold */
const positiveMutationCount = 1;
/** @qa-literal immutable-contract */
const requiredTerminalWaves = 2;

describe("Given a Task 10 Wiki corpus", () => {
  test("When validating the reviewed corpus Then the cell-adequate saturation proof is emitted", async () => {
    const expected = await expectedCorpusMetrics();
    const result = runTask10Corpus();
    expect(result.exitCode).toBe(0);
    for (const [metric, value] of Object.entries(expected))
      expect(result.summary[metric]).toBe(value);
    expect(result.summary["documented-incomplete-saturation"]).toBe(0);
    expect(result.summary["terminal-zero-novelty-waves"]).toBe(requiredTerminalWaves);
  });

  test("When the saturation ledger is removed Then the missing saturation gate fails", () => {
    const result = runTask10Corpus((wikiRoot) =>
      unlinkSync(join(wikiRoot, "_ledgers", "saturation.md")),
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.summary["missing-saturation-ledger"]).toBeGreaterThan(0);
  });

  test("When the coverage matrix loses a record Then its derived count and saturation binding fail", async () => {
    const expected = await expectedCorpusMetrics();
    const result = runTask10Corpus(removeCoverageRecord);
    expect(result.exitCode).not.toBe(0);
    expect(result.summary["coverage-matrix-cells"]).toBe(
      z.number().parse(expected["coverage-matrix-cells"]) - 1,
    );
    expect(result.summary["unlinked-coverage-matrix"]).toBeGreaterThan(0);
  });

  test("When one incomplete wave falsely declares saturation Then the two-wave gate fails", () => {
    const result = runTask10Corpus((wikiRoot) =>
      mutateSaturation(wikiRoot, (records) =>
        records.map((record) =>
          record.id === "SAT-1004" ? { ...record, status: "incomplete" } : record,
        ),
      ),
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.summary["insufficient-terminal-waves"]).toBeGreaterThan(0);
  });

  test("When a purported terminal wave has novelty Then the novelty gate fails", () => {
    const result = runTask10Corpus((wikiRoot) =>
      mutateSaturation(wikiRoot, (records) =>
        records.map((record) =>
          record.id === "SAT-1005"
            ? { ...record, material_novelty_count: positiveMutationCount }
            : record,
        ),
      ),
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.summary["terminal-material-novelty"]).toBeGreaterThan(0);
  });

  test("When purported terminal manifests and query identities overlap Then both identity gates fail", () => {
    const result = runTask10Corpus((wikiRoot) =>
      mutateSaturation(wikiRoot, (records) => {
        const first = terminalRecord(records, "SAT-1004");
        const manifest = z.string().parse(first.query_manifest_sha256);
        const queries = z.array(z.string()).parse(first.query_identity_sha256s);
        return records.map((record) => {
          if (record.id === "SAT-1004") return record;
          if (record.id === "SAT-1005")
            return {
              ...record,
              status: "saturated",
              query_manifest_sha256: manifest,
              query_identity_sha256s: queries,
            };
          return record;
        });
      }),
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.summary["duplicate-terminal-query-manifests"]).toBeGreaterThan(0);
    expect(result.summary["overlapping-terminal-queries"]).toBeGreaterThan(0);
  });

  test("When a purported terminal queue is positive Then the candidate-queue gate fails", () => {
    const result = runTask10Corpus((wikiRoot) =>
      mutateSaturation(wikiRoot, (records) =>
        records.map((record) =>
          record.id === "SAT-1005"
            ? { ...record, candidate_queue_count: positiveMutationCount }
            : record,
        ),
      ),
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.summary["terminal-candidate-queue"]).toBeGreaterThan(0);
  });

  test("When a saturation wave is linked to another matrix Then the matrix gate fails", () => {
    const result = runTask10Corpus((wikiRoot) =>
      mutateSaturation(wikiRoot, (records) =>
        records.map((record) =>
          record.id === "SAT-1004" ? { ...record, coverage_matrix_sha256: "f".repeat(64) } : record,
        ),
      ),
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.summary["unlinked-coverage-matrix"]).toBeGreaterThan(0);
  });

  test("When the final identity declaration no longer matches records Then the identity-count gate fails", () => {
    const result = runTask10Corpus((wikiRoot) =>
      mutateSaturation(wikiRoot, (records) =>
        records.map((record) =>
          record.id === "SAT-1005"
            ? {
                ...record,
                candidate_identity_count: z.number().parse(record.candidate_identity_count) + 1,
              }
            : record,
        ),
      ),
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.summary["candidate-identity-count-mismatch"]).toBeGreaterThan(0);
  });

  test("When the final occurrence declaration no longer matches records Then the occurrence-count gate fails", () => {
    const result = runTask10Corpus((wikiRoot) =>
      mutateSaturation(wikiRoot, (records) =>
        records.map((record) =>
          record.id === "SAT-1005"
            ? {
                ...record,
                candidate_occurrence_count: z.number().parse(record.candidate_occurrence_count) + 1,
              }
            : record,
        ),
      ),
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.summary["candidate-occurrence-count-mismatch"]).toBeGreaterThan(0);
  });

  test("When SAT-1001 has no predecessor Then the missing-predecessor gate fails", () => {
    const result = runTask10Corpus((wikiRoot) =>
      mutateSaturation(wikiRoot, (records) =>
        records.map((record) =>
          record.id === "SAT-1001" ? { ...record, prior_wave_id: null } : record,
        ),
      ),
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.summary["missing-saturation-predecessors"]).toBeGreaterThan(0);
  });

  test("When SAT-1001 references a missing predecessor Then the predecessor gate fails", () => {
    const result = runTask10Corpus((wikiRoot) =>
      mutateSaturation(wikiRoot, (records) =>
        records.map((record) =>
          record.id === "SAT-1001" ? { ...record, prior_wave_id: "SAT-9999" } : record,
        ),
      ),
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.summary["missing-saturation-predecessors"]).toBeGreaterThan(0);
  });

  test("When SAT-1001 links to itself Then the cycle gate fails", () => {
    const result = runTask10Corpus((wikiRoot) =>
      mutateSaturation(wikiRoot, (records) =>
        records.map((record) =>
          record.id === "SAT-1001" ? { ...record, prior_wave_id: "SAT-1001" } : record,
        ),
      ),
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.summary["cyclic-saturation-chain"]).toBeGreaterThan(0);
  });

  test("When SAT-1001 links forward Then the forward-predecessor gate fails", () => {
    const result = runTask10Corpus((wikiRoot) =>
      mutateSaturation(wikiRoot, (records) =>
        records.map((record) =>
          record.id === "SAT-1001" ? { ...record, prior_wave_id: "SAT-1002" } : record,
        ),
      ),
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.summary["forward-saturation-predecessors"]).toBeGreaterThan(0);
  });

  test("When SAT-1002 skips SAT-1001 Then the continuity gate fails", () => {
    const result = runTask10Corpus((wikiRoot) =>
      mutateSaturation(wikiRoot, (records) =>
        records.map((record) =>
          record.id === "SAT-1002" ? { ...record, prior_wave_id: "SAT-1000" } : record,
        ),
      ),
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.summary["skipped-saturation-predecessors"]).toBeGreaterThan(0);
  });
});
