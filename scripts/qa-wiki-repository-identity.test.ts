import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withPublicWiki } from "./qa-wiki-test-support.ts";

function jsonl(path: string, ledger: string): string[] {
  return readFileSync(join(path, "_ledgers", ledger), "utf8").split(/\r?\n/);
}

function auditLine(lines: readonly string[], prefix: string): string {
  const line = lines.find((item) => item.includes(prefix));
  if (line === undefined) throw new Error(`Missing ${prefix}.`);
  return line;
}

function refreshLedgerHash(path: string, ledger: string): void {
  const file = join(path, "_ledgers", "report-render.md");
  const hash = createHash("sha256")
    .update(readFileSync(join(path, "_ledgers", ledger)))
    .digest("hex");
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  const index = lines.findIndex((line) => line.includes('"record_type":"report_render"'));
  if (index < 0) throw new Error("Missing report render manifest.");
  const manifest = JSON.parse(lines[index] ?? "{}");
  manifest.ledger_sha256s[ledger] = hash;
  lines[index] = JSON.stringify(manifest);
  writeFileSync(file, `${lines.join("\n")}\n`);
}

function reverseFields(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const fields = record[key];
  if (typeof fields !== "object" || fields === null) throw new Error("Missing selected fields.");
  return { ...record, [key]: Object.fromEntries(Object.entries(fields).toReversed()) };
}

describe("Given canonical repository audit identities", () => {
  test.each(["observation", "both"])(
    "When selected fields are reordered on %s side Then semantic maps and refreshed contracts pass",
    (side) => {
      const result = withPublicWiki((path) => {
        const observationLedger = "observations/task-13-repository.md";
        const observationFile = join(path, "_ledgers", observationLedger);
        const observations = jsonl(path, observationLedger);
        const observationIndex = observations.findIndex((line) =>
          line.includes('"id":"OBS-AUDIT-'),
        );
        if (observationIndex < 0) throw new Error("Missing repository observation.");
        const observation = JSON.parse(observations[observationIndex] ?? "{}");
        observations[observationIndex] = JSON.stringify(
          reverseFields(observation, "repository_selected_fields"),
        );
        writeFileSync(observationFile, `${observations.join("\n")}\n`);
        refreshLedgerHash(path, observationLedger);
        if (side === "both") {
          const claimLedger = "claims/task-13-derived.md";
          const claimFile = join(path, "_ledgers", claimLedger);
          const claims = jsonl(path, claimLedger);
          const claimIndex = claims.findIndex((line) => line.includes('"id":"CLM-AUDIT-'));
          if (claimIndex < 0) throw new Error("Missing repository claim.");
          const claim = JSON.parse(claims[claimIndex] ?? "{}");
          claim.repository_binding = reverseFields(claim.repository_binding, "selected_fields");
          claims[claimIndex] = JSON.stringify(claim);
          writeFileSync(claimFile, `${claims.join("\n")}\n`);
          refreshLedgerHash(path, claimLedger);
        }
      });
      expect(result.exitCode).toBe(0);
      expect(result.summary["repository-audit-mismatches"]).toBe(0);
    },
  );

  test("When a selected-field key set or value changes Then canonical repository audit fails named", () => {
    const mutations: readonly (readonly [string, string])[] = [
      ['"selected_fields":{"scope_fit":"context_only"', '"selected_fields":{"scope_fit":"unknown"'],
      ['"source_quality":"secondary",', ""],
      ['"selected_fields":{', '"selected_fields":{"extra":"x",'],
      ['"seed_id":"P1"', '"seed_code":"P1"'],
    ];
    for (const [from, to] of mutations) {
      const result = withPublicWiki((path) => {
        const ledger = "claims/task-13-derived.md";
        const file = join(path, "_ledgers", ledger);
        writeFileSync(file, readFileSync(file, "utf8").replace(from, to));
        refreshLedgerHash(path, ledger);
      });
      expect(result.summary["repository-audit-mismatches"]).toBeGreaterThan(0);
    }
  });

  test("When an observation is duplicated without another claim Then reverse completeness fails named", () => {
    const result = withPublicWiki((path) => {
      const file = join(path, "_ledgers", "observations", "task-13-repository.md");
      const lines = jsonl(path, "observations/task-13-repository.md");
      const closing = lines.lastIndexOf("```");
      lines.splice(closing, 0, auditLine(lines, '"id":"OBS-AUDIT-'));
      writeFileSync(file, `${lines.join("\n")}\n`);
    });
    expect(result.summary["repository-audit-mismatches"]).toBeGreaterThan(0);
  });

  test("When a claim or confirmation is duplicated Then one-to-one audit linkage fails named", () => {
    for (const ledger of ["claims/task-13-derived.md", "verification/task-13-derived.md"]) {
      const result = withPublicWiki((path) => {
        const file = join(path, "_ledgers", ledger);
        const lines = jsonl(path, ledger);
        const closing = lines.lastIndexOf("```");
        lines.splice(
          closing,
          0,
          auditLine(
            lines,
            ledger.startsWith("claims") ? '"id":"CLM-AUDIT-' : '"claim_id":"CLM-AUDIT-',
          ),
        );
        writeFileSync(file, `${lines.join("\n")}\n`);
      });
      expect(result.summary["repository-audit-mismatches"]).toBeGreaterThan(0);
    }
  });

  test.each([
    ["seed_disposition", "coverage_cell"],
    ["coverage_cell", "seed_disposition"],
    ["seed_disposition", "seed_disposition"],
  ])("When %s and %s canonical facts swap Then identity fails named", (left, right) => {
    const result = withPublicWiki((path) => {
      const file = join(path, "_ledgers", "claims", "task-13-derived.md");
      const content = readFileSync(file, "utf8");
      const first = auditLine(content.split(/\r?\n/), `"fact_kind":"${left}"`);
      const candidates = content
        .split(/\r?\n/)
        .filter((line) => line.includes(`"fact_kind":"${right}"`));
      const second = candidates.find((line) => line !== first);
      if (second === undefined) throw new Error("Missing canonical fact pair.");
      const id = /"id":"([^"]+)"/.exec(first)?.[1];
      if (id === undefined) throw new Error("Missing canonical claim ID.");
      writeFileSync(file, content.replace(first, second.replace(/"id":"[^"]+"/, `"id":"${id}"`)));
    });
    expect(result.summary["repository-audit-mismatches"]).toBeGreaterThan(0);
  });

  test("When retired public and saturation facts are inspected Then no stale audit assertion remains", () => {
    const content = readFileSync(
      join(import.meta.dir, "..", "wiki", "_ledgers", "claims", "task-13-derived.md"),
      "utf8",
    );
    expect(content).not.toContain('"fact_kind":"public_file"');
    expect(content).not.toContain('"fact_kind":"saturation_wave"');
  });

  test("When fact tuple canonical field order or identity digest drifts Then repository identity fails named", () => {
    const mutations: readonly ((content: string) => string)[] = [
      (content) =>
        content.replace('"selected_fields":{"scope_fit"', '"selected_fields":{"verdict"'),
      (content) =>
        content.replace(
          /("identity_digest":")([a-f0-9])/,
          (_match, prefix: string, value: string) => `${prefix}${value === "0" ? "1" : "0"}`,
        ),
    ];
    for (const mutate of mutations) {
      const result = withPublicWiki((path) => {
        const file = join(path, "_ledgers", "claims", "task-13-derived.md");
        writeFileSync(file, mutate(readFileSync(file, "utf8")));
      });
      expect(result.summary["repository-audit-mismatches"]).toBeGreaterThan(0);
    }
  });
});
