import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApprovedAgentDecisionContext } from "../../integrations/agent-provider/agent-provider";
import { Redactor } from "../../security/redaction";
import { RuntimeCaseMutationQueue } from "../runtime-case-mutation-queue";
import type { AgentToolLeaseTransition } from "./agent-case-tool-lease";
import type { AgentRun } from "./agent-contracts";
import { type AgentLoopProvider, AgentLoopService } from "./agent-loop-service";
import { civilGoal, DIGEST_A, DIGEST_C, MutableProjectionReader } from "./agent-loop-test-fixtures";
import { AgentRunRepository, type AgentRunSnapshot } from "./agent-run-repository";
import { EncryptedAgentRunRecordStore } from "./agent-run-repository-record";
import { AgentToolRegistry } from "./agent-tool-registry";

const roots: string[] = [];
const key = new Uint8Array(32).fill(14);

class FaultingRunStore {
  readonly #repository: AgentRunRepository;
  readonly #failure: "save" | "release";

  constructor(repository: AgentRunRepository, failure: "save" | "release") {
    this.#repository = repository;
    this.#failure = failure;
  }

  create(run: AgentRun): Promise<void> {
    return this.#repository.create(run);
  }

  createOwned(run: AgentRun): Promise<void> {
    return this.#repository.createOwned(run);
  }

  transitionToolLease(transition: AgentToolLeaseTransition): Promise<void> {
    return this.#repository.transitionToolLease(transition);
  }

