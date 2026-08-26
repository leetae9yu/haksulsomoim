import { describe, expect, test } from "bun:test";
import { auditSources } from "./qa-wiki-literal-audit.ts";

function unknown(source: string, file = "fixture.test.ts"): boolean {
  return auditSources({ [file]: source }).unknown.length > 0;
}

describe("Given the Wiki numeric expectation auditor", () => {
  test.each([
    "expect(result.summary.count).toBe(47);",
    "const expected = 47; expect(result.summary.count).toBe(expected);",
    "function expectedCount() { return 47; } expect(result.summary.count).toBe(expectedCount());",
    "const expected = { count: 47 }; expect(result.summary).toEqual(expected);",
    "expect(result.summary.count).toBe(\n47,\n);",
    "expect(result.summary.count).toBe(40 + 7);",
    "const expected = 50 - 3; expect(result.summary.count).toBe(expected);",
    "function expectedCount() { return 94 / 2; } expect(result.summary.count).toBe(expectedCount());",
    "const expected = { count: ((40) + (7)) }; expect(result.summary).toEqual(expected);",
    'expect(result.summary.count).toBe(Number("47"));',
    'const expected = parseInt("47"); expect(result.summary.count).toBe(expected);',
    'function expectedCount() { return parseFloat("47"); } expect(result.summary.count).toBe(expectedCount());',
    'const expected = +"47"; expect(result.summary.count).toBe(expected);',
    'const value = "47"; function expectedCount() { return Number(value); } expect(result.summary.count).toBe(expectedCount());',
    "const expected = { count: Number(`47`) }; expect(result.summary).toEqual(expected);",
    'expect(result.summary.count).toBe(\nNumber("47"),\n);',
  ])("When an unannotated numeric expectation uses %s Then it is rejected", (source) => {
    expect(unknown(source)).toBe(true);
  });

  test("When the auditor source shape contains an unannotated expectation Then it is rejected", () => {
    expect(
      unknown(
        "const expected = 47; expect(result.summary.count).toBe(expected);",
        "qa-wiki-literal-audit.ts",
      ),
    ).toBe(true);
  });

  test("When an expectation derives from parsed records Then it is allowed", () => {
    expect(
      unknown(
        "const expected = corpus.records.filter((record) => record.record_type === 'coverage').length; expect(result.summary.count).toBe(expected);",
      ),
    ).toBe(false);
  });

  test("When a list mutation uses structural offsets Then it is allowed", () => {
    expect(unknown("const entries = []; entries.splice(0, 0, value);")).toBe(false);
  });

  test("When immutable and fixture-local inputs are explicitly annotated Then they are allowed", () => {
    for (const source of [
      "/** @qa-literal immutable-contract */ const frozenSeedCount = 21; expect(result.summary.count).toBe(frozenSeedCount);",
      "/** @qa-literal fixture-local-input-derived */ const fixtureCount = 47; expect(result.summary.count).toBe(fixtureCount);",
    ])
      expect(unknown(source)).toBe(false);
  });
});
