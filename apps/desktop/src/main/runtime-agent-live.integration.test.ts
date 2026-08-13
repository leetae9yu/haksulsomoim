import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodexAgentProvider } from "../integrations/agent-provider/agent-provider";
import type { KoreanLawMcpAdapter } from "../integrations/korean-law-mcp/korean-law-mcp";
import type { AgentRunEvent } from "./agent/agent-ipc-contracts";
import { createDesktopRuntime } from "./runtime";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function deferredProvider() {
  let enteredResolve!: () => void;
  let entered = new Promise<void>((resolve) => (enteredResolve = resolve));
  let rejectTurn: ((reason: Error) => void) | undefined;
  let calls = 0;
  const provider = {
    state: {
      status: "authenticated" as const,
      account: { type: "chatgpt" as const, email: null, planType: "test" },
    },
    nextDecision: async () => {
      calls += 1;
      enteredResolve();
      return new Promise<never>((_resolve, reject) => {
        rejectTurn = reject;
      });
    },
    interrupt: async () => {
      rejectTurn?.(new Error("host interrupted deferred QA turn"));
      rejectTurn = undefined;
    },
    startChatGptLogin: async (): Promise<never> => {
      throw new Error("unused");
    },
    suggest: async (): Promise<never> => {
      throw new Error("unused");
    },
    dispose: async () => undefined,
  } as CodexAgentProvider;
  return {
    provider,
    calls: () => calls,
    entered: () => entered,
    arm() {
      entered = new Promise<void>((resolve) => (enteredResolve = resolve));
    },
  };
}

const law = {
  tools: () => ["search_law"],
  discover: async () => ["search_law"],
  execute: async () => ({ ok: true as const, value: { content: {}, citations: [] } }),
  close: async () => undefined,
} as KoreanLawMcpAdapter;

describe("production initial Agent lifecycle", () => {
  test("returns, broadcasts, pauses, resumes, and cancels the durable initial run", async () => {
    const root = await mkdtemp(join(tmpdir(), "haksul-live-agent-"));
    roots.push(root);
    const deferred = deferredProvider();
    const runtime = await createDesktopRuntime(root, {
      loadKey: async () => new Uint8Array(32).fill(19),
      createLaw: () => law,
      createProvider: async () => deferred.provider,
    });
    try {
      const created = await runtime.handlers.createCase({
        amountKrw: 5_380_000,
        jurisdiction: "domestic",
        paymentMethod: "bank-transfer",
      });
      if (created.status !== "accepted") throw new Error("case fixture rejected");
      const opened = await runtime.handlers.openAgentCase({ caseId: created.caseId });
      const start = runtime.handlers.startAgentRun({
        caseId: created.caseId,
        contextDigest: opened.contextDigest,
        goal: {
          kind: "civil-recovery",
          caseId: created.caseId,
          objective: "prepare-civil-demand",
        },
      });

      await deferred.entered();
      const visible = await runtime.handlers.listAgentRuns({ caseId: created.caseId });
      expect(visible).toHaveLength(1);
      expect(visible[0]?.state).toEqual({ kind: "active" });
      const initial = await start;
      expect(visible[0]?.runId).toBe(initial.runId);
      expect(initial.state).toEqual({ kind: "active" });

      const events: AgentRunEvent[] = [];
      let replay!: (event: AgentRunEvent) => void;
      const replayed = new Promise<AgentRunEvent>((resolve) => (replay = resolve));
      const binding = {
        caseId: created.caseId,
        runId: initial.runId,
        contextDigest: opened.contextDigest,
      };
      const unsubscribe = runtime.handlers.subscribeAgentRun(binding, (event) => {
        events.push(event);
        replay(event);
      });
      expect(
        (await replayed).projection.steps.some((step) => step.kind === "decision-started"),
      ).toBe(true);

      const paused = await runtime.handlers.pauseAgentRun(binding);
      expect(paused.state as unknown).toEqual({ kind: "paused", reason: "user-paused" });
      const cancelledWhilePaused = await runtime.handlers.cancelAgentRun(binding);
      expect(cancelledWhilePaused.state).toEqual({
        kind: "interrupted",
        interruption: { kind: "user-cancelled" },
      });

      deferred.arm();
      const secondStart = runtime.handlers.startAgentRun({
        caseId: created.caseId,
        contextDigest: opened.contextDigest,
        goal: {
          kind: "civil-recovery",
          caseId: created.caseId,
          objective: "prepare-civil-demand",
        },
      });
      await deferred.entered();
      const second = await secondStart;
      const secondBinding = { ...binding, runId: second.runId };
      await runtime.handlers.pauseAgentRun(secondBinding);
      deferred.arm();
      const resumed = await runtime.handlers.resumeAgentRun(secondBinding);
      expect(resumed.state).toEqual({ kind: "active" });
      await deferred.entered();
      const cancelled = await runtime.handlers.cancelAgentRun(secondBinding);
      expect(cancelled.state).toEqual({
        kind: "interrupted",
        interruption: { kind: "user-cancelled" },
      });
      expect(deferred.calls()).toBe(3);
      expect(
        events.some((event) => event.projection.state.kind === "paused") &&
          events.some((event) => event.projection.state.kind === "interrupted"),
      ).toBe(true);
      expect(
        events
          .flatMap((event) => event.projection.steps)
          .some((step) => step.kind === "tool-finished"),
      ).toBe(false);
      unsubscribe();
    } finally {
      await runtime.dispose().catch(() => undefined);
    }
  });
});
