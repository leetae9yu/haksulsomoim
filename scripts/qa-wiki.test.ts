import { describe, expect, test } from "bun:test";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseCorpus } from "./qa-wiki-parse.ts";

import { runCorpus, runFixture, withPublicWiki } from "./qa-wiki-test-support.ts";

const hardMetrics = [
  "weak-verified",
  "legal-date-missing",
  "unsupported-derived-claims",
  "duplicate-canonical-keys",
  "dangling-links",
  "dangling-ledger-ids",
  "frontmatter-keyset-mismatches",
  "new-frontmatter-keys",
  "handwritten-index-outcomes",
  "unqualified-numerical-claims",
  "recovery-state-conflations",
  "undocumented-coverage-gaps",
  "unresolved-report-citations",
  "pii-pattern-hits",
  "overlong-excerpts",
  "malformed-inputs",
  "derived-claim-cycles",
  "excerpt-digest-mismatches",
  "missing-saturation-ledger",
  "insufficient-terminal-waves",
  "duplicate-terminal-query-manifests",
  "overlapping-terminal-queries",
  "terminal-candidate-queue",
  "terminal-material-novelty",
  "unlinked-coverage-matrix",
  "broken-saturation-chain",
  "missing-saturation-predecessors",
  "cyclic-saturation-chain",
  "forward-saturation-predecessors",
  "skipped-saturation-predecessors",
  "missing-candidate-inventory",
  "candidate-identity-count-mismatch",
  "candidate-occurrence-count-mismatch",
  "duplicate-candidate-identities",
  "duplicate-candidate-occurrence-ids",
  "orphan-candidate-occurrences",
  "double-linked-candidate-occurrences",
  "missing-candidate-occurrences",
  "missing-candidate-identities",
  "candidate-inventory-queue",
  "candidate-provenance-mismatches",
  "candidate-provenance-count-mismatch",
  "terminal-candidate-count-mismatch",
  "missing-public-render",
  "public-render-file-mismatches",
  "public-render-citation-mismatches",
  "duplicate-public-ids",
  "seed-audit-mismatches",
  "report-structure-mismatches",
  "banned-report-inferences",
  "missing-report-render",
  "report-render-mismatches",
  "report-assertion-mismatches",
  "unregistered-report-assertions",
  "repository-artifact-mismatches",
  "repository-audit-mismatches",
] as const;

type InvalidFixture = readonly [fixture: string, expected: readonly string[]];
/** @qa-literal fixture-local-input-derived: the explicit missing-root fixture has one parse failure. */
const missingRootMalformedInputs = 1;

const invalidFixtures: readonly InvalidFixture[] = [
  ["wiki-invalid/dangling-link", ["dangling-links"]],
  ["wiki-invalid/duplicate-canonical-key", ["duplicate-canonical-keys"]],
  ["wiki-invalid/weak-verified", ["weak-verified"]],
  ["wiki-invalid/legacy-key", ["frontmatter-keyset-mismatches", "new-frontmatter-keys"]],
  ["wiki-invalid/missing-legal-date", ["legal-date-missing"]],
  ["wiki-invalid/unqualified-number", ["unqualified-numerical-claims"]],
  ["wiki-invalid/recovery-state-conflation", ["recovery-state-conflations"]],
  ["wiki-invalid/raw-pii", ["pii-pattern-hits"]],
  ["wiki-invalid/overlong-excerpt", ["overlong-excerpts"]],
  ["wiki-invalid/unsupported-derived-claim", ["unsupported-derived-claims"]],
  ["wiki-invalid/undocumented-gap", ["undocumented-coverage-gaps"]],
  ["wiki-invalid/dangling-ledger-id", ["dangling-ledger-ids"]],
  ["wiki-invalid/malformed-jsonl", ["malformed-inputs"]],
  ["wiki-invalid/truncated-frontmatter", ["frontmatter-keyset-mismatches"]],
  ["wiki-invalid/derived-dangling-leaf", ["dangling-ledger-ids", "unsupported-derived-claims"]],
  ["wiki-invalid/derived-cycle", ["derived-claim-cycles", "unsupported-derived-claims"]],
  ["wiki-invalid/derived-nested-unsupported", ["unsupported-derived-claims"]],
  ["wiki-invalid/account-only-pii", ["pii-pattern-hits"]],
  ["wiki-invalid/all-claim-cycle", ["derived-claim-cycles"]],
  ["wiki-invalid/offset-timestamp", ["malformed-inputs"]],
  ["wiki-invalid/cutoff-drift", ["malformed-inputs"]],
  ["wiki-invalid/reported-non-derived-empty-support", ["malformed-inputs"]],
  ["wiki-invalid/reported-derived-empty-parent", ["malformed-inputs"]],
  ["wiki-invalid/report-missing-citation", ["unresolved-report-citations"]],
  ["wiki-invalid/report-unresolved-claim", ["unresolved-report-citations"]],
  ["wiki-invalid/report-unqualified-number", ["unqualified-numerical-claims"]],
  ["wiki-invalid/report-banned-inference", ["banned-report-inferences"]],
];

