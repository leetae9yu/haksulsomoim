import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { parseKoreanLawCitations } from "./citation-parser";

const retrievedAt = "2026-08-11T09:30:00.000Z";
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

describe("Korean law citation parsing", () => {
  test("accepts official provenance and derives a stable identity", () => {
    const result = {
      structuredContent: {
        citations: [
          {
            source_url: "https://www.law.go.kr/법령/민법/제1조",
            law: "민법",
            version_date: "2025-01-31",
            retrieval_time: retrievedAt,
          },
        ],
      },
    };

    const citations = parseKoreanLawCitations(result, "get_law_text", digest(result), retrievedAt);

    expect(citations).toHaveLength(1);
    expect(citations[0]).toMatchObject({
      sourceUrl: "https://www.law.go.kr/법령/민법/제1조",
      law: "민법",
      versionDate: "2025-01-31",
      retrievedAt,
      toolName: "get_law_text",
    });
    expect(citations[0]?.citationId).toMatch(/^[a-f0-9]{64}$/u);
  });

  test("rejects non-official origins and unsafe provenance", () => {
    const result = {
      citations: [
        { sourceUrl: "https://law.go.kr/법령/민법", law: "민법", versionDate: "2025-01-01" },
        {
          sourceUrl: "https://www.law.go.kr.evil.example/법령/민법",
          law: "민법",
          versionDate: "2025-01-01",
        },
        {
          sourceUrl: "https://www.law.go.kr/법령/민법",
          law: "민법\nhttps://evil.example",
          versionDate: "2025-01-01",
        },
      ],
    };

    expect(
      parseKoreanLawCitations(result, "search_law", digest(result), retrievedAt),
    ).toMatchObject([{ sourceUrl: "https://law.go.kr/법령/민법", law: "민법" }]);
  });

  test("derives a citation from a text-only law response", () => {
    const result = {
      content: [{ type: "text", text: "법령명: 민사소송법\n시행일: 20250712\n제1조 목적" }],
    };

    expect(
      parseKoreanLawCitations(result, "get_law_text", digest(result), retrievedAt),
    ).toMatchObject([
      {
        sourceUrl: "https://www.law.go.kr/법령/민사소송법",
        law: "민사소송법",
        versionDate: "2025-07-12",
      },
    ]);
  });

  test("derives an official citation from the live search_law text shape", () => {
    const result = {
      content: [
        {
          type: "text",
          text: [
            "검색 결과 (총 1건):",
            "",
            "1. 민사소송법 [현행]",
            "   - 법령ID: 001700",
            "   - 공포일: 20230711 / 시행일: 20250712",
          ].join("\n"),
        },
      ],
    };

    expect(parseKoreanLawCitations(result, "search_law", digest(result), retrievedAt)).toEqual([
      expect.objectContaining({
        sourceUrl: "https://www.law.go.kr/법령/민사소송법",
        law: "민사소송법",
        versionDate: "2025-07-12",
        toolName: "search_law",
      }),
    ]);
  });
});
