import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodexAgentProvider } from "../integrations/agent-provider/agent-provider";
import type { KoreanLawMcpAdapter } from "../integrations/korean-law-mcp/korean-law-mcp";
import { createDesktopRuntime } from "./runtime";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("production Agent handler runtime", () => {
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
    const initial = await runtime.handlers.startAgentRun({
      caseId: created.caseId,
      contextDigest: opened.contextDigest,
      goal: {
        kind: "civil-recovery",
        caseId: created.caseId,
        objective: "prepare-civil-demand",
      },
    });

    let unsubscribe: () => void = () => undefined;
    const projection =
      initial.state.kind === "active"
        ? await new Promise<typeof initial>((resolve) => {
            unsubscribe = runtime.handlers.subscribeAgentRun(
              {
                caseId: created.caseId,
                runId: initial.runId,
                contextDigest: opened.contextDigest,
              },
              (event) => {
                if (event.projection.state.kind === "terminal") resolve(event.projection);
              },
            );
          })
        : initial;
    unsubscribe();
    expect(projection.state).toMatchObject({ kind: "terminal", outcome: { kind: "completed" } });
    expect(
      projection.steps.flatMap((step) => (step.kind === "tool-finished" ? [step.toolName] : [])),
    ).toEqual(["inspect-masked-case", "search-official-law"]);
    await runtime.dispose();
  });
});
