import { createHash } from "node:crypto";
import { basename } from "node:path";
import type { MutableMetrics } from "./qa-wiki-metrics.ts";
import { increment } from "./qa-wiki-metrics.ts";
import type { ParsedCorpus } from "./qa-wiki-parse.ts";
import { checkCellAdequateWave } from "./qa-wiki-saturation-proof.ts";

const task10LedgerNames = ["conflicts.md", "redirects.md", "saturation.md"] as const;

export function checkSaturation(corpus: ParsedCorpus, metrics: MutableMetrics): void {
  const saturation = corpus.records.filter((record) => record.record_type === "saturation");
  const coverage = corpus.records.filter((record) => record.record_type === "coverage");
  const task10Required = corpus.files.some((file) =>
    task10LedgerNames.some((name) => basename(file.path) === name),
  );
  const matrixRows = coverage
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
  const matrixDigest = createHash("sha256").update(JSON.stringify(matrixRows)).digest("hex");
  const terminal = saturation
    .filter((record) => record.scope === "global" && record.status === "saturated")
    .toSorted((left, right) => left.searched_at.localeCompare(right.searched_at));
  const selected = terminal.slice(-2);

  metrics["coverage-matrix-cells"] = coverage.length;
  metrics["saturation-records"] = saturation.length;
  metrics["terminal-zero-novelty-waves"] = terminal.filter(
    (record) => record.candidate_queue_count === 0 && record.material_novelty_count === 0,
  ).length;
  metrics["distinct-terminal-query-manifests"] = new Set(
    selected.map((record) => record.query_manifest_sha256),
  ).size;
  metrics["terminal-query-replays"] = selected.reduce(
    (total, record) => total + record.query_identity_sha256s.length,
    0,
  );
  metrics["coverage-matrix-linked-waves"] = selected.filter(
    (record) => record.coverage_matrix_sha256 === matrixDigest,
  ).length;
  if (!task10Required) return;
  if (saturation.length === 0) increment(metrics, "missing-saturation-ledger");
  const latest = saturation
    .toSorted((left, right) => left.searched_at.localeCompare(right.searched_at))
    .at(-1);
  const explicitDowngrade =
    terminal.length === 0 &&
    latest?.status === "incomplete" &&
    latest.coverage_proof_status === "inadequate" &&
    latest.candidate_queue_count === 0 &&
    latest.material_novelty_count === 0;
  metrics["documented-incomplete-saturation"] = Number(explicitDowngrade);
  if (!explicitDowngrade && terminal.length < 2)
    increment(metrics, "insufficient-terminal-waves", 2 - terminal.length);
  for (const record of terminal) checkCellAdequateWave(record, coverage, corpus, metrics);
  increment(
    metrics,
    "terminal-candidate-queue",
    selected.filter((record) => record.candidate_queue_count > 0).length,
  );
  increment(
    metrics,
    "terminal-material-novelty",
    selected.filter((record) => record.material_novelty_count > 0).length,
  );
  increment(
    metrics,
    "unlinked-coverage-matrix",
    saturation.filter(
      (record) => record.scope === "global" && record.coverage_matrix_sha256 !== matrixDigest,
    ).length,
  );

  const ordered = saturation.toSorted((left, right) => {
    const timeOrder = left.searched_at.localeCompare(right.searched_at);
    return timeOrder === 0 ? left.id.localeCompare(right.id) : timeOrder;
  });
  const byId = new Map(ordered.map((record) => [record.id, record]));
  for (const [index, record] of ordered.entries()) {
    if (index === 0) continue;
    if (record.prior_wave_id === null) {
      increment(metrics, "missing-saturation-predecessors");
      continue;
    }
    const predecessor = byId.get(record.prior_wave_id);
    if (predecessor === undefined) {
      increment(metrics, "missing-saturation-predecessors");
      continue;
    }
    if (predecessor.searched_at >= record.searched_at)
      increment(metrics, "forward-saturation-predecessors");
    const predecessorIndex = ordered.findIndex((item) => item.id === predecessor.id);
    const recordIndex = ordered.findIndex((item) => item.id === record.id);
    if (predecessorIndex !== recordIndex - 1) increment(metrics, "skipped-saturation-predecessors");
    const seen = new Set<string>();
    let cursor = record;
    while (cursor.prior_wave_id !== null) {
      if (seen.has(cursor.id)) {
        increment(metrics, "cyclic-saturation-chain");
        break;
      }
      seen.add(cursor.id);
      const next = byId.get(cursor.prior_wave_id);
      if (next === undefined) break;
      cursor = next;
    }
  }
  if (selected.length !== 2) return;
  const first = selected[0];
  const second = selected[1];
  if (first === undefined || second === undefined) return;
  if (first.query_manifest_sha256 === second.query_manifest_sha256)
    increment(metrics, "duplicate-terminal-query-manifests");
  const queryCount = first.query_identity_sha256s.length + second.query_identity_sha256s.length;
  const uniqueQueryCount = new Set([
    ...first.query_identity_sha256s,
    ...second.query_identity_sha256s,
  ]).size;
  increment(metrics, "overlapping-terminal-queries", queryCount - uniqueQueryCount);
  const firstPrefixes = new Set(first.cell_query_mappings.map((item) => item.query_id[0]));
  const secondPrefixes = new Set(second.cell_query_mappings.map((item) => item.query_id[0]));
  const secondStartedAt = second.cell_query_mappings
    .map((item) => item.request_started_at)
    .toSorted()
    .at(0);
  if (
    firstPrefixes.size !== 1 ||
    secondPrefixes.size !== 1 ||
    firstPrefixes.values().next().value === secondPrefixes.values().next().value ||
    secondStartedAt === undefined ||
    secondStartedAt < first.searched_at
  )
    increment(metrics, "invalid-terminal-query-chronology");
  if (second.prior_wave_id !== first.id) increment(metrics, "broken-saturation-chain");
}
