import { describe, expect, test } from "bun:test";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { withPublicWiki } from "./qa-wiki-test-support.ts";

describe("Given the tracked report contract", () => {
  test("When the structural corpus loses its tracked report Then the CLI rejects the missing surface", () => {
    const result = withPublicWiki((path) => unlinkSync(join(path, "report.md")));
    expect(result.exitCode).not.toBe(0);
    expect(result.summary["report-structure-mismatches"]).toBeGreaterThan(0);
  });

  test("When a factual report assertion is unregistered Then the CLI rejects it", () => {
    const result = withPublicWiki((path) => {
      const file = join(path, "report.md");
      writeFileSync(
        file,
        `${readFileSync(file, "utf8")}\n새 factual assertion [CLM-SCOPE-9014].\n`,
      );
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.summary["unregistered-report-assertions"]).toBeGreaterThan(0);
  });

  test("When a report citation is replaced by an unrelated valid claim Then the assertion binding rejects it", () => {
    const result = withPublicWiki((path) => {
      const file = join(path, "report.md");
      const content = readFileSync(file, "utf8");
      const citation = /\[CLM-AUDIT-[a-f0-9]{16}\]/.exec(content)?.[0];
      if (citation === undefined) throw new Error("Missing repository audit citation.");
      writeFileSync(file, content.replace(citation, "[CLM-STATISTICS-9013]"));
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.summary["report-assertion-mismatches"]).toBeGreaterThan(0);
  });

  test("When a tracked report or assertion manifest is stale or duplicated Then the CLI rejects it", () => {
    const stale = withPublicWiki((path) => {
      const file = join(path, "report.md");
      writeFileSync(file, readFileSync(file, "utf8").replace("LLM Wiki", "Bound LLM Wiki"));
    });
    expect(stale.exitCode).not.toBe(0);
    expect(stale.summary["report-render-mismatches"]).toBeGreaterThan(0);
    const duplicate = withPublicWiki((path) => {
      const file = join(path, "_ledgers", "report-render.md");
      const content = readFileSync(file, "utf8");
      const assertion = content.split(/\r?\n/).find((line) => line.includes('"report_assertion"'));
      if (assertion === undefined) throw new Error("Missing report assertion fixture record.");
      const closing = content.lastIndexOf("\n```");
      writeFileSync(file, `${content.slice(0, closing)}\n${assertion}${content.slice(closing)}`);
    });
    expect(duplicate.exitCode).not.toBe(0);
    expect(duplicate.summary["report-assertion-mismatches"]).toBeGreaterThan(0);
  });

  test("When parent render timestamp, report hash, or assertion count is stale Then the receipt is rejected", () => {
    for (const mutate of [
      (content: string): string =>
        content.replace(/"rendered_at":"[^"]+"/, '"rendered_at":"2026-08-25T06:42:44Z"'),
      (content: string): string =>
        content.replace(/"report_sha256":"[a-f0-9]{64}"/, `"report_sha256":"${"0".repeat(64)}"`),
      (content: string): string => {
        const lines = content.split(/\r?\n/);
        const index = lines.findIndex((line) => line.includes('"record_type":"report_assertion"'));
        if (index < 0) throw new Error("Missing report assertion fixture record.");
        lines.splice(index, 1);
        return lines.join("\n");
      },
    ]) {
      const result = withPublicWiki((path) => {
        const file = join(path, "_ledgers", "report-render.md");
        writeFileSync(file, mutate(readFileSync(file, "utf8")));
      });
      expect(result.exitCode).not.toBe(0);
    }
  });

  test.each([
    "The evidence proves representative recovery outcomes [CLM-STATISTICS-9013].",
    "The findings indicate representative recovery results [CLM-STATISTICS-9013].",
    "Representative recovery outcomes are demonstrated by the evidence [CLM-STATISTICS-9013].",
    "The data establishes recovery likelihood [CLM-STATISTICS-9013].",
    "Shortened timelines confirm causal recovery [CLM-STATISTICS-9013].",
    "The evidence confirms product effects [CLM-STATISTICS-9013].",
    "The evidence indicates product use causes recovery [CLM-STATISTICS-9013].",
    "대표 결과를 자료가 입증한다 [CLM-STATISTICS-9013].",
    "자료가 회수 가능성을 확인한다 [CLM-STATISTICS-9013].",
    "기간 단축을 데이터가 보여준다 [CLM-STATISTICS-9013].",
    "인과 회수를 자료가 높인다 [CLM-STATISTICS-9013].",
    "제품 효과를 자료가 개선한다 [CLM-STATISTICS-9013].",
    "제품을 사용하면 회수가 개선된다는 점을 자료가 보여준다 [CLM-STATISTICS-9013].",
  ])("When report prose makes banned inference %s Then the CLI flags it", (prose) => {
    const result = withPublicWiki((path) => {
      const file = join(path, "report.md");
      writeFileSync(file, `${readFileSync(file, "utf8")}\n${prose}\n`);
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.summary["banned-report-inferences"]).toBeGreaterThan(0);
  });

  test.each([
    "The evidence does not confirm representative recovery outcomes [CLM-STATISTICS-9013].",
    "대표 결과를 자료가 입증하지 않는다 [CLM-STATISTICS-9013].",
    "제품 사용이 회수를 유발하지 않는다 [CLM-STATISTICS-9013].",
  ])("When report prose explicitly disclaims inference %s Then it remains unflagged", (prose) => {
    const result = withPublicWiki((path) => {
      const file = join(path, "report.md");
      writeFileSync(file, `${readFileSync(file, "utf8")}\n${prose}\n`);
    });
    expect(result.summary["banned-report-inferences"]).toBe(0);
  });

  test.each([
    "The report is not exhaustive but proves representative recovery outcomes [CLM-STATISTICS-9013].",
    "자료가 완전하지는 않지만 제품을 사용하면 회수가 개선된다는 점을 보여준다 [CLM-STATISTICS-9013].",
  ])(
    "When an unrelated negation accompanies a banned inference %s Then the inference remains flagged",
    (prose) => {
      const result = withPublicWiki((path) => {
        const file = join(path, "report.md");
        writeFileSync(file, `${readFileSync(file, "utf8")}\n${prose}\n`);
      });
      expect(result.summary["banned-report-inferences"]).toBeGreaterThan(0);
    },
  );

  test.each([
    "CLM-AUDIT-8762b6ac8f4ee3c7",
    "CLM-AUDIT-e5679024bb51d447",
    "CLM-AUDIT-c62418a774e4644c",
  ])("When required report assurance %s is omitted Then the named gate fails", (claimId) => {
    const result = withPublicWiki((path) => {
      const file = join(path, "report.md");
      writeFileSync(file, readFileSync(file, "utf8").replace(`[${claimId}]`, ""));
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.summary["missing-report-assurances"]).toBeGreaterThan(0);
  });

  test("When a required report assurance changes meaning Then the named gate fails", () => {
    const result = withPublicWiki((path) => {
      const file = join(path, "report.md");
      writeFileSync(
        file,
        readFileSync(file, "utf8").replace(
          "cannot support a `verified` claim.",
          "can support a `verified` claim.",
        ),
      );
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.summary["missing-report-assurances"]).toBeGreaterThan(0);
  });

  test("When a repository artifact path, hash, or excerpt changes Then the repository evidence gate rejects it", () => {
    for (const mutate of [
      (path: string): void => {
        const file = join(path, "_ledgers", "sources", "task-13-repository.md");
        writeFileSync(
          file,
          readFileSync(file, "utf8").replace(
            "wiki/_ledgers/coverage.md",
            "wiki/_ledgers/saturation.md",
          ),
        );
      },
      (path: string): void => {
        const file = join(path, "_ledgers", "sources", "task-13-repository.md");
        writeFileSync(
          file,
          readFileSync(file, "utf8").replace(
            /"content_sha256":"[a-f0-9]{64}/,
            `"content_sha256":"${"0".repeat(64)}`,
          ),
        );
      },
      (path: string): void => {
        const file = join(path, "_ledgers", "observations", "task-13-repository.md");
        writeFileSync(
          file,
          readFileSync(file, "utf8").replace("civil-answer-deadline", "civil-mutated-deadline"),
        );
      },
    ]) {
      const result = withPublicWiki(mutate);
      expect(result.exitCode).not.toBe(0);
      expect(result.summary["repository-artifact-mismatches"]).toBeGreaterThan(0);
    }
  });

  test("When P1 and P2 repository observation payloads swap Then canonical record binding rejects them", () => {
    const result = withPublicWiki((path) => {
      const file = join(path, "_ledgers", "observations", "task-13-repository.md");
      const lines = readFileSync(file, "utf8").split(/\r?\n/);
      const p1 = lines.findIndex((line) => line.includes('"repository_record_id":"SED-0001"'));
      const p2 = lines.findIndex((line) => line.includes('"repository_record_id":"SED-0002"'));
      if (p1 < 0 || p2 < 0) throw new Error("Missing P1/P2 repository observations.");
      const object = z.record(z.string(), z.unknown());
      const left = object.parse(JSON.parse(lines[p1] ?? "{}"));
      const right = object.parse(JSON.parse(lines[p2] ?? "{}"));
      lines[p1] = JSON.stringify({ ...right, id: left.id });
      lines[p2] = JSON.stringify({ ...left, id: right.id });
      writeFileSync(file, `${lines.join("\n")}\n`);
    });
    expect(result.summary["repository-audit-mismatches"]).toBeGreaterThan(0);
  });

  test("When canonical fact kind, record, fields, subject, or proposition drift Then the named audit fails", () => {
    const mutations: readonly (readonly [string, string])[] = [
      ['"fact_kind":"seed_disposition"', '"fact_kind":"coverage_cell"'],
      ['"subject_id":"P1"', '"subject_id":"P2"'],
      ['"record_id":"SED-0001"', '"record_id":"SED-0002"'],
      ['"verdict":"augment"', '"verdict":"keep"'],
      ["Repository seed disposition SED-0001", "Repository seed disposition SED-9999"],
    ];
    for (const [from, to] of mutations) {
      const result = withPublicWiki((path) => {
        const file = join(path, "_ledgers", "claims", "task-13-derived.md");
        writeFileSync(file, readFileSync(file, "utf8").replace(from, to));
      });
      expect(result.summary["repository-audit-mismatches"]).toBeGreaterThan(0);
    }
  });
});
