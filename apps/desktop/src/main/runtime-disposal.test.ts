import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodexAgentProvider } from "../integrations/agent-provider/agent-provider";
import type { KoreanLawMcpAdapter } from "../integrations/korean-law-mcp/korean-law-mcp";
import { agentGoalSchema } from "./agent/agent-contracts";
import { createDesktopRuntime } from "./runtime";
import type { RuntimeDeadlineTimer } from "./runtime-deadline";

const roots: string[] = [];

class ManualDeadlineTimer implements RuntimeDeadlineTimer {
  readonly #entries: Array<{ active: boolean; callback: () => void }> = [];
  schedule(_delayMs: number, callback: () => void): () => void {
    const entry = { active: true, callback };
    this.#entries.push(entry);
    return () => {
      entry.active = false;
    };
  }
  firePending(): void {
    for (const entry of this.#entries) {
      if (!entry.active) continue;
      entry.active = false;
      entry.callback();
    }
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("desktop runtime disposal", () => {
  test("bounds noncooperative initialization and cleans a late provider exactly once", async () => {
    const root = await mkdtemp(join(tmpdir(), "haksul-runtime-init-deadline-"));
    roots.push(root);
    const timer = new ManualDeadlineTimer();
    let entered!: () => void;
    const initializationEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: (provider: CodexAgentProvider) => void;
    const providerSource = new Promise<CodexAgentProvider>((resolve) => {
      release = resolve;
    });
    let cleanup!: () => void;
    const cleaned = new Promise<void>((resolve) => {
      cleanup = resolve;
    });
    let cleanupCalls = 0;
    let initializationSignal: AbortSignal | undefined;
    const provider = {
      state: { status: "sign-in-required", action: "sign-in-with-chatgpt" },
      startChatGptLogin: async () => {
        throw new Error("unused");
      },
      dispose: async () => {
        cleanupCalls += 1;
        cleanup();
      },
    } as CodexAgentProvider;
    const law = {
      tools: () => ["search_law", "get_law_text"],
      discover: async () => ["search_law", "get_law_text"],
      execute: async () => ({
        ok: false as const,
        error: { code: "needs_credentials" as const, credential: "LAW_OC" as const },
      }),
      close: async () => undefined,
    } as KoreanLawMcpAdapter;
    const runtime = await createDesktopRuntime(root, {
      loadKey: async () => new Uint8Array(32).fill(19),
      createLaw: () => law,
      createProvider: async (signal) => {
        initializationSignal = signal;
        entered();
        return providerSource;
      },
      lifecycle: { timer, initializationDeadlineMs: 100, disposalDeadlineMs: 10 },
    });
    const created = await runtime.handlers.createCase({
      amountKrw: 100_000,
      jurisdiction: "domestic",
      paymentMethod: "bank-transfer",
    });
    if (created.status !== "accepted") throw new Error("fixture failed");
    const opened = await runtime.agent.openCase(created.caseId);
    void runtime.agent
      .start({
        caseId: created.caseId,
        goal: agentGoalSchema.parse({
          kind: "civil-recovery",
          caseId: created.caseId,
          objective: "prepare-civil-demand",
        }),
        approvedContextDigest: opened.contextDigest,
      })
      .catch(() => undefined);
    await initializationEntered;
    const disposal = runtime.dispose();
    expect(runtime.dispose()).toBe(disposal);
    expect(initializationSignal?.aborted).toBe(true);
    timer.firePending();
    await expect(disposal).rejects.toBeInstanceOf(AggregateError);
    release(provider);
    await cleaned;
    expect(cleanupCalls).toBe(1);
  });
});
