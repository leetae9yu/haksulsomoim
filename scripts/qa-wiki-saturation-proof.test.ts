import { describe, expect, test } from "bun:test";
import {
  saturationDigest,
  terminalQueryIdentity,
  terminalResultReceipt,
} from "./qa-wiki-saturation-proof.ts";
import { mutateSaturation, runTask10Corpus } from "./qa-wiki-saturation-support.ts";

type JsonRecord = Record<string, unknown>;

type Mapping = Record<string, unknown>;

/** @qa-literal immutable-contract */
const requiredTerminalWaves = 2;
/** @qa-literal immutable-contract */
const requiredTerminalCellQueries = 214;
/** @qa-literal fixture-local-input-derived */
const successfulFixtureStatus = 200;
/** @qa-literal fixture-local-input-derived */
const emptyFixtureCount = 0;
/** @qa-literal generic-threshold */
const positiveQueueMutation = 1;

function terminalRecords(records: readonly JsonRecord[]): JsonRecord[] {
  return records.filter((record) => record.status === "saturated").slice(-2);
}

function mappings(record: JsonRecord): Mapping[] {
  return record.cell_query_mappings as Mapping[];
}

function mutateFinalMappings(
  transform: (items: Mapping[]) => Mapping[],
): (records: readonly JsonRecord[]) => readonly JsonRecord[] {
  return (records) => {
    const terminals = terminalRecords(records);
    const final = terminals.at(-1);
    if (final === undefined) throw new Error("Missing terminal saturation wave.");
    return records.map((record) =>
      record.id === final.id
        ? { ...record, cell_query_mappings: transform(mappings(record)) }
        : record,
    );
  };
}

function mutateFirstMapping(transform: (item: Mapping) => Mapping) {
  return mutateFinalMappings((items) => {
    const first = items[0];
    if (first === undefined) throw new Error("Missing cell query mapping.");
    return [transform(first), ...items.slice(1)];
  });
}

