import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { parseCorpus } from "./qa-wiki-parse.ts";
import { reportBlocks } from "./qa-wiki-report-render.ts";

const summarySchema = z.record(z.string(), z.number().int().nonnegative());
/** @qa-literal immutable-contract */
const frozenSeedRecordCount = 21;

type Result = Readonly<{
  exitCode: number;
  output: string;
  summary: Readonly<Record<string, number>>;
}>;
function run(root: string): Result {
  const result = spawnSync("bun", ["run", "qa:wiki", root], {
    cwd: `${import.meta.dir}/..`,
    encoding: "utf8",
  });
  const output = result.stdout.trim();
  return { exitCode: result.status ?? 1, output, summary: summarySchema.parse(JSON.parse(output)) };
}

function withWiki(mutator: (root: string) => void): Result {
  const root = mkdtempSync(join(tmpdir(), "qa-wiki-final-"));
  try {
    cpSync("wiki", root, { recursive: true });
    mutator(root);
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("Given the final Wiki aggregation contract", () => {
  test("When the real corpus is validated Then structural counts are recomputed", async () => {
    const corpus = await parseCorpus(join(import.meta.dir, "..", "wiki"));
    const coverageCount = corpus.records.filter(
      (record) => record.record_type === "coverage",
    ).length;
    const result = run("wiki");
    expect(result.exitCode).toBe(0);
    expect(result.summary["seed-audit-files"]).toBe(frozenSeedRecordCount);
    expect(result.summary["seed-disposition-records"]).toBe(frozenSeedRecordCount);
    expect(result.summary["coverage-matrix-cells"]).toBe(coverageCount);
    expect(result.summary["candidate-identities"]).toBeGreaterThan(0);
    expect(result.summary["public-render-files"]).toBeGreaterThan(0);
  });

  test("When the same corpus is validated twice Then the JSON bytes are stable", () => {
    expect(run("wiki").output).toBe(run("wiki").output);
  });

  test("When a seed disposition is removed Then seed aggregation fails", () => {
    const result = withWiki((root) => {
      const path = join(root, "_ledgers", "seed-dispositions.md");
      writeFileSync(path, readFileSync(path, "utf8").replace(/^.*"seed_id":"P1".*\n/m, ""));
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.summary["seed-audit-mismatches"]).toBeGreaterThan(0);
  });

  test("When the structural corpus loses its report Then report rendering fails", () => {
    const result = withWiki((root) => unlinkSync(join(root, "report.md")));
    expect(result.exitCode).not.toBe(0);
    expect(result.summary["report-structure-mismatches"]).toBeGreaterThan(0);
  });

  test("When a report citation is valid but belongs to another assertion Then report rendering fails", () => {
    const result = withWiki((root) => {
      const path = join(root, "report.md");
      const content = readFileSync(path, "utf8");
      const blocks = reportBlocks(content);
      const source = blocks.find((block) =>
        blocks.some((candidate) => candidate.claimIds.some((id) => !block.claimIds.includes(id))),
      );
      if (source === undefined || source.claimIds[0] === undefined)
        throw new Error("Expected report assertions with distinct valid claim IDs.");
      const replacement = blocks
        .flatMap((block) => block.claimIds)
        .find((id) => !source.claimIds.includes(id));
      if (replacement === undefined)
        throw new Error("Expected an unrelated valid report claim ID.");
      writeFileSync(path, content.replace(`[${source.claimIds[0]}]`, `[${replacement}]`));
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.summary["report-render-mismatches"]).toBeGreaterThan(0);
    expect(result.summary["report-assertion-mismatches"]).toBeGreaterThan(0);
  });

  test.each([
    "The evidence confirms representative recovery outcomes [CLM-STATISTICS-9013].",
    "제품 사용이 회수를 유발한다 [CLM-STATISTICS-9013].",
  ])(
    "When report prose makes a banned inference in either language Then inference fails",
    (prose) => {
      const result = withWiki((root) => {
        const path = join(root, "report.md");
        writeFileSync(path, `${readFileSync(path, "utf8")}\n${prose}\n`);
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.summary["banned-report-inferences"]).toBeGreaterThan(0);
    },
  );

  test("When a caveat serializes an excerpt field Then the embedded-source-text gate fails", () => {
    const result = withWiki((root) => {
      const path = join(root, "_ledgers", "verification", "task-5-evidence.md");
      const content = readFileSync(path, "utf8");
      const caveat = 'candidate_adjudications_json=[{"excerpt":"copied judgment body"}]';
      writeFileSync(
        path,
        content.replace(
          '"caveats":["현행 형사소송법 조문과 대법원 공식 제공 판례 전문을 대조했다."]',
          `"caveats":[${JSON.stringify(caveat)}]`,
        ),
      );
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.summary["embedded-source-text-fields"]).toBeGreaterThan(0);
  });

  test("When a caveat nests serialized full text Then the embedded-source-text gate fails", () => {
    const result = withWiki((root) => {
      const path = join(root, "_ledgers", "verification", "task-5-evidence.md");
      const content = readFileSync(path, "utf8");
      const nested = JSON.stringify({
        payload: JSON.stringify({ full_text: "copied judgment body" }),
      });
      writeFileSync(
        path,
        content.replace(
          '"caveats":["현행 형사소송법 조문과 대법원 공식 제공 판례 전문을 대조했다."]',
          `"caveats":[${JSON.stringify(`candidate_json=${nested}`)}]`,
        ),
      );
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.summary["embedded-source-text-fields"]).toBeGreaterThan(0);
  });

  test("When a caveat has a short relevance rationale Then the embedded-source-text gate allows it", () => {
    const result = withWiki((root) => {
      const path = join(root, "_ledgers", "verification", "task-5-evidence.md");
      const content = readFileSync(path, "utf8");
      const caveat =
        'candidate_adjudications_json=[{"relevance_rationale":"Short relevance rationale."}]';
      writeFileSync(
        path,
        content.replace(
          '"caveats":["현행 형사소송법 조문과 대법원 공식 제공 판례 전문을 대조했다."]',
          `"caveats":[${JSON.stringify(caveat)}]`,
        ),
      );
    });
    expect(result.exitCode).toBe(0);
    expect(result.summary["embedded-source-text-fields"]).toBe(0);
  });

  test.each([
    ["wiki-invalid/derived-cycle", "derived-claim-cycles"],
    ["wiki-invalid/derived-dangling-leaf", "dangling-ledger-ids"],
    ["wiki-invalid/overlong-excerpt", "overlong-excerpts"],
  ])("When %s is validated Then %s is named", (fixture, metric) => {
    const result = run(`fixtures/${fixture}`);
    expect(result.exitCode).not.toBe(0);
    expect(result.summary[metric]).toBeGreaterThan(0);
  });

  test("When a report omits a claim citation Then the named report gate fails", () => {
    const result = run("fixtures/wiki-invalid/report-missing-citation");
    expect(result.exitCode).not.toBe(0);
    expect(result.summary["unresolved-report-citations"]).toBeGreaterThan(0);
  });

  test("When a report cites an unknown claim Then the named report gate fails", () => {
    const result = run("fixtures/wiki-invalid/report-unresolved-claim");
    expect(result.exitCode).not.toBe(0);
    expect(result.summary["unresolved-report-citations"]).toBeGreaterThan(0);
  });

  test("When a report has an unqualified public number Then the numeric gate fails", () => {
    const result = run("fixtures/wiki-invalid/report-unqualified-number");
    expect(result.exitCode).not.toBe(0);
    expect(result.summary["unqualified-numerical-claims"]).toBeGreaterThan(0);
  });

  test("When a report makes a representative recovery inference Then the inference gate fails", () => {
    const result = run("fixtures/wiki-invalid/report-banned-inference");
    expect(result.exitCode).not.toBe(0);
    expect(result.summary["banned-report-inferences"]).toBeGreaterThan(0);
  });
});
