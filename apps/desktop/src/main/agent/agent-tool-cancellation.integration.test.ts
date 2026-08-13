import { describe, expect, test } from "bun:test";
import {
  civilGoal,
  createLoopHarness,
  DIGEST_A,
  RecordingProvider,
} from "./agent-loop-test-fixtures";
import type { AgentExecutionTimer } from "./agent-tool-execution";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, reject, resolve };
}

class ManualTimer implements AgentExecutionTimer {
  readonly #entries: Array<{ active: boolean; callback: () => void }> = [];
  schedule(_delayMs: number, callback: () => void): () => void {
    const entry = { active: true, callback };
    this.#entries.push(entry);
    return () => {
      entry.active = false;
    };
  }
  firePending(): void {
    for (const entry of [...this.#entries]) {
      if (!entry.active) continue;
      entry.active = false;
      entry.callback();
    }
  }
}

const lawResult = {
  status: "ok" as const,
  content: { law: "민사소송법" },
  citationIds: [],
  citations: [],
};
const toolDecision = {
  kind: "tool",
  decisionId: "model-decision",
  toolCall: {
    toolName: "search-official-law",
    toolCallId: "model-tool",
    query: "지급명령",
  },
} as const;

describe("Agent tool execution ownership", () => {
  test("aborts cancellation and quarantines a noncooperative tool without late commit", async () => {
    const entered = deferred<void>();
    const aborted = deferred<void>();
    const release = deferred<typeof lawResult>();
    const lateSettled = deferred<void>();
    const timer = new ManualTimer();
    const provider = new RecordingProvider(() => toolDecision);
    const { runs, service } = createLoopHarness(provider, {
      timer,
      toolSettlementGraceMs: 10,
      law: {
        async search(_query, context) {
          context.signal.addEventListener("abort", () => aborted.resolve(), { once: true });
          entered.resolve();
          try {
            return await release.promise;
          } finally {
            lateSettled.resolve();
          }
        },
        async detail() {
          throw new Error("unused");
        },
      },
    });
    const first = await service.begin({
      caseId: "case-1",
      goal: civilGoal(),
      approvedContextDigest: DIGEST_A,
    });
    await entered.promise;

    const cancellation = service.cancel({ caseId: "case-1", runId: first.initial.runId });
    await aborted.promise;
    timer.firePending();
    const cancelled = await cancellation;
    expect(cancelled.state).toEqual({
      kind: "interrupted",
      interruption: { kind: "user-cancelled" },
    });
    await expect(
      service.begin({
        caseId: "case-1",
        goal: civilGoal(),
        approvedContextDigest: DIGEST_A,
      }),
    ).rejects.toThrow();
    expect(service.activeRuns()).toEqual([{ caseId: "case-1", runId: first.initial.runId }]);

    release.resolve(lawResult);
    await lateSettled.promise;
    await first.completion;
    const persisted = await runs.load(first.initial.runId);
    expect(persisted.run.steps.some((step) => step.kind === "tool-finished")).toBe(false);
    expect(service.activeRuns()).toHaveLength(1);
  });

  test("releases ownership after a cooperative aborted tool settles", async () => {
    const entered = deferred<void>();
    const provider = new RecordingProvider((input) =>
      input.observations.length === 0
        ? toolDecision
        : {
            kind: "finish",
            decisionId: "model-finish",
            outcome: { kind: "completed", summaryDigest: "f".repeat(64) },
          },
    );
    const { service } = createLoopHarness(provider, {
      law: {
        async search(_query, context) {
          entered.resolve();
          return new Promise((_, reject) => {
            context.signal.addEventListener("abort", () => reject(context.signal.reason), {
              once: true,
            });
          });
        },
        async detail() {
          throw new Error("unused");
        },
      },
    });
    const first = await service.begin({
      caseId: "case-1",
      goal: civilGoal(),
      approvedContextDigest: DIGEST_A,
    });
    await entered.promise;
    await service.cancel({ caseId: "case-1", runId: first.initial.runId });
    expect(service.activeRuns()).toEqual([]);

    const replacement = await service.begin({
      caseId: "case-1",
      goal: civilGoal(),
      approvedContextDigest: DIGEST_A,
    });
    expect(replacement.initial.runId).not.toBe(first.initial.runId);
    await service.cancel({ caseId: "case-1", runId: replacement.initial.runId });
  });

  test("records a typed tool timeout after cooperative interruption", async () => {
    const entered = deferred<void>();
    const timer = new ManualTimer();
    const provider = new RecordingProvider(() => toolDecision);
    const { service } = createLoopHarness(provider, {
      timer,
      toolTimeoutMs: 10,
      law: {
        async search(_query, context) {
          entered.resolve();
          return new Promise((_, reject) => {
            context.signal.addEventListener("abort", () => reject(context.signal.reason), {
              once: true,
            });
          });
        },
        async detail() {
          throw new Error("unused");
        },
      },
    });
    const execution = await service.begin({
      caseId: "case-1",
      goal: civilGoal(),
      approvedContextDigest: DIGEST_A,
    });
    await entered.promise;
    timer.firePending();
    const run = await execution.completion;
    expect(run.state).toEqual({ kind: "paused", reason: "tool-unavailable" });
    expect(run.steps.at(-1)).toMatchObject({
      kind: "interrupted",
      interruption: { kind: "tool-timeout" },
    });
  });
});
