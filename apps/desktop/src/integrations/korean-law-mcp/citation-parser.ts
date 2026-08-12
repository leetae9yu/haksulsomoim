import { createHash } from "node:crypto";
import type { KoreanLawCitation, KoreanLawToolName } from "./korean-law-mcp";

type ObjectValue = Record<string, unknown>;

function isObject(value: unknown): value is ObjectValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(object: ObjectValue, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = object[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return undefined;
}

const OFFICIAL_KOREAN_LAW_ORIGINS = new Set(["https://law.go.kr", "https://www.law.go.kr"]);

function citationId(
  resultDigest: string,
  sourceUrl: string,
  law: string,
  versionDate: string,
  retrievedAt: string,
  toolName: KoreanLawToolName,
): string {
  return createHash("sha256")
    .update([resultDigest, sourceUrl, law, versionDate, retrievedAt, toolName].join("\0"))
    .digest("hex");
}

function isOfficialCitationUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      OFFICIAL_KOREAN_LAW_ORIGINS.has(url.origin) && url.username === "" && url.password === ""
    );
  } catch {
    return false;
  }
}

function citationCandidates(result: ObjectValue): unknown[] {
  const candidates: unknown[] = [];
  if (Array.isArray(result.citations)) candidates.push(...result.citations);
  if (isObject(result.structuredContent) && Array.isArray(result.structuredContent.citations)) {
    candidates.push(...result.structuredContent.citations);
  }
  return candidates;
}

function formatBasicDate(value: string): string | undefined {
  const match = /^(\d{4})(\d{2})(\d{2})$/u.exec(value);
  return match === null ? undefined : `${match[1]}-${match[2]}-${match[3]}`;
}

function textContent(result: ObjectValue): string {
  if (!Array.isArray(result.content)) return "";
  return result.content
    .filter(isObject)
    .map((item) => (typeof item.text === "string" ? item.text : ""))
    .filter((text) => text.length > 0)
    .join("\n");
}

function deriveOfficialLawCitation(
  result: ObjectValue,
  toolName: KoreanLawToolName,
  resultDigest: string,
  retrievedAt: string,
): KoreanLawCitation | undefined {
  if (toolName !== "get_law_text") return undefined;
  const text = textContent(result);
  const lawName = /^법령명:\s*(.+)$/mu.exec(text)?.[1]?.trim();
  const effectiveDate = /^시행일:\s*(\d{8})$/mu.exec(text)?.[1];
  const versionDate = effectiveDate === undefined ? undefined : formatBasicDate(effectiveDate);
  if (lawName === undefined || lawName.length === 0) return undefined;
  if (versionDate === undefined) return undefined;
  const sourceUrl = `https://www.law.go.kr/법령/${lawName}`;

  return {
    citationId: citationId(resultDigest, sourceUrl, lawName, versionDate, retrievedAt, toolName),
    sourceUrl,
    law: lawName,
    versionDate,
    retrievedAt,
    toolName,
    resultDigest,
  };
}

export function parseKoreanLawCitations(
  result: ObjectValue,
  toolName: KoreanLawToolName,
  resultDigest: string,
  fallbackRetrievalTime: string,
): KoreanLawCitation[] {
  const citations: KoreanLawCitation[] = [];

  for (const candidate of citationCandidates(result)) {
    if (!isObject(candidate)) continue;
    const sourceUrl = readString(candidate, ["sourceUrl", "source_url", "url"]);
    const law = readString(candidate, ["law", "lawName", "law_name", "title"]);
    const versionDate = readString(candidate, [
      "versionDate",
      "version_date",
      "effectiveDate",
      "effective_date",
    ]);
    if (
      sourceUrl === undefined ||
      !isOfficialCitationUrl(sourceUrl) ||
      law === undefined ||
      versionDate === undefined
    )
      continue;

    const retrievedAt =
      readString(candidate, ["retrievedAt", "retrievalTime", "retrieval_time", "retrieved_at"]) ??
      fallbackRetrievalTime;
    citations.push({
      citationId: citationId(resultDigest, sourceUrl, law, versionDate, retrievedAt, toolName),
      sourceUrl,
      law,
      versionDate,
      retrievedAt,
      toolName,
      resultDigest,
    });
  }

  if (citations.length === 0) {
    const derived = deriveOfficialLawCitation(
      result,
      toolName,
      resultDigest,
      fallbackRetrievalTime,
    );
    if (derived !== undefined) citations.push(derived);
  }
  return [...new Map(citations.map((citation) => [citation.citationId, citation])).values()];
}
