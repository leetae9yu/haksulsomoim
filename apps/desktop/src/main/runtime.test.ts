import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodexAgentProvider } from "../integrations/agent-provider/agent-provider";
import type { KoreanLawMcpAdapter } from "../integrations/korean-law-mcp/korean-law-mcp";
import type { LocalOcrPort } from "../ocr/local-ocr";
import { createDesktopRuntime } from "./runtime";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("desktop runtime", () => {
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
  });
});
