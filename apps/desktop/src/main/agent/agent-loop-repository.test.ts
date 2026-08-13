import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Redactor } from "../../security/redaction";
import { RuntimeCaseMutationQueue } from "../runtime-case-mutation-queue";
import type { AgentRun } from "./agent-contracts";
import { AgentLoopService } from "./agent-loop-service";
import {
  civilGoal,
  DIGEST_A,
  DIGEST_C,
  MutableProjectionReader,
  RecordingProvider,
} from "./agent-loop-test-fixtures";
import type { AgentRunStore } from "./agent-loop-types";
import { AgentRunRepository, type AgentRunSnapshot } from "./agent-run-repository";
import { AgentToolRegistry } from "./agent-tool-registry";

const roots: string[] = [];

class ObservedRunStore implements AgentRunStore {
  readonly persistedQueries: string[] = [];
  readonly #repository: AgentRunRepository;

  constructor(repository: AgentRunRepository) {
    this.#repository = repository;
  }

  create(run: AgentRun): Promise<void> {
    return this.#repository.create(run);
  }

  load(runId: string): Promise<AgentRunSnapshot> {
    return this.#repository.load(runId);
  }

  async save(snapshot: AgentRunSnapshot): Promise<void> {
    await this.#repository.save(snapshot);
    for (const step of snapshot.run.steps) {
      const call =
        step.kind === "decision-recorded" && step.decision.kind === "tool"
          ? step.decision.toolCall
          : step.kind === "tool-started"
            ? step.toolCall
            : undefined;
      if (call?.toolName === "search-official-law") this.persistedQueries.push(call.query);
    }
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Agent loop encrypted checkpoint integration", () => {
  test("redacts a model-authored law query before decision persistence", async () => {
    const root = await mkdtemp(join(tmpdir(), "haksul-agent-loop-"));
    roots.push(root);
    const repository = new AgentRunRepository({
      directory: root,
      encryptionKey: new Uint8Array(32).fill(8),
    });
    const runs = new ObservedRunStore(repository);
    const rawQuery = "010-1234-5678 민법 부당이득";
    let adapterQuery = "";
    let checkpointBeforeAdapter = "";
    const provider = new RecordingProvider((_input, index) =>
      index === 0
        ? {
            kind: "tool",
            decisionId: "model-search",
            toolCall: {
              toolName: "search-official-law",
              toolCallId: "private-search",
              query: rawQuery,
            },
          }
        : {
            kind: "finish",
            decisionId: "model-finish",
            outcome: { kind: "completed", summaryDigest: DIGEST_C },
          },
    );
    const redactor = new Redactor(new Uint8Array(32).fill(9));
    const tools = new AgentToolRegistry({
      redact: (caseId, value) => redactor.redact(caseId, value),
      law: {
        async search(query) {
          adapterQuery = query;
          checkpointBeforeAdapter = runs.persistedQueries.at(-1) ?? "";
          return { status: "ok", content: { law: "민법" }, citationIds: ["citation-1"] };
        },
        async detail(citationId) {
          return { status: "ok", content: { citationId }, citationIds: [citationId] };
        },
      },
      drafts: {
        async write() {
          return { status: "unavailable", reason: "writer-unavailable" };
        },
      },
    });
    let decisionNumber = 0;
    let toolNumber = 0;
    let approvalNumber = 0;
    let stepNumber = 0;
    const service = new AgentLoopService({
      runs,
      projections: new MutableProjectionReader(),
      provider: async () => provider,
      tools,
      mutations: new RuntimeCaseMutationQueue(),
      clock: { now: () => 0 },
      identifiers: {
        nextRunId: () => "private-run",
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
    const reopened = await repository.load(run.runId);
    const persistedQueries = reopened.run.steps.flatMap((step) => {
      const call =
        step.kind === "decision-recorded" && step.decision.kind === "tool"
          ? step.decision.toolCall
          : step.kind === "tool-started"
            ? step.toolCall
            : undefined;
      return call?.toolName === "search-official-law" ? [call.query] : [];
    });

    expect(run.state.kind).toBe("terminal");
    expect(checkpointBeforeAdapter).toBe(adapterQuery);
    expect(adapterQuery).toContain("[PHONE_");
    expect(adapterQuery).not.toContain("010-1234-5678");
    expect(persistedQueries).toHaveLength(2);
    expect(persistedQueries.every((query) => query === adapterQuery)).toBe(true);
  });
});
