import { describe, expect, test } from "bun:test";
import { type LegalQueryRoute, routeLegalQuery } from "./legal-guidance";

describe("Korean-law direct query routing", () => {
  test.each([
    [
      "소액사건 지급명령 절차와 수수료",
      {
        tool: "legal_research",
        arguments: { task: "procedure_detail", query: "소액사건 지급명령 절차와 수수료" },
      },
    ],
    [
      "소장 검토: 피고는 민법 제750조에 따라 반환한다",
      {
        tool: "legal_research",
        arguments: {
          task: "document_review",
          text: "소장 검토: 피고는 민법 제750조에 따라 반환한다",
        },
      },
    ],
    [
      "민법 제750조 인용 검증",
      {
        tool: "legal_analysis",
        arguments: { mode: "verify_citations", text: "민법 제750조 인용 검증" },
      },
    ],
    [
      "2023-05-10 당시 민법 제750조 적용 법령",
      {
        tool: "legal_analysis",
        arguments: {
          mode: "applicable_law",
          lawName: "민법",
          date: "2023-05-10",
          jo: "제750조",
        },
      },
    ],
    [
      "계좌이체 사기 손해배상 판례",
      {
        tool: "search_decisions",
        arguments: { domain: "precedent", query: "계좌이체 사기 손해배상 판례" },
      },
    ],
    ["민법 제750조", { tool: "search_law", arguments: { query: "민법" } }],
  ] satisfies ReadonlyArray<readonly [string, LegalQueryRoute]>)(
    "routes %s to a machine-consumable MCP call",
    (query, expected) => {
      expect(routeLegalQuery(query)).toEqual(expected);
    },
  );

  test("routes an unclassified fraud question through full legal research", () => {
    expect(routeLegalQuery("계좌이체 사기를 당했는데 돈을 돌려받으려면?")).toEqual({
      tool: "legal_research",
      arguments: {
        task: "full_research",
        scenario: "action_plan",
        query: "계좌이체 사기를 당했는데 돈을 돌려받으려면?",
      },
    });
  });
});
