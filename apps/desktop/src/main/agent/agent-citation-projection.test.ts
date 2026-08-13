import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectAgentCitations } from "./agent-citation-projection";
import type { AgentCitationProvenance, AgentRun } from "./agent-contracts";
import { agentRunSchema } from "./agent-contracts";
import { AgentRunRepository } from "./agent-run-repository";

const digest = "d".repeat(64);
function citation(id: string, law: string): AgentCitationProvenance {
  return {
    citationId: id,
    sourceUrl: `https://law.go.kr/법령/${law}`,
    law,
    versionDate: "2026-01-01",
    retrievedAt: "2026-08-13T00:00:00.000Z",
    toolName: "search_law",
    resultDigest: digest,
  } as AgentCitationProvenance;
}
function run(
  entries: readonly Readonly<{
    stepId: string;
    toolName?: "search-official-law" | "inspect-masked-case";
    citations: readonly AgentCitationProvenance[];
  }>[],
  runId = "run-1",
): AgentRun {
  return {
    runId,
    caseId: "case-1",
    goal: { kind: "civil-recovery", caseId: "case-1", objective: "prepare-civil-demand" },
    budget: { decisionsRemaining: 1, toolsRemaining: 1, durationMsRemaining: 1 },
    state: { kind: "active" },
    steps: entries.map((entry, index) => ({
      kind: "tool-finished",
      stepId: entry.stepId,
      result: {
        toolName: entry.toolName ?? "search-official-law",
        toolCallId: `call-${index}`,
        outcome: "completed",
        observationDigest: String(index).padStart(64, "a"),
        citationIds: entry.citations.map((item) => item.citationId),
        citations: entry.citations,
      },
    })),
  } as unknown as AgentRun;
}

describe("causal Agent citation projection", () => {
  test("keeps disjoint law observations ordered and ignores no-citation tools", () => {
    const source = run([
      { stepId: "law-first", citations: [citation("first", "민법")] },
      { stepId: "inspection", toolName: "inspect-masked-case", citations: [] },
      { stepId: "law-second", citations: [citation("second", "민사소송법")] },
      { stepId: "latest-empty-law", citations: [] },
    ]);

    expect(projectAgentCitations(source)).toEqual([
      expect.objectContaining({ citationId: "first", stepId: "law-first" }),
      expect.objectContaining({ citationId: "second", stepId: "law-second" }),
    ]);
    const reordered = run([
      { stepId: "law-second", citations: [citation("second", "민사소송법")] },
      { stepId: "law-first", citations: [citation("first", "민법")] },
    ]);
    expect(projectAgentCitations(reordered).map((item) => String(item.stepId))).toEqual([
      "law-second",
      "law-first",
    ]);
  });

  test("dedupes only identical provenance and preserves conflicting duplicate IDs", () => {
    const repeated = citation("duplicate", "민법");
    const projected = projectAgentCitations(
      run([
        { stepId: "same-first", citations: [repeated] },
        { stepId: "same-again", citations: [repeated] },
        { stepId: "distinct", citations: [citation("duplicate", "형법")] },
      ]),
    );

    expect(projected).toHaveLength(2);
    expect(new Set(projected.map((item) => item.citationId)).size).toBe(2);
    expect(projected.map((item) => String(item.stepId))).toEqual(["same-first", "distinct"]);
  });

  test("survives encrypted restart without foreign run contamination", async () => {
    const provenance = citation("own", "민법");
    const own = agentRunSchema.parse({
      ...run([], "run-1"),
      steps: [
        { kind: "decision-started", stepId: "decision-start", decisionId: "decision-1" },
        {
          kind: "decision-recorded",
          stepId: "decision-recorded",
          decision: {
            kind: "tool",
            decisionId: "decision-1",
            toolCall: { toolName: "search-official-law", toolCallId: "call-1", query: "민법" },
          },
        },
        {
          kind: "tool-started",
          stepId: "tool-started",
          decisionId: "decision-1",
          toolCall: { toolName: "search-official-law", toolCallId: "call-1", query: "민법" },
        },
        {
          kind: "tool-finished",
          stepId: "own-step",
          result: {
            toolName: "search-official-law",
            toolCallId: "call-1",
            outcome: "completed",
            observationDigest: digest,
            citationIds: ["own"],
            citations: [provenance],
          },
        },
      ],
    });
    const foreign = run(
      [{ stepId: "foreign-step", citations: [citation("foreign", "형법")] }],
      "foreign-run",
    );
    const root = await mkdtemp(join(tmpdir(), "haksul-citation-restart-"));
    let resumed: AgentRun;
    try {
      const persisted = agentRunSchema.parse({
        ...own,
        state: { kind: "paused", reason: "user-paused" },
      });
      const repository = new AgentRunRepository({
        directory: root,
        encryptionKey: new Uint8Array(32).fill(73),
      });
      await repository.create(persisted);
      resumed = (
        await new AgentRunRepository({
          directory: root,
          encryptionKey: new Uint8Array(32).fill(73),
        }).readCurrent(persisted.runId)
      ).run;
    } finally {
      await rm(root, { recursive: true, force: true });
    }

    expect(projectAgentCitations(resumed)).toEqual([
      expect.objectContaining({ citationId: "own", stepId: "own-step" }),
    ]);
    expect(projectAgentCitations(resumed)).not.toContainEqual(
      expect.objectContaining({ citationId: projectAgentCitations(foreign)[0]?.citationId }),
    );
  });
});
