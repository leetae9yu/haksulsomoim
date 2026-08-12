const LAW_RULES = [
  { law: "민법", terms: ["민법", "부당이득"] },
  { law: "민사소송법", terms: ["민사소송법", "지급명령", "송달", "판결", "확정"] },
  {
    law: "민사집행법",
    terms: ["민사집행법", "강제집행", "압류", "추심", "재산조회", "채무불이행자명부"],
  },
  { law: "형법", terms: ["형법", "사기", "고소"] },
] as const;

export function projectLegalQuery(input: string): string {
  for (const rule of LAW_RULES) {
    if (rule.terms.some((term) => input.includes(term))) return rule.law;
  }
  return "민사소송법";
}

export function extractLawMst(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  for (const item of content) {
    if (typeof item !== "object" || item === null || !("text" in item)) continue;
    if (typeof item.text !== "string") continue;
    const mst = /(?:MST|mst)\s*:\s*"?(\d{1,20})"?/u.exec(item.text)?.[1];
    if (mst !== undefined) return mst;
  }
  return undefined;
}

export type LegalGuidanceLookup =
  | Readonly<{ status: "needs-credentials" }>
  | Readonly<{ status: "error"; message: string }>
  | Readonly<{
      status: "ok";
      content: unknown;
      citations: readonly KoreanLawCitation[];
    }>;

export async function lookupLegalGuidance(
  law: KoreanLawMcpAdapter,
  query: string,
): Promise<LegalGuidanceLookup> {
  const result = await law.execute("search_law", { query: projectLegalQuery(query) });
  if (!result.ok) return lawFailure(result);
  const mst = extractLawMst(result.value.content);
  const detail =
    result.value.citations.length === 0 && mst !== undefined
      ? await law.execute("get_law_text", { mst })
      : undefined;
  const citations =
    detail?.ok === true && detail.value.citations.length > 0
      ? detail.value.citations
      : result.value.citations;
  return { status: "ok", content: result.value.content, citations };
}

function lawFailure(result: Extract<KoreanLawMcpResult, { ok: false }>): LegalGuidanceLookup {
  if (result.error.code === "needs_credentials") return { status: "needs-credentials" };
  return {
    status: "error",
    message: result.error.code === "execution_failed" ? result.error.message : result.error.code,
  };
}

import type {
  KoreanLawCitation,
  KoreanLawMcpAdapter,
  KoreanLawMcpResult,
} from "../integrations/korean-law-mcp/korean-law-mcp";
