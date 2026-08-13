import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodexAgentProvider } from "../integrations/agent-provider/agent-provider";
import type { KoreanLawMcpAdapter } from "../integrations/korean-law-mcp/korean-law-mcp";
import type { LocalOcrPort } from "../ocr/local-ocr";
import { agentGoalSchema } from "./agent/agent-contracts";
import { createDesktopRuntime } from "./runtime";

const roots: string[] = [];
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

  test("routes a real Agent run through the production handler surface", async () => {
    const root = await mkdtemp(join(tmpdir(), "haksul-runtime-agent-ipc-"));
    roots.push(root);
    let turn = 0;
    const provider = {
      state: {
        status: "authenticated" as const,
        account: { type: "chatgpt" as const, email: null, planType: "test" },
      },
      async nextDecision() {
        turn += 1;
        if (turn === 1) {
          return {
            kind: "tool",
            decisionId: "provider-inspect",
            toolCall: { toolName: "inspect-masked-case", toolCallId: "provider-tool-inspect" },
          };
        }
        if (turn === 2) {
          return {
            kind: "tool",
            decisionId: "provider-law",
            toolCall: {
              toolName: "search-official-law",
              toolCallId: "provider-tool-law",
              query: "지급명령",
            },
          };
        }
        return {
          kind: "finish",
          decisionId: "provider-finish",
          outcome: { kind: "completed", summaryDigest: "c".repeat(64) },
        };
      },
      interrupt: async () => undefined,
      startChatGptLogin: async () => {
        throw new Error("unused");
      },
      suggest: async () => {
        throw new Error("unused");
      },
      dispose: async () => undefined,
    } as unknown as CodexAgentProvider;
    const runtime = await createDesktopRuntime(root, {
      loadKey: async () => new Uint8Array(32).fill(13),
      createLaw: () =>
        ({
          tools: () => ["search_law"],
          discover: async () => ["search_law"],
          execute: async () => ({ ok: true, value: { content: {}, citations: [] } }),
          close: async () => undefined,
        }) as KoreanLawMcpAdapter,
      createProvider: async () => provider,
    });
    const created = await runtime.handlers.createCase({
      amountKrw: 538_000,
      jurisdiction: "domestic",
      paymentMethod: "bank-transfer",
    });
    if (created.status !== "accepted") throw new Error("fixture failed");
    const opened = await runtime.handlers.openAgentCase({ caseId: created.caseId });
    const projection = await runtime.handlers.startAgentRun({
      caseId: created.caseId,
      contextDigest: opened.contextDigest,
      goal: {
        kind: "civil-recovery",
        caseId: created.caseId,
        objective: "prepare-civil-demand",
      },
    });

    expect(projection.state).toMatchObject({ kind: "terminal", outcome: { kind: "completed" } });
    expect(
      projection.steps.flatMap((step) => (step.kind === "tool-finished" ? [step.toolName] : [])),
    ).toEqual(["inspect-masked-case", "search-official-law"]);
    await runtime.dispose();
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
      suggest: async () => {
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
