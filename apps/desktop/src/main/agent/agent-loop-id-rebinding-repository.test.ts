import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Redactor } from "../../security/redaction";
import { RuntimeCaseMutationQueue } from "../runtime-case-mutation-queue";
import { AgentLoopService } from "./agent-loop-service";
import {
  civilGoal,
  DIGEST_A,
  MutableProjectionReader,
  RecordingProvider,
} from "./agent-loop-test-fixtures";
import { AgentRunRepository } from "./agent-run-repository";
import { AgentToolRegistry } from "./agent-tool-registry";

const roots: string[] = [];
const PHONE_ID = "010-1234-5678";
const ACCOUNT_ID = "110-123-456789";
const SECRET_ID = "secret_bearer_value";
const PROVIDER_SUMMARY_DIGEST = "d".repeat(64);

function containsRawIdentifier(value: unknown): boolean {
  const serialized = JSON.stringify(value);
  return [PHONE_ID, ACCOUNT_ID, SECRET_ID, PROVIDER_SUMMARY_DIGEST].some((identifier) =>
    serialized.includes(identifier),
  );
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("encrypted Agent ID rebinding", () => {
  test("keeps provider IDs out of logical history and draft idempotency input", async () => {
    const root = await mkdtemp(join(tmpdir(), "haksul-agent-id-rebind-"));
    roots.push(root);
    const runs = new AgentRunRepository({
      directory: root,
      encryptionKey: new Uint8Array(32).fill(6),
    });
    const adapterIds: string[] = [];
    const provider = new RecordingProvider((input, index) => {
      if (index === 0) {
        return {
          kind: "tool",
          decisionId: PHONE_ID,
          toolCall: { toolName: "inspect-masked-case", toolCallId: ACCOUNT_ID },
        };
      }
      if (index === 1) {
        return {
          kind: "tool",
          decisionId: ACCOUNT_ID,
          toolCall: {
            toolName: "search-official-law",
            toolCallId: SECRET_ID,
            query: "지급명령",
          },
        };
      }
      if (index === 2) {
        const observation = input.observations.find(
          (candidate) => candidate.toolName === "search-official-law",
        );
        if (observation === undefined) throw new Error("missing cited law observation");
        return {
          kind: "tool",
          decisionId: ACCOUNT_ID,
          toolCall: {
            toolName: "write-local-draft",
            toolCallId: PHONE_ID,
            artifactKind: "civil-demand",
            contentDigest: observation.observationDigest,
          },
        };
      }
      return {
        kind: "finish",
        decisionId: SECRET_ID,
        outcome: { kind: "completed", summaryDigest: PROVIDER_SUMMARY_DIGEST },
      };
    });
    const redactor = new Redactor(new Uint8Array(32).fill(7));
    const tools = new AgentToolRegistry({
      redact: (caseId, value) => redactor.redact(caseId, value),
      law: {
        async search() {
          return { status: "ok", content: { law: "민사소송법" }, citationIds: ["citation-1"] };
        },
        async detail() {
          return { status: "unavailable", reason: "mcp-unavailable" };
        },
      },
      drafts: {
        async write(input) {
          adapterIds.push(input.idempotencyKey);
          return { status: "ok", artifactId: "artifact-1" };
        },
      },
    });
    const projections = new MutableProjectionReader();
    projections.projection = {
      ...projections.projection,
      citationIds: ["citation-1"],
    };
    let decisionNumber = 0;
    let toolNumber = 0;
    let approvalNumber = 0;
    let stepNumber = 0;
    const service = new AgentLoopService({
      runs,
      projections,
      provider: async () => provider,
      tools,
      mutations: new RuntimeCaseMutationQueue(),
      clock: { now: () => 0 },
      identifiers: {
        nextRunId: () => "run-private",
        nextDecisionId: () => `decision-${++decisionNumber}`,
        nextToolCallId: () => `tool-${++toolNumber}`,
        nextApprovalId: () => `approval-${++approvalNumber}`,
        nextStepId: () => `step-${++stepNumber}`,
      },
    });

    const run = await service.start({
      caseId: "case-1",
      goal: civilGoal(),
      approvedContextDigest: DIGEST_A,
    });
    const reopened = await runs.load(run.runId);

    expect(run.state.kind).toBe("terminal");
    expect(containsRawIdentifier(reopened.run)).toBe(false);
    expect(adapterIds).toEqual(["tool-3"]);
    expect(adapterIds.some((id) => [PHONE_ID, ACCOUNT_ID, SECRET_ID].includes(id))).toBe(false);
  });
});
