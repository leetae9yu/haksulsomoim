import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { parseKoreanLawCitations } from "./citation-parser";

const now = "2026-08-11T09:30:00.000Z";
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

describe("Korean law citation parsing", () => {
  test("preserves provenance and derives a stable citation identity", () => {
    const rawResult = {
      content: [{ type: "text", text: "민법 제1조: 법원" }],
      structuredContent: {
        citations: [
          {
            source_url: "https://www.law.go.kr/법령/민법/제1조",
            law: "민법",
            version_date: "2025-01-31",
            retrieval_time: now,
          },
        ],
      },
    };
    const citations = parseKoreanLawCitations(
      rawResult,
      "get_law_text",
      digest(rawResult),
      "2099-01-01T00:00:00.000Z",
    );

    expect(citations).toHaveLength(1);
    expect(citations[0]).toMatchObject({
      sourceUrl: "https://www.law.go.kr/법령/민법/제1조",
      law: "민법",
      versionDate: "2025-01-31",
      retrievedAt: now,
      toolName: "get_law_text",
      resultDigest: digest(rawResult),
    });
    expect(citations[0]?.citationId).toMatch(/^[a-f0-9]{64}$/u);
  });

  test("accepts citations only from exact official Korean-law origins", () => {
    const rawResult = {
      citations: [
        { sourceUrl: "https://www.law.go.kr/법령/민법", law: "민법", versionDate: "2025-01-01" },
        { sourceUrl: "https://law.go.kr/법령/민법", law: "민법", versionDate: "2025-01-01" },
        { sourceUrl: "http://www.law.go.kr/법령/민법", law: "민법", versionDate: "2025-01-01" },
        {
          sourceUrl: "https://www.law.go.kr.evil.example/민법",
          law: "민법",
          versionDate: "2025-01-01",
        },
        { sourceUrl: "https://user@www.law.go.kr/민법", law: "민법", versionDate: "2025-01-01" },
      ],
    };

    expect(
      parseKoreanLawCitations(rawResult, "search_law", digest(rawResult), now).map(
        (citation) => citation.sourceUrl,
      ),
    ).toEqual(["https://www.law.go.kr/법령/민법", "https://law.go.kr/법령/민법"]);
  });

  test("collapses repeated provenance to one canonical identity", () => {
    const repeated = {
      sourceUrl: "https://www.law.go.kr/법령/민법",
      law: "민법",
      versionDate: "2025-01-01",
      retrievedAt: now,
    };
    const rawResult = {
      citations: [repeated],
      structuredContent: { citations: [repeated] },
    };

    expect(parseKoreanLawCitations(rawResult, "search_law", digest(rawResult), now)).toHaveLength(
      1,
    );
  });

  test("derives an official citation from a text-only law response", () => {
    const rawResult = {
      content: [
        {
          type: "text",
          text: "법령명: 민사소송법\nMST: 252393\n시행일: 20250712\n제1조 목적",
        },
      ],
    };
    const citations = parseKoreanLawCitations(rawResult, "get_law_text", digest(rawResult), now);

    expect(citations).toHaveLength(1);
    expect(citations[0]).toMatchObject({
      sourceUrl: "https://www.law.go.kr/법령/민사소송법",
      law: "민사소송법",
      versionDate: "2025-07-12",
      retrievedAt: now,
      toolName: "get_law_text",
      resultDigest: digest(rawResult),
    });
  });
});
