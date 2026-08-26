import { createHash } from "node:crypto";
import { basename } from "node:path";
import { z } from "zod";
import type { MutableMetrics } from "./qa-wiki-metrics.ts";
import { increment } from "./qa-wiki-metrics.ts";
import type { ParsedCorpus } from "./qa-wiki-parse.ts";
import { checkRenderContract } from "./qa-wiki-render.ts";

const publicIndex = "전체_사례_목록.md";
const publicAppendix = "부록_참고통계.md";
const publicReadme = "README.md";
const caseNamePattern = /^([PR])([1-9]\d*)_.+\.md$/;

export function derivePublicCaseNames(files: readonly PublicFile[]): readonly string[] {
  return files
    .map((file) => basename(file.path))
    .filter((name) => caseNamePattern.test(name))
    .toSorted((left, right) => {
      const leftMatch = caseNamePattern.exec(left);
      const rightMatch = caseNamePattern.exec(right);
      if (leftMatch === null || rightMatch === null) return left.localeCompare(right);
      const kind = (leftMatch[1] ?? "").localeCompare(rightMatch[1] ?? "");
      return kind || Number(leftMatch[2]) - Number(rightMatch[2]);
    });
}

export function expectedPublicNames(files: readonly PublicFile[]): readonly string[] {
  return [...derivePublicCaseNames(files), publicIndex, publicAppendix, publicReadme];
}
const dataSchema = z.record(z.string(), z.unknown());

export type PublicFile = Readonly<{ path: string; content: string }>;
export type Citation = Readonly<{ path: string; digest: string; claimId: string }>;

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function publicData(content: string): Readonly<Record<string, unknown>> | undefined {
  const yaml = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(content)?.[1];
  if (yaml === undefined) return undefined;
  try {
    const parsed = dataSchema.safeParse(Bun.YAML.parse(yaml));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export function count<T>(values: readonly T[], key: (value: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(key(value), (counts.get(key(value)) ?? 0) + 1);
  return counts;
}

export function mismatchCounts(left: Map<string, number>, right: Map<string, number>): number {
  let mismatches = 0;
  for (const key of new Set([...left.keys(), ...right.keys()]))
    mismatches += Math.abs((left.get(key) ?? 0) - (right.get(key) ?? 0));
  return mismatches;
}

export function citations(files: readonly PublicFile[]): readonly Citation[] {
  const result: Citation[] = [];
  for (const file of files)
    for (const paragraph of file.content.replace(/^---[\s\S]*?---\r?\n/, "").split(/\r?\n\s*\r?\n/))
      for (const match of paragraph.matchAll(/\[(CLM-[A-Z]+-\d{4})\]/g)) {
        const claimId = match[1];
        if (claimId !== undefined)
          result.push({ path: basename(file.path), digest: sha256(paragraph.trim()), claimId });
      }
  return result;
}

function expectedKeys(name: string): readonly string[] {
  if (name.startsWith("P"))
    return [
      "id",
      "유형",
      "사건명",
      "법원_출처",
      "사건번호",
      "수법유형",
      "자료유형",
      "출처",
      "tags",
    ];
  if (name.startsWith("R"))
    return [
      "id",
      "유형",
      "사건명",
      "절차구분",
      "진행상태",
      "결과유형",
      "수법유형",
      "자료유형",
      "출처",
      "tags",
    ];
  return ["id", "유형", "제목", "tags"];
}

function isPublicCorpus(corpus: ParsedCorpus, files: readonly PublicFile[]): boolean {
  const caseCount = derivePublicCaseNames(files).length;
  const hasIndexOrAppendix = files.some((file) =>
    [publicIndex, publicAppendix].includes(basename(file.path)),
  );
  return (
    corpus.records.some((record) => record.record_type === "public_render") ||
    (caseCount >= 2 &&
      hasIndexOrAppendix &&
      corpus.records.some((record) => record.record_type === "seed_disposition"))
  );
}

export function checkPublicSurface(corpus: ParsedCorpus, metrics: MutableMetrics): void {
  const files = corpus.files.filter(
    (file) => !file.path.includes("/_ledgers/") && basename(file.path) !== "report.md",
  );
  if (!isPublicCorpus(corpus, files)) return;
  const byName = new Map(files.map((file) => [basename(file.path), file]));
  const publicCases = derivePublicCaseNames(files);
  const expected = expectedPublicNames(files);
  for (const name of byName.keys())
    if (!expected.includes(name)) increment(metrics, "public-render-file-mismatches");
  for (const kind of ["P", "R"])
    publicCases
      .filter((name) => name.startsWith(kind))
      .forEach((name, index) => {
        const match = caseNamePattern.exec(name);
        if (Number(match?.[2]) !== index + 1) increment(metrics, "frontmatter-keyset-mismatches");
      });
  for (const name of expected) {
    const file = byName.get(name);
    if (file === undefined) {
      increment(metrics, "public-render-file-mismatches");
      continue;
    }
    const data = publicData(file.content);
    const keys = data === undefined ? [] : Object.keys(data);
    const isReadme = name === publicReadme;
    const id = isReadme
      ? null
      : name === publicAppendix
        ? "APPENDIX-0001"
        : name === publicIndex
          ? "INDEX-0001"
          : name.split("_", 1)[0];
    if (
      !isReadme &&
      (JSON.stringify(keys) !== JSON.stringify(expectedKeys(name)) || data?.id !== id)
    )
      increment(metrics, "frontmatter-keyset-mismatches");
  }
  const ids = files.flatMap((file) => {
    const id = publicData(file.content)?.id;
    return typeof id === "string" ? [id] : [];
  });
  for (const value of count(ids, (id) => id).values())
    if (value > 1) increment(metrics, "duplicate-public-ids", value - 1);
  const claims = new Set(
    corpus.records.filter((record) => record.record_type === "claim").map((record) => record.id),
  );
  for (const citation of citations(files))
    if (!claims.has(citation.claimId)) increment(metrics, "dangling-ledger-ids");
  const index = byName.get(publicIndex)?.content ?? "";
  for (const name of publicCases) {
    const stem = basename(name, ".md");
    const lines = index.split(/\r?\n/).filter((line) => line.includes(`[[${stem}]]`));
    if (lines.length !== 1) increment(metrics, "public-render-file-mismatches");
    else if (
      !/(draft verified doctrine|verified official judgment|reported|unverified|context|withheld|unresolved)/i.test(
        lines[0] ?? "",
      )
    )
      increment(metrics, "handwritten-index-outcomes");
  }
  for (const file of files.filter((file) => basename(file.path) !== publicReadme))
    for (const paragraph of file.content
      .replace(/^---[\s\S]*?---\r?\n/, "")
      .split(/\r?\n\s*\r?\n/)) {
      const text = paragraph.replace(/\[CLM-[A-Z]+-\d{4}\]|\[\[[^\]]+\]\]/g, "");
      if (
        /\d+(?:[,.]\d+)?\s*(?:%|명|건|원|KRW)/i.test(text) &&
        !/(단위|unit).*?(모집단|population).*?(기간|period).*?(출처|source).*?(상태|status)/i.test(
          text,
        ) &&
        !/(withheld|rejected|context)/i.test(text)
      )
        increment(metrics, "unqualified-numerical-claims");
    }
  checkRenderContract(corpus, files, metrics);
}
