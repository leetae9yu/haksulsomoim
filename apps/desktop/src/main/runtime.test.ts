import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodexAgentProvider } from "../integrations/agent-provider/agent-provider";
import type { KoreanLawMcpAdapter } from "../integrations/korean-law-mcp/korean-law-mcp";
import type { LocalOcrPort } from "../ocr/local-ocr";
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

describe("desktop runtime", () => {
  test("keeps manual workflows available when agent initialization fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "haksul-runtime-agent-failure-"));
    roots.push(root);
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
      loadKey: async () => new Uint8Array(32).fill(11),
      createLaw: () => law,
      createOcr: async () => ({
        recognize: async () => ({
          status: "readable" as const,
          candidates: [
            {
              text: "송금 100000",
              confidence: 99,
              boundingBox: { x: 0, y: 0, width: 1, height: 1 },
              confirmation: "unconfirmed" as const,
            },
          ],
          needsManualConfirmation: true as const,
        }),
        terminate: async () => undefined,
      }),
      createProvider: async () => Promise.reject(new Error("provider failed to initialize")),
    });
    const created = await runtime.handlers.createCase({
      amountKrw: 100_000,
      jurisdiction: "domestic",
      paymentMethod: "bank-transfer",
    });
    if (created.status !== "accepted") throw new Error("fixture failed");
    const opened = await runtime.agent.openCase(created.caseId);
    expect(
      await runtime.agent.start({
        caseId: created.caseId,
        goal: agentGoalSchema.parse({
          kind: "criminal-complaint",
          caseId: created.caseId,
          objective: "prepare-criminal-complaint",
        }),
        approvedContextDigest: opened.contextDigest,
      }),
    ).toEqual({ status: "unavailable", reason: "provider-initialization" });

    const analyzed = await runtime.handlers.analyzeEvidence({
      caseId: created.caseId,
      filename: "proof.png",
      mimeType: "image/png",
      bytes: [1, 2, 3],
    });
    expect(analyzed.status).toBe("candidates");
    const confirmed = await runtime.handlers.confirmOcrFacts({
      caseId: created.caseId,
      evidenceId: analyzed.evidenceId,
      facts: [{ field: "claimed-amount", value: "100000" }],
    });
    expect(confirmed.status).toBe("ok");
    expect(
      await runtime.handlers.advanceCriminal({
        caseId: created.caseId,
        command: "prepare-complaint",
      }),
    ).toMatchObject({ status: "ok" });
    expect(
      await runtime.handlers.advanceCivil({
        caseId: created.caseId,
        command: "apply-payment-order",
        userAttested: false,
      }),
    ).toMatchObject({ status: "ok" });
    await runtime.dispose();
  });

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

  test("awaits every initialized integration cleanup and reports aggregate failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "haksul-runtime-"));
    roots.push(root);
    const cleaned: string[] = [];
    const law = {
      tools: () => [],
      discover: async () => [],
      execute: async () => ({
        ok: false as const,
        error: { code: "needs_credentials" as const, credential: "LAW_OC" as const },
      }),
      close: async () => {
        cleaned.push("law");
        throw new Error("law close failed");
      },
    } as KoreanLawMcpAdapter;
    const ocr = {
      recognize: async () => ({
        status: "unreadable" as const,
        reason: "no-text-detected" as const,
        candidates: [],
        needsManualConfirmation: true as const,
      }),
      terminate: async () => {
        cleaned.push("ocr");
        throw new Error("ocr close failed");
      },
    } as LocalOcrPort;
    const provider = {
      state: { status: "sign-in-required" as const, action: "sign-in-with-chatgpt" as const },
      startChatGptLogin: async () => {
        throw new Error("unused");
      },
      dispose: async () => {
        cleaned.push("provider");
        throw new Error("provider close failed");
      },
    } as CodexAgentProvider;
    const runtime = await createDesktopRuntime(root, {
      loadKey: async () => new Uint8Array(32).fill(7),
      createLaw: () => law,
      createOcr: async () => ocr,
      createProvider: async () => provider,
    });
    const created = await runtime.handlers.createCase({
      amountKrw: 100_000,
      jurisdiction: "domestic",
      paymentMethod: "bank-transfer",
    });
    if (created.status !== "accepted") throw new Error("fixture failed");
    await runtime.handlers.analyzeEvidence({
      caseId: created.caseId,
      filename: "proof.png",
      mimeType: "image/png",
      bytes: [1],
    });
    await runtime.handlers.codexStatus({});

    let failure: unknown;
    try {
      await runtime.dispose();
    } catch (error) {
      failure = error;
    }
    expect(cleaned.sort()).toEqual(["law", "ocr", "provider"]);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toHaveLength(3);
    await runtime.dispose().catch(() => undefined);
    expect(cleaned.sort()).toEqual(["law", "ocr", "provider"]);
  });
});
