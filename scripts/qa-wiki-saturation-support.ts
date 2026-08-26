import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { parseCorpus } from "./qa-wiki-parse.ts";

const summarySchema = z.record(z.string(), z.number().int().nonnegative());
const ledgerObjectSchema = z.record(z.string(), z.unknown());
const jsonlPattern = /```jsonl\r?\n([\s\S]*?)```/;
/** @qa-literal generic-threshold */
const emptyCount = 0;

type CliResult = Readonly<{ exitCode: number; summary: Readonly<Record<string, number>> }>;
export type LedgerObject = z.infer<typeof ledgerObjectSchema>;
export type CorpusMutation = (wikiRoot: string) => void;

export class SaturationFixtureError extends Error {
  public constructor(readonly causeMessage: string) {
    super(causeMessage);
  }
}

export function runTask10Corpus(mutation?: CorpusMutation): CliResult {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "qa-wiki-saturation-"));
  const wikiRoot = join(fixtureRoot, "wiki");
  cpSync(join(import.meta.dir, "..", "wiki"), wikiRoot, { recursive: true });
  try {
    mutation?.(wikiRoot);
    const result = spawnSync("bun", ["run", "qa:wiki", wikiRoot], {
      cwd: join(import.meta.dir, ".."),
      encoding: "utf8",
    });
    const parsed = summarySchema.safeParse(JSON.parse(result.stdout.trim()));
    if (!parsed.success) throw new SaturationFixtureError(parsed.error.message);
    return { exitCode: result.status ?? 1, summary: parsed.data };
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

export function mutateSaturation(
  wikiRoot: string,
  transform: (records: readonly LedgerObject[]) => readonly LedgerObject[],
): void {
  const path = join(wikiRoot, "_ledgers", "saturation.md");
  const content = readFileSync(path, "utf8");
  const block = jsonlPattern.exec(content)?.[1];
  if (block === undefined) throw new SaturationFixtureError("Missing saturation JSONL block.");
  const records = block
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => ledgerObjectSchema.parse(JSON.parse(line)));
  const replacement = `\`\`\`jsonl\n${transform(records)
    .map((record) => JSON.stringify(record))
    .join("\n")}\n\`\`\``;
  writeFileSync(path, content.replace(jsonlPattern, replacement));
}

export function terminalRecord(records: readonly LedgerObject[], id: string): LedgerObject {
  const record = records.find((candidate) => candidate.id === id);
  if (record === undefined) throw new SaturationFixtureError(`Missing ${id}.`);
  return record;
}

export function removeCoverageRecord(wikiRoot: string): void {
  const path = join(wikiRoot, "_ledgers", "coverage.md");
  const content = readFileSync(path, "utf8");
  const block = jsonlPattern.exec(content)?.[1];
  if (block === undefined) throw new SaturationFixtureError("Missing coverage JSONL block.");
  const records = block.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const retained = records.slice(0, -1);
  if (retained.length === records.length)
    throw new SaturationFixtureError("No coverage record to remove.");
  writeFileSync(path, content.replace(jsonlPattern, `\`\`\`jsonl\n${retained.join("\n")}\n\`\`\``));
}

export async function expectedCorpusMetrics(): Promise<Readonly<Record<string, number>>> {
  const corpus = await parseCorpus(join(import.meta.dir, "..", "wiki"));
  const saturation = corpus.records.filter((record) => record.record_type === "saturation");
  const coverage = corpus.records.filter((record) => record.record_type === "coverage");
  const candidates = corpus.records.filter((record) => record.record_type === "candidate");
  const occurrences = corpus.records.filter(
    (record) => record.record_type === "candidate_occurrence",
  );
  const terminal = saturation
    .filter((record) => record.scope === "global" && record.status === "saturated")
    .toSorted((left, right) => left.searched_at.localeCompare(right.searched_at));
  const selected = terminal.slice(-2);
  const matrix = coverage
    .map((record) => ({
      id: record.id,
      lane: record.lane,
      cell: record.cell,
      status: record.status,
    }))
    .toSorted((left, right) => {
      const leftKey = `${left.lane}/${left.cell}/${left.id}`;
      const rightKey = `${right.lane}/${right.cell}/${right.id}`;
      if (leftKey < rightKey) return -1;
      return Number(leftKey > rightKey);
    });
  const matrixDigest = createHash("sha256").update(JSON.stringify(matrix)).digest("hex");
  const queued = candidates.filter((record) => record.status !== "terminal");
  return {
    "coverage-matrix-cells": coverage.length,
    "saturation-records": saturation.length,
    "terminal-zero-novelty-waves": terminal.filter(
      (record) => record.candidate_queue_count === 0 && record.material_novelty_count === 0,
    ).length,
    "distinct-terminal-query-manifests": new Set(
      selected.map((record) => record.query_manifest_sha256),
    ).size,
    "terminal-query-replays": selected.reduce(
      (total, record) => total + record.query_identity_sha256s.length,
      emptyCount,
    ),
    "coverage-matrix-linked-waves": selected.filter(
      (record) => record.coverage_matrix_sha256 === matrixDigest,
    ).length,
    "candidate-identities": new Set(candidates.map((record) => record.candidate_identity)).size,
    "candidate-occurrences": new Set(occurrences.map((record) => record.id)).size,
    "candidate-identity-records": candidates.length,
    "candidate-occurrence-records": occurrences.length,
    "candidate-provenance-links": candidates.flatMap((record) => record.occurrence_ids).length,
    "terminal-candidate-records": candidates.length - queued.length,
    "candidate-queue-count": queued.length,
  };
}