describe("Given the wiki validator CLI", () => {
  test("When no corpus argument is provided Then the default wiki corpus is validated", () => {
    const result = runCorpus();
    expect(result.exitCode).toBe(0);
    expect(result.summary["repository-audit-mismatches"]).toBe(0);
  });

  test("When an explicit corpus directory does not exist Then it fails named", () => {
    const result = runCorpus("fixtures/wiki-missing");
    expect(result.exitCode).not.toBe(0);
    expect(result.summary["malformed-inputs"]).toBe(missingRootMalformedInputs);
  });

  test("When validating the valid fixture Then it exits successfully with hard counts at zero", () => {
    const result = runFixture("wiki-valid");
    expect(result.exitCode).toBe(0);
    expect(result.summary["markdown-files"]).toBeGreaterThan(0);
    expect(result.summary["ledger-records"]).toBeGreaterThan(0);
    expect(result.summary["dangling-links"]).toBe(0);
    expect(result.summary["frontmatter-keyset-mismatches"]).toBe(0);
    expect(result.summary["pii-pattern-hits"]).toBe(0);
  });

  test("When validating a verified derived synthesis Then it inherits its verified evidence path", () => {
    const result = runFixture("wiki-valid-derived-synthesis");
    expect(result.exitCode).toBe(0);
    expect(result.summary["weak-verified"]).toBe(0);
    expect(result.summary["unsupported-derived-claims"]).toBe(0);
  });

  test("When validating explanatory schema and seed audit Markdown Then they are inert", () => {
    const result = runFixture("wiki-valid-boundaries");
    expect(result.exitCode).toBe(0);
    expect(result.summary["dangling-links"]).toBe(0);
    expect(result.summary["malformed-inputs"]).toBe(0);
  });

  test("When validating legal claim shapes Then reported, derived, and gap forms pass", () => {
    const result = runFixture("wiki-valid-claim-shapes");
    expect(result.exitCode).toBe(0);
    expect(result.summary["malformed-inputs"]).toBe(0);
    expect(result.summary["undocumented-coverage-gaps"]).toBe(0);
  });

  test("When validating nested unsupported syntheses Then every affected node is counted", async () => {
    const corpus = await parseCorpus(
      join(import.meta.dir, "..", "fixtures", "wiki-invalid", "derived-nested-unsupported"),
    );
    const expected = corpus.records.filter(
      (record) => record.record_type === "claim" && record.claim_type === "derived_synthesis",
    ).length;
    const result = runFixture("wiki-invalid/derived-nested-unsupported");
    expect(result.exitCode).not.toBe(0);
    expect(result.summary["unsupported-derived-claims"]).toBe(expected);
  });

  test("When a public note has an unresolved inline claim Then the CLI rejects it", () => {
    const result = withPublicWiki((path) => {
      const file = join(path, "P1_렌탈가전_속여_판_중고거래_사기.md");
      writeFileSync(file, `${readFileSync(file, "utf8")}\n[CLM-FAKE-0001]\n`);
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.summary["dangling-ledger-ids"]).toBeGreaterThan(0);
  });

  test("When a public note has an unqualified percentage Then the CLI rejects it", () => {
    const result = withPublicWiki((path) => {
      const file = join(path, "P1_렌탈가전_속여_판_중고거래_사기.md");
      writeFileSync(file, `${readFileSync(file, "utf8")}\n관측값은 77%다.\n`);
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.summary["unqualified-numerical-claims"]).toBeGreaterThan(0);
  });

  test("When an immutable public note and its index entry are missing Then the CLI rejects the partial render", () => {
    const result = withPublicWiki((path) => {
      unlinkSync(join(path, "P10_7년간_5,600여_명_상대_조직적_중고거래.md"));
      const index = join(path, "전체_사례_목록.md");
      writeFileSync(index, readFileSync(index, "utf8").replace(/^.*\[\[P10_.*\n/m, ""));
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.summary["public-render-file-mismatches"]).toBeGreaterThan(0);
  });

  test.each(invalidFixtures)("When validating %s Then only %p are nonzero", (fixture, expected) => {
    const result = runFixture(fixture);
    expect(result.exitCode).not.toBe(0);
    for (const metric of hardMetrics) {
      if (expected.includes(metric)) expect(result.summary[metric]).toBeGreaterThan(0);
      else expect(result.summary[metric]).toBe(0);
    }
  });
});
