import type {
  KoreanLawCitation,
  KoreanLawMcpAdapter,
  KoreanLawMcpResult,
  KoreanLawToolName,
} from "../integrations/korean-law-mcp/korean-law-mcp";

const LAW_RULES = [
  { law: "민법", terms: ["민법", "부당이득"] },
  { law: "민사소송법", terms: ["민사소송법", "지급명령", "송달", "판결", "확정"] },
  {
    law: "민사집행법",
    terms: ["민사집행법", "강제집행", "압류", "추심", "재산조회", "채무불이행자명부"],
  },
  { law: "형법", terms: ["형법", "사기", "고소"] },
] as const;

export type LegalQueryRoute = Readonly<{
  tool: KoreanLawToolName;
  arguments: Readonly<Record<string, unknown>>;
}>;

function explicitLawName(input: string): string | undefined {
  return LAW_RULES.find((rule) => input.includes(rule.law))?.law;
}

export function projectLegalQuery(input: string): string {
  return (
    LAW_RULES.find((rule) => rule.terms.some((term) => input.includes(term)))?.law ?? "민사소송법"
  );
}

export function routeLegalQuery(query: string): LegalQueryRoute {
  if (/(?:소장|고소장|계약서|약관|문서)\s*검토/u.test(query)) {
    return {
      tool: "legal_research",
      arguments: { task: "document_review", text: query },
    };
  }
  if (/(?:인용|조문)\s*(?:검증|확인)/u.test(query)) {
    return {
      tool: "legal_analysis",
      arguments: { mode: "verify_citations", text: query },
    };
  }

  const lawName = explicitLawName(query);
  const date = /\b(\d{4}[-.]\d{2}[-.]\d{2}|\d{8})\b/u.exec(query)?.[1]?.replaceAll(".", "-");
  if (lawName !== undefined && date !== undefined && /(?:당시|행위시법|적용\s*법령)/u.test(query)) {
    const article = /제\d+조(?:의\d+)?/u.exec(query)?.[0];
    return {
      tool: "legal_analysis",
      arguments: {
        mode: "applicable_law",
        lawName,
        date,
        ...(article === undefined ? {} : { jo: article }),
      },
    };
  }
  if (query.includes("판례")) {
    return {
      tool: "search_decisions",
      arguments: { domain: "precedent", query },
    };
  }
  if (/(?:절차|수수료|지급명령|소액사건|강제집행|재산조회|압류|추심)/u.test(query)) {
    return {
      tool: "legal_research",
      arguments: { task: "procedure_detail", query },
    };
  }
  if (lawName !== undefined) {
    return { tool: "search_law", arguments: { query: lawName } };
  }
  return {
    tool: "legal_research",
    arguments: { task: "full_research", scenario: "action_plan", query },
  };
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
  const route = routeLegalQuery(query);
  const result = await law.execute(route.tool, route.arguments);
  if (!result.ok) return lawFailure(result);
  const mst = extractLawMst(result.value.content);
  const detail =
    route.tool === "search_law" && result.value.citations.length === 0 && mst !== undefined
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
