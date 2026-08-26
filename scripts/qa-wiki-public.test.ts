import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { parseCorpus } from "./qa-wiki-parse.ts";

const summarySchema = z.record(z.string(), z.number().int().nonnegative());
type Result = Readonly<{ exitCode: number; summary: Readonly<Record<string, number>> }>;
type Mutation = (root: string) => void;

function run(root: string): Result {
  const output = spawnSync("bun", ["run", "qa:wiki", root], {
    cwd: `${import.meta.dir}/..`,
    encoding: "utf8",
  });
  const summary = summarySchema.parse(JSON.parse(output.stdout));
  return { exitCode: output.status ?? 1, summary };
}

function withPublic(mutator: Mutation): Result {
  const root = mkdtempSync(join(tmpdir(), "qa-wiki-render-"));
  try {
    cpSync(join(import.meta.dir, "..", "wiki"), root, { recursive: true });
    mutator(root);
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function note(root: string, name: string): string {
  return join(root, name);
}

function manifest(root: string): string {
  return join(root, "_ledgers", "public-render.md");
}

function replaceManifest(root: string, expression: RegExp, replacement: string): void {
  const path = manifest(root);
  const before = readFileSync(path, "utf8");
  const after = before.replace(expression, replacement);
  if (after === before) throw new Error(`Manifest mutation did not match ${expression.source}`);
  writeFileSync(path, after);
}

function expectRejected(mutator: Mutation, metric: string): void {
  const result = withPublic(mutator);
  expect(result.exitCode).not.toBe(0);
  expect(result.summary[metric]).toBeGreaterThan(0);
}

describe("Given the tracked public render contract", () => {
  test.each([
    "fixtures/wiki-valid",
    "fixtures/wiki-valid-derived-synthesis",
    "fixtures/wiki-valid-boundaries",
  ])("When %s is a small fixture Then structural public mode stays disabled", (path) => {
    const result = run(path);
    expect(result.exitCode).toBe(0);
    expect(result.summary["missing-public-render"]).toBe(0);
    expect(result.summary["public-render-files"]).toBe(0);
  });

  test("Then the full public corpus is structurally recognized and green", async () => {
    const corpus = await parseCorpus(join(import.meta.dir, "..", "wiki"));
    const publicFiles = corpus.records.filter(
      (record) => record.record_type === "public_file",
    ).length;
    const publicCitations = corpus.records.filter(
      (record) => record.record_type === "public_citation",
    ).length;
    const result = run("wiki");
    expect(result.exitCode).toBe(0);
    expect(result.summary["public-render-files"]).toBe(publicFiles);
    expect(result.summary["public-render-citations"]).toBe(publicCitations);
  });

  test.each([
    "README.md",
    "부록_참고통계.md",
    "전체_사례_목록.md",
    "P1_렌탈가전_속여_판_중고거래_사기.md",
    "R1_30만원_중고거래_사기.md",
  ])("When %s is missing Then public completeness fails", (name) =>
    expectRejected((root) => unlinkSync(note(root, name)), "public-render-file-mismatches"),
  );

  test("When index and appendix share an ID Then duplicate public IDs fail", () => {
    expectRejected((root) => {
      const path = note(root, "부록_참고통계.md");
      writeFileSync(
        path,
        readFileSync(path, "utf8").replace("id: APPENDIX-0001", "id: INDEX-0001"),
      );
    }, "duplicate-public-ids");
  });

  test("When two public cases share an ID Then duplicate public IDs fail", () => {
    expectRejected((root) => {
      const path = note(root, "P2_중고나라_57명_상대_반복_사기.md");
      writeFileSync(path, readFileSync(path, "utf8").replace("id: P2", "id: P1"));
    }, "duplicate-public-ids");
  });

  test("When a fake claim is appended Then claim resolution and the render contract fail", () => {
    expectRejected((root) => {
      const path = note(root, "P1_렌탈가전_속여_판_중고거래_사기.md");
      writeFileSync(path, `${readFileSync(path, "utf8")}\n[CLM-FAKE-0001]\n`);
    }, "public-render-citation-mismatches");
  });

  test("When a valid but unrelated claim is appended Then the reviewed occurrence contract fails", () => {
    expectRejected((root) => {
      const path = note(root, "P1_렌탈가전_속여_판_중고거래_사기.md");
      writeFileSync(path, `${readFileSync(path, "utf8")}\n[CLM-FRAUD-5001]\n`);
    }, "public-render-citation-mismatches");
  });

  test("When a draft qualifier is reversed Then the paragraph contract fails", () => {
    expectRejected((root) => {
      const path = note(root, "P5_편취의_범의_판단기준.md");
      writeFileSync(path, readFileSync(path, "utf8").replace("draft claim", "verified claim"));
    }, "public-render-citation-mismatches");
  });

  test("When a manifested paragraph changes Then its digest fails", () => {
    expectRejected((root) => {
      const path = note(root, "R1_30만원_중고거래_사기.md");
      writeFileSync(path, readFileSync(path, "utf8").replace("별도 입증", "추가 입증"));
    }, "public-render-citation-mismatches");
  });

  test("When a citation manifest record is missing, stale, or duplicate Then its occurrence contract fails", () => {
    for (const mutate of [
      (root: string) => replaceManifest(root, /^.*"id":"PRC-0001".*\n/m, ""),
      (root: string) =>
        replaceManifest(
          root,
          /"paragraph_sha256":"[a-f0-9]{64}"/,
          '"paragraph_sha256":"0000000000000000000000000000000000000000000000000000000000000000"',
        ),
      (root: string) => replaceManifest(root, /(^.*"id":"PRC-0001".*$)/m, "$1\n$1"),
    ])
      expectRejected(mutate, "public-render-citation-mismatches");
  });

  test("When a public file hash is missing or incorrect Then the file contract fails", () => {
    for (const mutate of [
      (root: string) => replaceManifest(root, /^.*"id":"PRF-0001".*\n/m, ""),
      (root: string) =>
        replaceManifest(
          root,
          /("id":"PRF-0001"[^\n]*"sha256":")[a-f0-9]{64}/,
          "$10000000000000000000000000000000000000000000000000000000000000000",
        ),
    ])
      expectRejected(mutate, "public-render-file-mismatches");
  });

  test("When a public number is unqualified Then the public surface remains guarded", () => {
    expectRejected((root) => {
      const path = note(root, "P1_렌탈가전_속여_판_중고거래_사기.md");
      writeFileSync(path, `${readFileSync(path, "utf8")}\n관측값은 77%다.\n`);
    }, "unqualified-numerical-claims");
  });
});
