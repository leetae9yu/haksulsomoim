import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { reportBlocks } from "./qa-wiki-report-render.ts";
import { mutateSaturation, runTask10Corpus } from "./qa-wiki-saturation-support.ts";
import { withPublicWiki } from "./qa-wiki-test-support.ts";

const cutoff = "2026-08-25T06:42:44Z";
const jsonlPattern = /```jsonl\r?\n([\s\S]*?)```/;
/** @qa-literal fixture-local-input-derived */
const emptyFixtureCount = 0;
type JsonRecord = Record<string, unknown>;

function rewriteJsonl(path: string, mutate: (records: JsonRecord[]) => void): void {
  const content = readFileSync(path, "utf8");
  const block = jsonlPattern.exec(content)?.[1];
  if (block === undefined) throw new Error(`Missing JSONL block in ${path}.`);
  const records = block
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as JsonRecord);
  mutate(records);
  const replacement = `\`\`\`jsonl\n${records.map((record) => JSON.stringify(record)).join("\n")}\n\`\`\``;
  writeFileSync(path, content.replace(jsonlPattern, replacement));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function rebindUnrelatedReportClaim(root: string): void {
  const reportPath = join(root, "report.md");
  const before = readFileSync(reportPath, "utf8");
  const after = before.replace("[CLM-SAFETY-0001]", "[CLM-FRAUD-5001]");
  if (after === before) throw new Error("Missing privacy citation.");
  writeFileSync(reportPath, after);
  const block = reportBlocks(after).find((item) => item.section === "Copyright and privacy");
  if (block === undefined) throw new Error("Missing privacy report block.");
  rewriteJsonl(join(root, "_ledgers", "report-render.md"), (records) => {
    const manifest = records.find((record) => record.record_type === "report_render");
    const assertion = records.find((record) => record.id === "RRA-0063");
    if (manifest === undefined || assertion === undefined)
      throw new Error("Missing report render records.");
    manifest.report_sha256 = sha256(after);
    assertion.content_sha256 = block.digest;
    const bindings = assertion.claim_bindings as JsonRecord[];
    const binding = bindings.find((item) => item.claim_id === "CLM-SAFETY-0001");
    if (binding === undefined) throw new Error("Missing privacy claim binding.");
    binding.claim_id = "CLM-FRAUD-5001";
    binding.evidence_status = "verified";
    binding.publication_status = "draft";
    binding.qualifier_class = "draft";
  });
}

describe("Given the Task 14 methodology contracts", () => {
  test("When one broad query is labeled as cell-adequate Then semantic coverage fails named", () => {
    const result = runTask10Corpus((root) =>
      mutateSaturation(root, (records) =>
        records.map((record) =>
          record.id === "SAT-1002"
            ? {
                ...record,
                status: "saturated",
                coverage_proof_status: "cell_adequate",
                cell_query_mappings: [
                  {
                    coverage_id: "COV-CIVIL-0009",
                    lane: "CIVIL",
                    cell: "civil-answer-deadline",
                    query_id: "X-CIVIL-01",
                    query_identity_sha256: "a".repeat(64),
                    query_text: "소액사건심판",
                    target_proposition: "답변서 제출 기준과 기간",
                    semantic_terms: ["답변서", "제출기간"],
                    response_parser: { method: "law_search_json", target: "prec" },
                    request_method: "GET",
                    request_url: "https://www.law.go.kr/DRF/lawSearch.do",
                    request_body: null,
                    request_started_at: "2026-08-25T09:35:00Z",
                    response_received_at: "2026-08-25T09:35:01Z",
                    response_status: null,
                    response_url: "https://www.law.go.kr/DRF/lawSearch.do",
                    response_sha256: null,
                    response_bytes: null,
                    access_state: "access_gap",
                    access_error: { kind: "dns", code: "EAI_NONAME", message: "fixture" },
                    result_count: emptyFixtureCount,
                    result_occurrence_ids: [],
                    result_receipt_sha256: "b".repeat(64),
                    reviewed_at: "2026-08-25T09:35:02Z",
                    adjudication: "Broad unrelated query retained only for a failing fixture.",
                    material_novelty_count: emptyFixtureCount,
                    candidate_queue_before_review: emptyFixtureCount,
                    candidate_queue_after_review: emptyFixtureCount,
                  },
                ],
              }
            : record,
        ),
      ),
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.summary["inadequate-terminal-query-mappings"]).toBeGreaterThan(0);
  });

  test("When an alias review loses its exact target and receipt Then adjudication fails named", () => {
    const result = withPublicWiki((root) => {
      const path = join(root, "_ledgers", "candidate-reviews.md");
      if (!existsSync(path)) return;
      rewriteJsonl(path, (records) => {
        const alias = records.find((record) => record.disposition === "duplicate_confirmation");
        if (alias === undefined) throw new Error("Missing duplicate candidate review.");
        alias.canonical_target = null;
        alias.retrieval = null;
      });
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.summary["invalid-terminal-candidate-reviews"]).toBeGreaterThan(0);
  });

  test.each([
    "The candidate changes no claim, status, gap, or conflict.",
    "No claim, status, gap, or conflict changes after this review.",
    "The canonical source identity was already adjudicated.",
    "This has no material claim beyond accepted records.",
  ])("When a candidate rationale is generic %s Then adjudication fails named", (rationale) => {
    const result = withPublicWiki((root) => {
      rewriteJsonl(join(root, "_ledgers", "candidate-reviews.md"), (records) => {
        const review = records[0];
        if (review === undefined) throw new Error("Missing candidate review.");
        review.rationale = rationale;
      });
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.summary["invalid-terminal-candidate-reviews"]).toBeGreaterThan(0);
  });

  test("When render execution is backdated to the research cutoff Then chronology fails named", () => {
    const result = withPublicWiki((root) => {
      for (const name of ["public-render.md", "report-render.md"])
        rewriteJsonl(join(root, "_ledgers", name), (records) => {
          const manifest = records.find((record) =>
            ["public_render", "report_render"].includes(String(record.record_type)),
          );
          if (manifest === undefined) throw new Error(`Missing ${name} manifest.`);
          manifest.rendered_at = cutoff;
        });
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.summary["backdated-render-timestamps"]).toBeGreaterThan(0);
  });

  test("When the police metric conflict loses its counter-observation Then publication fails named", () => {
    const result = withPublicWiki((root) => {
      rewriteJsonl(join(root, "_ledgers", "claims", "STATISTICS.md"), (records) => {
        const claim = records.find((record) => record.id === "CLM-STATISTICS-9001");
        if (claim === undefined) throw new Error("Missing police statistic claim.");
        claim.counter_observation_ids = [];
      });
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.summary["unadjudicated-statistic-definitions"]).toBeGreaterThan(0);
  });

  test("When hashes and statuses are refreshed around an unrelated citation Then proposition fails", () => {
    const result = withPublicWiki(rebindUnrelatedReportClaim);
    expect(result.exitCode).not.toBe(0);
    expect(result.summary["report-proposition-mismatches"]).toBeGreaterThan(0);
  });
});