describe("Given the Task 14A cell-level saturation proof", () => {
  test("When validating the corpus Then two complete disjoint 107-cell waves are bound", () => {
    const result = runTask10Corpus();
    expect(result.exitCode).toBe(0);
    expect(result.summary["terminal-zero-novelty-waves"]).toBe(requiredTerminalWaves);
    expect(result.summary["cell-adequate-terminal-waves"]).toBe(requiredTerminalWaves);
    expect(result.summary["terminal-query-replays"]).toBe(requiredTerminalCellQueries);
    expect(result.summary["terminal-receipted-cell-queries"]).toBe(requiredTerminalCellQueries);
    expect(result.summary["documented-incomplete-saturation"]).toBe(0);
  });

  test("When a query declares another cell proposition Then semantic binding fails", () => {
    const result = runTask10Corpus((root) =>
      mutateSaturation(
        root,
        mutateFinalMappings((items) => {
          const first = items[0];
          const second = items[1];
          if (first === undefined || second === undefined) throw new Error("Missing mappings.");
          return [{ ...first, target_proposition: second.target_proposition }, ...items.slice(1)];
        }),
      ),
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.summary["unrelated-terminal-query-mappings"]).toBeGreaterThan(0);
  });

  test("When semantic terms do not occur in the proposition Then semantic binding fails", () => {
    const result = runTask10Corpus((root) =>
      mutateSaturation(
        root,
        mutateFirstMapping((item) => ({ ...item, semantic_terms: ["무관한용어", "별개주제"] })),
      ),
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.summary["unrelated-terminal-query-mappings"]).toBeGreaterThan(0);
  });

  test("When a response receipt digest is forged Then receipt integrity fails", () => {
    const result = runTask10Corpus((root) =>
      mutateSaturation(
        root,
        mutateFirstMapping((item) => ({ ...item, result_receipt_sha256: "f".repeat(64) })),
      ),
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.summary["invalid-terminal-query-receipts"]).toBeGreaterThan(0);
  });

  test("When a successful response is relabeled an access gap after receipt refresh Then receipt validation fails", () => {
    const result = runTask10Corpus((root) =>
      mutateSaturation(
        root,
        mutateFirstMapping((item) => {
          const forged = {
            ...item,
            access_state: "access_gap",
            access_error: null,
            response_status: successfulFixtureStatus,
          };
          return {
            ...forged,
            result_receipt_sha256: saturationDigest(terminalResultReceipt(forged as never)),
          };
        }),
      ),
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.summary["invalid-terminal-query-receipts"]).toBeGreaterThan(0);
  });

  test("When response chronology predates the request Then chronology fails", () => {
    const result = runTask10Corpus((root) =>
      mutateSaturation(
        root,
        mutateFirstMapping((item) => ({
          ...item,
          response_received_at: "2026-08-25T06:42:45Z",
        })),
      ),
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.summary["invalid-terminal-query-chronology"]).toBeGreaterThan(0);
  });

  test("When a cell adjudication is generic Then adjudication fails", () => {
    const result = runTask10Corpus((root) =>
      mutateSaturation(
        root,
        mutateFirstMapping((item) => ({ ...item, adjudication: "No novelty was found." })),
      ),
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.summary["generic-terminal-query-adjudications"]).toBeGreaterThan(0);
  });

  test("When a receipt drops an actual result occurrence Then occurrence binding fails", () => {
    const result = runTask10Corpus((root) =>
      mutateSaturation(root, (records) =>
        records.map((record) => {
          if (record.id !== "SAT-1004") return record;
          const index = mappings(record).findIndex((item) => Number(item.result_count) > 0);
          if (index < 0) throw new Error("Missing positive result receipt.");
          return {
            ...record,
            cell_query_mappings: mappings(record).map((item, current) =>
              current === index
                ? {
                    ...item,
                    result_count: emptyFixtureCount,
                    result_occurrence_ids: [],
                    candidate_queue_before_review: emptyFixtureCount,
                  }
                : item,
            ),
          };
        }),
      ),
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.summary["unbound-terminal-result-occurrences"]).toBeGreaterThan(0);
  });

  test("When decorative query text changes Then the operational identity remains valid", () => {
    const result = runTask10Corpus((root) =>
      mutateSaturation(
        root,
        mutateFirstMapping((item) => ({ ...item, query_text: `${item.query_text} 재확인` })),
      ),
    );
    expect(result.summary["inadequate-terminal-query-mappings"]).toBe(0);
    expect(result.summary["unrelated-terminal-query-mappings"]).toBe(0);
    expect(result.summary["overlapping-terminal-queries"]).toBe(0);
  });

  test("When terminal operations overlap despite different query text Then disjointness fails", () => {
    const result = runTask10Corpus((root) =>
      mutateSaturation(root, (records) => {
        const terminals = terminalRecords(records);
        const first = terminals[0];
        const second = terminals[1];
        if (first === undefined || second === undefined) throw new Error("Missing waves.");
        const firstMapping = mappings(first)[0];
        if (firstMapping === undefined) throw new Error("Missing first mapping.");
        return records.map((record) => {
          if (record.id !== second.id) return record;
          const secondMappings = mappings(record).map((item, index) => {
            if (index !== 0) return item;
            const forged = {
              ...item,
              request_method: firstMapping.request_method,
              request_url: firstMapping.request_url,
              request_body: firstMapping.request_body,
              response_parser: firstMapping.response_parser,
              semantic_terms: firstMapping.semantic_terms,
            };
            return {
              ...forged,
              query_identity_sha256: saturationDigest(terminalQueryIdentity(forged as never)),
            };
          });
          const identities = secondMappings.map((item) => item.query_identity_sha256 as string);
          return {
            ...record,
            query_identity_sha256s: identities,
            query_manifest_sha256: saturationDigest(identities),
            cell_query_mappings: secondMappings,
          };
        });
      }),
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.summary["overlapping-terminal-queries"]).toBeGreaterThan(0);
  });

  test("When a wave claims saturation with a nonzero queue Then false saturation fails", () => {
    const result = runTask10Corpus((root) =>
      mutateSaturation(root, (records) => {
        const final = terminalRecords(records).at(-1);
        if (final === undefined) throw new Error("Missing terminal wave.");
        return records.map((record) =>
          record.id === final.id
            ? { ...record, candidate_queue_count: positiveQueueMutation }
            : record,
        );
      }),
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.summary["terminal-candidate-queue"]).toBeGreaterThan(0);
  });
});
