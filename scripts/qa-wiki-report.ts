import { basename } from "node:path";
import { frozenResearchCutoff } from "./qa-wiki-contract.ts";
import type { MutableMetrics } from "./qa-wiki-metrics.ts";
import { increment } from "./qa-wiki-metrics.ts";
import type { ParsedCorpus } from "./qa-wiki-parse.ts";

const requiredReportAssurances = [
  "CLM-AUDIT-8762b6ac8f4ee3c7",
  "CLM-AUDIT-e5679024bb51d447",
  "CLM-AUDIT-c62418a774e4644c",
] as const;

const requiredSections = [
  /(?:요약|결론|executive\s+conclusion)/i,
  /(?:시드.*(?:감사|audit)|seed\s+audit)/i,
  /(?:(?:방법론|methodology).*(?:기준일|cutoff)|(?:기준일|cutoff).*(?:방법론|methodology))/i,
  /(?:출처.*(?:위계|계층)|source\s+hierarchy)/i,
  /(?:(?:coverage|커버리지|범위).*(?:lane|차선|결과)|(?:lane|차선).*(?:coverage|커버리지|범위))/i,
  /(?:시드.*(?:처분|disposition)|seed\s+disposition)/i,
  /(?:법률.*절차|legal.*procedural)/i,
  /(?:(?:사례.*통계|case.*statistic)|(?:통계.*한계|statistics.*limit))/i,
  /(?:wiki.*ledger|위키.*레저)/i,
  /(?:(?:충돌.*포화|conflict.*saturation)|(?:포화.*충돌|saturation.*conflict))/i,
  /(?:공백|gap)/i,
  /(?:(?:저작권.*개인정보|copyright.*privacy)|(?:개인정보.*저작권|privacy.*copyright))/i,
  /(?:(?:권고.*llm|recommendation.*llm)|(?:llm.*권고|llm.*recommendation))/i,
] as const;

function paragraphs(content: string): readonly string[] {
  return content
    .replace(/```[\s\S]*?```/g, "")
    .split(/\r?\n\s*\r?\n/)
    .map((value) => value.trim())
    .filter((value) => value.length > 0 && !value.startsWith("#"));
}

function hasQualifiedNumber(value: string): boolean {
  if (!/\d+(?:[.,]\d+)?\s*(?:%|명|건|원|KRW)/i.test(value)) return true;
  return (
    /(unit|단위)/i.test(value) &&
    /(population|모집단|대상)/i.test(value) &&
    /(period|기간)/i.test(value) &&
    /(metric|지표)/i.test(value) &&
    /(qualified|한정)/i.test(value)
  );
}

const inferenceVerbs =
  /(?:proves?|confirms?|indicates?|demonstrates?|establishes?|shows?|causes?)/i;
const inferenceTargets =
  /(?:representative\s+(?:recovery\s+)?(?:outcomes?|results?)|recovery likelihood|short(?:er|ened) timelines?|causal recovery|product effects?)/i;
const koreanInferenceVerbs = /(?:입증|확인|보여|개선|높|유발)/;
const koreanInferenceTargets =
  /(?:대표(?:적(?:인)?)?\s*결과|회수\s*가능성|기간\s*단축|제품\s*효과|인과(?:적)?\s*회수)/;

