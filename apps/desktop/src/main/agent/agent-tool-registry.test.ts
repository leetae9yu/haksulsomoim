import { describe, expect, test } from "bun:test";
import { Redactor } from "../../security/redaction";
import { agentToolCallSchema, agentToolResultSchema } from "./agent-contracts";
import type { AgentCaseProjection } from "./agent-loop-types";
import { type AgentEncryptedDraftWriter, AgentToolRegistry } from "./agent-tool-registry";

function fixture() {
  const redactor = new Redactor(new Uint8Array(32).fill(5));
  const draftWrites: Parameters<AgentEncryptedDraftWriter["write"]>[0][] = [];
  const details: string[] = [];
  const registry = new AgentToolRegistry({
    redact: (caseId, value) => redactor.redact(caseId, value),
    law: {
      async search() {
        return { status: "ok", content: { law: "민법" }, citationIds: ["citation-1"] };
      },
      async detail(citationId) {
        details.push(citationId);
        return { status: "ok", content: { citationId }, citationIds: [citationId] };
      },
    },
    drafts: {
      async write(input) {
        draftWrites.push(input);
        return { status: "ok", artifactId: "artifact-1" };
      },
    },
  });
  const projection: AgentCaseProjection = {
    caseId: "case-1",
    contextDigest: "a".repeat(64),
    maskedFacts: [{ id: "amount", text: redactor.redact("case-1", "amount: 100000") }],
    citationIds: ["citation-1"],
    workflow: { criminalState: "evidence-review", civilState: "pre-filing" },
    evidenceCount: 0,
    confirmedFactCount: 0,
  };
  return { details, draftWrites, projection, registry };
}

describe("closed Agent tool registry", () => {
  test("executes each local safe tool as data without workflow side effects", async () => {
    const { draftWrites, projection, registry } = fixture();
    const inspect = agentToolCallSchema.parse({
      toolName: "inspect-masked-case",
      toolCallId: "inspect-1",
    });
    const gaps = agentToolCallSchema.parse({
      toolName: "compute-evidence-gaps",
      toolCallId: "gaps-1",
    });
    const draft = agentToolCallSchema.parse({
      toolName: "write-local-draft",
      toolCallId: "draft-1",
      artifactKind: "civil-demand",
      contentDigest: "b".repeat(64),
    });
    const input = agentToolCallSchema.parse({
      toolName: "request-user-input",
      toolCallId: "input-1",
      field: "evidence-gap",
    });
    const action = agentToolCallSchema.parse({
      toolName: "request-user-action",
      toolCallId: "action-1",
      action: "approve-filing",
    });

    expect(await registry.execute("case-1", inspect, projection)).toMatchObject({
      status: "completed",
      value: { workflow: projection.workflow },
    });
    expect(await registry.execute("case-1", gaps, projection)).toMatchObject({
      status: "completed",
      value: { gaps: ["evidence-file", "confirmed-facts"] },
    });
    expect(await registry.execute("case-1", draft, projection, ["citation-1"])).toMatchObject({
      status: "completed",
      value: { artifactId: "artifact-1" },
    });
    expect(await registry.execute("case-1", input, projection)).toMatchObject({
      status: "pending",
      value: { kind: "user-input", field: "evidence-gap" },
    });
    expect(await registry.execute("case-1", action, projection)).toMatchObject({
      status: "pending",
      value: { kind: "user-action", action: "approve-filing" },
    });
    expect(draftWrites).toEqual([
      {
        caseId: "case-1",
        artifactKind: "civil-demand",
        contentDigest: "b".repeat(64),
        idempotencyKey: "draft-1",
        maskedFacts: projection.maskedFacts,
        citationIds: ["citation-1"],
      },
    ]);
  });

  test("derives draft citations only from the exact causal official-law observation", () => {
    const { registry } = fixture();
    const draft = agentToolCallSchema.parse({
      toolName: "write-local-draft",
      toolCallId: "draft-causal",
      artifactKind: "civil-demand",
      contentDigest: "b".repeat(64),
    });
    const observations = agentToolResultSchema.array().parse([
      {
        toolName: "search-official-law" as const,
        toolCallId: "law-foreign",
        outcome: "completed" as const,
        observationDigest: "c".repeat(64),
        citationIds: ["citation-reused", "citation-foreign"],
      },
      {
        toolName: "inspect-masked-case" as const,
        toolCallId: "inspect-malicious",
        outcome: "completed" as const,
        observationDigest: "d".repeat(64),
        citationIds: ["citation-reused"],
      },
      {
        toolName: "search-official-law" as const,
        toolCallId: "law-causal",
        outcome: "completed" as const,
        observationDigest: "b".repeat(64),
        citationIds: ["citation-reused", "citation-causal"],
      },
    ]);

    expect(registry.validate(draft, ["citation-foreign"], observations)).toEqual([
      "citation-reused",
      "citation-causal",
    ]);
    expect(() =>
      registry.validate(
        agentToolCallSchema.parse({ ...draft, contentDigest: "d".repeat(64) }),
        ["citation-reused"],
        [...observations].reverse(),
      ),
    ).toThrow("exact cited official-law observation");
  });

  test("allows law detail only for a cited result and bounds redacted observations", async () => {
    const { details, projection, registry } = fixture();
    const detail = agentToolCallSchema.parse({
      toolName: "read-official-law-detail",
      toolCallId: "detail-1",
      citationId: "citation-1",
    });
    const inspect = agentToolCallSchema.parse({
      toolName: "inspect-masked-case",
      toolCallId: "inspect-private",
    });

    expect(() => registry.validate(detail, [])).toThrow("requires a cited result");
    registry.validate(detail, ["citation-1"]);
    expect(await registry.execute("case-1", detail, projection)).toMatchObject({
      status: "completed",
      citationIds: ["citation-1"],
    });
    const observation = registry.prepareObservation("case-1", inspect, {
      status: "completed",
      value: { account: "110-123-456789", text: "x".repeat(3_000) },
      citationIds: [],
    });

    expect(details).toEqual(["citation-1"]);
    expect(observation.summary.length).toBeLessThanOrEqual(2_000);
    expect(observation.summary).toContain("[ACCOUNT_");
    expect(observation.summary).not.toContain("110-123-456789");
    expect(observation.result.observationDigest).toMatch(/^[a-f0-9]{64}$/u);
  });
});
