import { createHash } from "node:crypto";
import { basename } from "node:path";
import { z } from "zod";
import type { MutableMetrics } from "./qa-wiki-metrics.ts";
import { increment } from "./qa-wiki-metrics.ts";
import type { ParsedCorpus } from "./qa-wiki-parse.ts";
import { checkRenderContract } from "./qa-wiki-render.ts";

const publicP = [
  "P1_렌탈가전_속여_판_중고거래_사기.md",
  "P2_중고나라_57명_상대_반복_사기.md",
  "P3_반복된_중고거래_사기.md",
  "P4_재정난_속_거래_지속.md",
  "P5_편취의_범의_판단기준.md",
  "P6_부작위에_의한_기망행위.md",
  "P7_부작위에_의한_기망의_의미.md",
  "P8_대가_일부_지급된_경우의_편취액_산정.md",
  "P9_중고거래_허위매물_2억원_편취.md",
  "P10_7년간_5,600여_명_상대_조직적_중고거래.md",
] as const;
const publicR = [
  "R1_30만원_중고거래_사기.md",
  "R2_배상명령_각하_이후_민사소송으로_전환한_사례.md",
  "R3_다수_공범_중고거래_사기.md",
  "R4_조직적_중고거래_사기_피해.md",
  "R5_더치트_신고_후_6개월_만에_검거.md",
  "R6_가짜_이체확인증_사기.md",
  "R7_조직적_사기_관련.md",
  "R8_반복된_발송_지연.md",
  "R9_검거_후_배상_약속_불이행.md",
  "R10_에스크로_안전결제_도입.md",
] as const;
const publicIndex = "전체_사례_목록.md";
const publicAppendix = "부록_참고통계.md";
const publicReadme = "README.md";
export const expected = [...publicP, ...publicR, publicIndex, publicAppendix, publicReadme];
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
  const caseCount = files.filter((file) =>
    /^(?:P|R)(?:10|[1-9])_/.test(basename(file.path)),
  ).length;
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
  for (const name of byName.keys())
    if (!expected.includes(name)) increment(metrics, "public-render-file-mismatches");
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
  for (const name of [...publicP, ...publicR]) {
    const stem = basename(name, ".md");
    const lines = index.split(/\r?\n/).filter((line) => line.includes(`[[${stem}]]`));
    if (lines.length !== 1) increment(metrics, "public-render-file-mismatches");
    else if (
      !/(draft verified doctrine|reported|unverified|context|withheld|unresolved)/i.test(
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