function withoutDirectDisclaimers(sentence: string): string {
  return sentence
    .replace(
      /(?:does not|doesn't)\s+(?:prove|confirm|indicate|demonstrate|establish|show|cause)\w*/gi,
      "",
    )
    .replace(
      /(?:is|was)\s+not\s+(?:proven|confirmed|indicated|demonstrated|established|shown|caused)/gi,
      "",
    )
    .replace(
      /(?:입증|확인|보여|개선|높|유발)(?:하지|되지)\s*(?:않(?:는다|다|음)?|못(?:해|한다|함)?)/g,
      "",
    )
    .replace(
      /(?:대표(?:적(?:인)?)?\s*결과|회수\s*가능성|기간\s*단축|제품\s*효과|인과(?:적)?\s*회수).{0,100}(?:입증|확인|보여|개선|높임|유발)하는.{0,100}아니다/g,
      "",
    );
}

function hasBannedInference(value: string): boolean {
  return value.split(/[.!?。]+/).some((sentence) => {
    const normalized = withoutDirectDisclaimers(sentence);
    const englishTargetThenVerb = new RegExp(
      `${inferenceTargets.source}.{0,100}${inferenceVerbs.source}`,
      "i",
    );
    const englishVerbThenTarget = new RegExp(
      `${inferenceVerbs.source}.{0,100}${inferenceTargets.source}`,
      "i",
    );
    const koreanTargetThenVerb = new RegExp(
      `${koreanInferenceTargets.source}.{0,100}${koreanInferenceVerbs.source}`,
    );
    const koreanVerbThenTarget = new RegExp(
      `${koreanInferenceVerbs.source}.{0,100}${koreanInferenceTargets.source}`,
    );
    return [
      englishTargetThenVerb,
      englishVerbThenTarget,
      /(?:product use|제품(?:을|의)?\s*(?:사용|이용)).{0,60}(?:(?:causes?|유발|개선|높).{0,60}(?:recovery|회수|회복)|(?:recovery|회수|회복).{0,60}(?:causes?|유발|개선|높))/i,
      koreanTargetThenVerb,
      koreanVerbThenTarget,
    ].some((pattern) => pattern.test(normalized));
  });
}

export function checkReport(corpus: ParsedCorpus, metrics: MutableMetrics): void {
  const reports = corpus.files.filter(
    (file) => basename(file.path) === "report.md" && !file.path.includes("/_ledgers/"),
  );
  const structuralMode =
    corpus.records.some((record) => record.record_type === "seed_disposition") &&
    corpus.records.some(
      (record) => record.record_type === "public_render" || record.record_type === "report_render",
    );
  if (reports.length === 0) {
    if (structuralMode) increment(metrics, "report-structure-mismatches");
    return;
  }
  if (reports.length !== 1) {
    increment(metrics, "report-structure-mismatches", reports.length);
    return;
  }
  const report = reports[0];
  if (report === undefined) return;
  const isResearchReport =
    corpus.records.some((record) => record.record_type === "seed_disposition") ||
    requiredSections.some((section) => section.test(report.content));
  if (!isResearchReport) return;
  if (!report.content.includes(frozenResearchCutoff))
    increment(metrics, "report-structure-mismatches");
  for (const section of requiredSections)
    if (!section.test(report.content)) increment(metrics, "report-structure-mismatches");
  const claimIds = new Set(
    corpus.records.filter((record) => record.record_type === "claim").map((record) => record.id),
  );
  const claims = new Map(
    corpus.records
      .filter((record) => record.record_type === "claim")
      .map((record) => [record.id, record]),
  );
  const reportBlocks = paragraphs(report.content);
  for (const assuranceId of requiredReportAssurances) {
    const assurance = claims.get(assuranceId);
    const matchingBlock = reportBlocks.find((block) => block.includes(`[${assuranceId}]`));
    if (
      assurance === undefined ||
      assurance.claim_type !== "repository_audit" ||
      matchingBlock === undefined ||
      !matchingBlock
        .replace(/\s*\[CLM-(?:[A-Z]+-\d{4}|AUDIT-[a-f0-9]{16})\]/g, "")
        .includes(assurance.statement)
    )
      increment(metrics, "missing-report-assurances");
  }
  for (const paragraph of reportBlocks) {
    const citations = [...paragraph.matchAll(/\[(CLM-(?:[A-Z]+-\d{4}|AUDIT-[a-f0-9]{16}))\]/g)].map(
      (match) => match[1],
    );
    if (
      citations.length === 0 ||
      citations.some((citation) => citation === undefined || !claimIds.has(citation))
    )
      increment(metrics, "unresolved-report-citations");
    if (!hasQualifiedNumber(paragraph)) increment(metrics, "unqualified-numerical-claims");
    if (hasBannedInference(paragraph)) increment(metrics, "banned-report-inferences");
  }
}