  async releaseOwned(caseId: string, runId: string): Promise<void> {
    if (this.#failure === "release") throw new Error("injected claim release failure");
    await this.#repository.releaseOwned(caseId, runId);
  }

  load(runId: string): Promise<AgentRunSnapshot> {
    return this.#repository.load(runId);
  }

  async save(snapshot: AgentRunSnapshot): Promise<void> {
    if (this.#failure === "save") throw new Error("injected checkpoint storage failure");
    await this.#repository.save(snapshot);
  }
}

function tools(): AgentToolRegistry {
  const redactor = new Redactor(new Uint8Array(32).fill(15));
  return new AgentToolRegistry({
    redact: (caseId, value) => redactor.redact(caseId, value),
    law: {
      async search() {
        return { status: "unavailable", reason: "mcp-unavailable" };
      },
      async detail() {
        return { status: "unavailable", reason: "mcp-unavailable" };
      },
    },
    drafts: {
      async write() {
        return { status: "unavailable", reason: "writer-unavailable" };
      },
    },
  });
}

function service(
  runs: AgentRunRepository | FaultingRunStore,
  provider: AgentLoopProvider,
  runId: string,
  caseId = "case-1",
): AgentLoopService {
  let decision = 0;
  let tool = 0;
  let approval = 0;
  let step = 0;
  return new AgentLoopService({
    runs,
    projections: new MutableProjectionReader(caseId),
    provider: async () => provider,
    tools: tools(),
    mutations: new RuntimeCaseMutationQueue(),
    clock: { now: () => 0 },
    identifiers: {
      nextRunId: () => runId,
      nextDecisionId: () => `decision-${++decision}`,
      nextToolCallId: () => `tool-${++tool}`,
      nextApprovalId: () => `approval-${++approval}`,
      nextStepId: () => `step-${++step}`,
    },
  });
}

function finishingProvider(): AgentLoopProvider {
  return {
    state: { status: "authenticated" },
    async nextDecision() {
      return {
        kind: "finish",
        decisionId: "provider-finish",
        outcome: { kind: "completed", summaryDigest: DIGEST_C },
      };
    },
    async interrupt() {},
  };
}

function pendingProvider() {
  let announce = (): void => undefined;
  const started = new Promise<void>((resolve) => {
    announce = resolve;
  });
  const provider: AgentLoopProvider = {
    state: { status: "authenticated" },
    async nextDecision(_input: ApprovedAgentDecisionContext) {
      announce();
      return new Promise<never>(() => undefined);
    },
    async interrupt() {},
  };
  return { provider, started };
}

async function repositoryFixture(): Promise<Readonly<{ root: string; runs: AgentRunRepository }>> {
  const root = await mkdtemp(join(tmpdir(), "haksul-agent-durable-owner-"));
  roots.push(root);
  return { root, runs: new AgentRunRepository({ directory: root, encryptionKey: key }) };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("durable Agent case ownership", () => {
  test("checkpoint failure cannot strand an active run and admit a second owner", async () => {
    const { root, runs } = await repositoryFixture();
    const first = service(new FaultingRunStore(runs, "save"), finishingProvider(), "run-1");

    await expect(
      first.start({ caseId: "case-1", goal: civilGoal(), approvedContextDigest: DIGEST_A }),
    ).rejects.toThrow("injected checkpoint storage failure");
    await expect(
      first.start({ caseId: "case-1", goal: civilGoal(), approvedContextDigest: DIGEST_A }),
    ).rejects.toMatchObject({ code: "AGENT_LOOP_ALREADY_ACTIVE" });

    const reopened = new AgentRunRepository({ directory: root, encryptionKey: key });
    expect((await reopened.load("run-1")).run.state).toEqual({ kind: "active" });
    await expect(
      service(reopened, finishingProvider(), "run-2").start({
        caseId: "case-1",
        goal: civilGoal(),
        approvedContextDigest: DIGEST_A,
      }),
    ).rejects.toMatchObject({ code: "AGENT_CASE_ALREADY_CLAIMED" });
    expect(await reopened.activeRunId("case-1")).toBe("run-1");
  });

  test("retains durable and in-memory ownership when claim release fails", async () => {
    const { root, runs } = await repositoryFixture();
    const first = service(new FaultingRunStore(runs, "release"), finishingProvider(), "run-1");

    await expect(
      first.start({ caseId: "case-1", goal: civilGoal(), approvedContextDigest: DIGEST_A }),
    ).rejects.toThrow("injected claim release failure");
    const persisted = await new EncryptedAgentRunRecordStore(root, key).read("run-1");
    expect(persisted.run.state.kind).toBe("terminal");
    expect(await runs.activeRunId("case-1")).toBe("run-1");
    await expect(
      first.start({ caseId: "case-1", goal: civilGoal(), approvedContextDigest: DIGEST_A }),
    ).rejects.toMatchObject({ code: "AGENT_LOOP_ALREADY_ACTIVE" });
    const reopened = new AgentRunRepository({ directory: root, encryptionKey: key });
    expect(await reopened.activeRunId("case-1")).toBe("run-1");
  });

  test("recreating the service and repository cannot bypass an active owner", async () => {
    const { root, runs } = await repositoryFixture();
    const pending = pendingProvider();
    const first = service(runs, pending.provider, "run-restart-owner");
    const active = first.start({
      caseId: "case-1",
      goal: civilGoal(),
      approvedContextDigest: DIGEST_A,
    });
    await pending.started;

    const recreated = new AgentRunRepository({ directory: root, encryptionKey: key });
    await expect(
      service(recreated, finishingProvider(), "run-restart-bypass").start({
        caseId: "case-1",
        goal: civilGoal(),
        approvedContextDigest: DIGEST_A,
      }),
    ).rejects.toMatchObject({ code: "AGENT_CASE_ALREADY_CLAIMED" });

    await first.cancel({ caseId: "case-1", runId: "run-restart-owner" });
    expect((await active).state.kind).toBe("interrupted");
    expect(await recreated.activeRunId("case-1")).toBeUndefined();
  });

  test("different cases acquire owners and run concurrently", async () => {
    const { root, runs: leftRuns } = await repositoryFixture();
    const rightRuns = new AgentRunRepository({ directory: root, encryptionKey: key });
    const leftPending = pendingProvider();
    const rightPending = pendingProvider();
    const left = service(leftRuns, leftPending.provider, "run-left", "case-left");
    const right = service(rightRuns, rightPending.provider, "run-right", "case-right");
    const leftRun = left.start({
      caseId: "case-left",
      goal: civilGoal("case-left"),
      approvedContextDigest: DIGEST_A,
    });
    const rightRun = right.start({
      caseId: "case-right",
      goal: civilGoal("case-right"),
      approvedContextDigest: DIGEST_A,
    });
    await Promise.all([leftPending.started, rightPending.started]);

    expect(await leftRuns.activeRunId("case-left")).toBe("run-left");
    expect(await rightRuns.activeRunId("case-right")).toBe("run-right");
    await Promise.all([
      left.cancel({ caseId: "case-left", runId: "run-left" }),
      right.cancel({ caseId: "case-right", runId: "run-right" }),
    ]);
    expect((await leftRun).state.kind).toBe("interrupted");
    expect((await rightRun).state.kind).toBe("interrupted");
  });
});
