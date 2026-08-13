import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ApprovedAgentDecisionContext,
  CodexAgentProvider,
} from "../integrations/agent-provider/agent-provider";
import type { KoreanLawMcpAdapter } from "../integrations/korean-law-mcp/korean-law-mcp";
import { createDesktopRuntime } from "./runtime";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function provider(): CodexAgentProvider {
  return {
    state: {
      status: "authenticated" as const,
      account: { type: "chatgpt" as const, email: null, planType: "test" },
    },
    async nextDecision(input: ApprovedAgentDecisionContext) {
      if (input.observations.length === 0) {
        return {
          kind: "tool" as const,
          decisionId: "inspect-decision",
          toolCall: { toolName: "inspect-masked-case" as const, toolCallId: "inspect-call" },
        };
      }
      if (input.observations.length === 1) {
        return {
          kind: "tool" as const,
          decisionId: "law-decision",
          toolCall: {
            toolName: "search-official-law" as const,
            toolCallId: "law-call",
            query: "지급명령 요건",
          },
        };
      }
      if (input.observations.length === 2) {
        const law = input.observations[1];
        if (law === undefined) throw new Error("missing law observation");
        return {
          kind: "tool" as const,
          decisionId: "draft-decision",
          toolCall: {
            toolName: "write-local-draft" as const,
            toolCallId: "draft-call",
            artifactKind: "civil-demand" as const,
            contentDigest: law.observationDigest,
          },
        };
      }
      return {
        kind: "finish" as const,
        decisionId: "finish-decision",
        outcome: { kind: "completed" as const, summaryDigest: "e".repeat(64) },
      };
    },
    interrupt: async () => undefined,
    startChatGptLogin: async (): Promise<never> => {
      throw new Error("unused");
    },
    suggest: async (): Promise<never> => {
      throw new Error("unused");
    },
    dispose: async () => undefined,
  } as CodexAgentProvider;
}

const citation = {
  citationId: "citation-1",
  sourceUrl: "https://law.go.kr/법령/민사소송법",
  law: "민사소송법",
  versionDate: "2026-01-01",
  retrievedAt: "2026-08-13T00:00:00.000Z",
  toolName: "search_law" as const,
  resultDigest: "f".repeat(64),
};
const law = {
  tools: () => ["search_law"],
  discover: async () => ["search_law"],
  execute: async () => ({
    ok: true as const,
    value: { content: { law: "masked provider payload" }, citations: [citation] },
  }),
  close: async () => undefined,
} as KoreanLawMcpAdapter;

describe("production encrypted Agent artifacts", () => {
  test("writes and opens a cited draft through a bounded app-owned projection", async () => {
    const root = await mkdtemp(join(tmpdir(), "haksul-agent-artifact-"));
    roots.push(root);
    const runtime = await createDesktopRuntime(root, {
      loadKey: async () => new Uint8Array(32).fill(23),
      createLaw: () => law,
      createProvider: async () => provider(),
    });
    try {
      const created = await runtime.handlers.createCase({
        amountKrw: 5_380_000,
        jurisdiction: "domestic",
        paymentMethod: "bank-transfer",
      });
      if (created.status !== "accepted") throw new Error("case fixture rejected");
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
      const completed =
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
      expect(completed.state).toMatchObject({ kind: "terminal", outcome: { kind: "completed" } });
      const draft = completed.steps.find(
        (step) => step.kind === "tool-finished" && step.toolName === "write-local-draft",
      );
      if (
        draft?.kind !== "tool-finished" ||
        draft.outcome !== "completed" ||
        typeof draft.artifactId !== "string"
      ) {
        throw new Error("completed draft projection has no bounded artifact ID");
      }

      const openArtifact = Reflect.get(runtime.handlers, "openAgentArtifact");
      expect(openArtifact).toBeFunction();
      const artifact = await openArtifact({
        caseId: created.caseId,
        runId: completed.runId,
        contextDigest: opened.contextDigest,
        artifactId: draft.artifactId,
      });
      expect(artifact).toMatchObject({
        artifactId: draft.artifactId,
        artifactKind: "civil-demand",
        citationIds: ["citation-1"],
        title: expect.any(String),
        sections: expect.any(Array),
      });
      expect(JSON.stringify(artifact)).not.toContain("path");
      expect(JSON.stringify(artifact)).not.toContain("masked provider payload");

      const directory = join(root, "case-vault", "agent-artifacts");
      const files = await readdir(directory);
      expect(files).toHaveLength(1);
      const encrypted = await readFile(join(directory, files[0] ?? ""), "utf8");
      expect(encrypted).not.toContain(created.caseId);
      expect(encrypted).not.toContain("민사소송법");
      expect(encrypted).not.toContain("citation-1");
    } finally {
      await runtime.dispose().catch(() => undefined);
    }
  });
});
