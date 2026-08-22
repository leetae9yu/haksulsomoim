import { createHash } from "node:crypto";
import type { KoreanLawCitation, KoreanLawToolName } from "./korean-law-mcp";

type ObjectValue = Record<string, unknown>;

const OFFICIAL_ORIGINS = new Set(["https://law.go.kr", "https://www.law.go.kr"]);

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

function hasUnsafeMetadataCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return (
      code <= 0x1f ||
      code === 0x7f ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069)
    );
  });
}

function isSafeLawName(value: string): boolean {
  return value.length <= 1_000 && !hasUnsafeMetadataCharacter(value) && !value.includes("://");
}

function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/u.test(value);
}

function isIsoTimestamp(value: string): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function isOfficialUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return OFFICIAL_ORIGINS.has(url.origin) && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}

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

function candidates(result: ObjectValue): unknown[] {
  const values: unknown[] = [];
  if (Array.isArray(result.citations)) values.push(...result.citations);
  if (isObject(result.structuredContent) && Array.isArray(result.structuredContent.citations)) {
    values.push(...result.structuredContent.citations);
  }
  return values;
}

function textContent(result: ObjectValue): string {
  if (!Array.isArray(result.content)) return "";
  return result.content
    .filter(isObject)
    .map((item) => (typeof item.text === "string" ? item.text : ""))
    .filter((text) => text.length > 0)
    .join("\n");
}

function basicDate(value: string): string | undefined {
  const match = /^(\d{4})(\d{2})(\d{2})$/u.exec(value);
  return match === null ? undefined : `${match[1]}-${match[2]}-${match[3]}`;
}

function derivedCitation(
  result: ObjectValue,
  toolName: KoreanLawToolName,
  resultDigest: string,
  retrievedAt: string,
): KoreanLawCitation | undefined {
  if (!isIsoTimestamp(retrievedAt)) return undefined;
  const text = textContent(result);
  const law =
    toolName === "get_law_text"
      ? /^법령명:\s*(.+)$/mu.exec(text)?.[1]?.trim()
      : /^\d+\.\s*(.+?)\s*\[(?:현행|시행예정)\]$/mu.exec(text)?.[1]?.trim();
  const effectiveDate = /시행일:\s*(\d{8})/u.exec(text)?.[1];
  const versionDate = effectiveDate === undefined ? undefined : basicDate(effectiveDate);
  if (law === undefined || versionDate === undefined || !isSafeLawName(law)) return undefined;

  const sourceUrl = `https://www.law.go.kr/법령/${law}`;
  return {
    citationId: citationId(resultDigest, sourceUrl, law, versionDate, retrievedAt, toolName),
    sourceUrl,
    law,
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

  for (const candidate of candidates(result)) {
    if (!isObject(candidate)) continue;
    const sourceUrl = readString(candidate, ["sourceUrl", "source_url", "url"]);
    const law = readString(candidate, ["law", "lawName", "law_name", "title"]);
    const versionDate = readString(candidate, [
      "versionDate",
      "version_date",
      "effectiveDate",
      "effective_date",
    ]);
    const retrievedAt =
      readString(candidate, ["retrievedAt", "retrievalTime", "retrieval_time", "retrieved_at"]) ??
      fallbackRetrievalTime;
    if (
      sourceUrl === undefined ||
      law === undefined ||
      versionDate === undefined ||
      !isOfficialUrl(sourceUrl) ||
      !isSafeLawName(law) ||
      !isIsoDate(versionDate) ||
      !isIsoTimestamp(retrievedAt)
    )
      continue;

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
    const derived = derivedCitation(result, toolName, resultDigest, fallbackRetrievalTime);
    if (derived !== undefined) citations.push(derived);
  }
  return [...new Map(citations.map((citation) => [citation.citationId, citation])).values()];
}
