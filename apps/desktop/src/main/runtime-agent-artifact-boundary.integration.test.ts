import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
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

const citation = {
  citationId: "citation-boundary",
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
    value: { content: { providerPayload: "DO_NOT_EXPOSE" }, citations: [citation] },
  }),
  close: async () => undefined,
} as KoreanLawMcpAdapter;

function provider(source: "inspection" | "law"): CodexAgentProvider {
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
            query: "지급명령",
            basisObservationDigest: input.observations[0]?.observationDigest,
          },
        };
      }
      if (input.observations.length === 2) {
        return {
          kind: "tool" as const,
          decisionId: "draft-decision",
          toolCall: {
            toolName: "write-local-draft" as const,
            toolCallId: "draft-call",
            artifactKind: "civil-demand" as const,
            contentDigest: input.observations[source === "inspection" ? 0 : 1]?.observationDigest,
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

async function createRun(source: "inspection" | "law") {
  const root = await mkdtemp(join(tmpdir(), "haksul-artifact-boundary-"));
  roots.push(root);
  const runtime = await createDesktopRuntime(root, {
    loadKey: async () => new Uint8Array(32).fill(41),
    createLaw: () => law,
    createProvider: async () => provider(source),
  });
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
  const completed =
    initial.state.kind === "terminal"
      ? initial
      : await new Promise<typeof initial>((resolve) => {
          const off = runtime.handlers.subscribeAgentRun(
            { caseId: created.caseId, runId: initial.runId, contextDigest: opened.contextDigest },
            (event) => {
              if (event.projection.state.kind === "terminal") {
                off();
                resolve(event.projection);
              }
            },
          );
        });
  return { completed, created, opened, root, runtime };
}

function artifactId(run: Awaited<ReturnType<typeof createRun>>["completed"]): string | undefined {
  const draft = run.steps.find(
    (step) => step.kind === "tool-finished" && step.toolName === "write-local-draft",
  );
  return draft?.kind === "tool-finished" ? draft.artifactId : undefined;
}

describe("production Agent artifact authority boundary", () => {
  test("rejects citation laundering from an unrelated completed observation", async () => {
    const fixture = await createRun("inspection");
    try {
      expect(fixture.completed.state).toMatchObject({
        kind: "terminal",
        outcome: { kind: "failed-policy" },
      });
      expect(artifactId(fixture.completed)).toBeUndefined();
    } finally {
      await fixture.runtime.dispose().catch(() => undefined);
    }
  });

  test("rejects pre-mutation consent after a successful authoritative mutation", async () => {
    const fixture = await createRun("law");
    try {
      const id = artifactId(fixture.completed);
      if (id === undefined) throw new Error("valid cited artifact missing");
      const request = {
        caseId: fixture.created.caseId,
        runId: fixture.completed.runId,
        contextDigest: fixture.opened.contextDigest,
        artifactId: id,
      };
      const first = await fixture.runtime.handlers.openAgentArtifact(request);
      await expect(fixture.runtime.handlers.openAgentArtifact(request)).resolves.toEqual(first);
      await expect(
        fixture.runtime.handlers.openAgentArtifact({ ...request, rawPath: "/etc/passwd" }),
      ).rejects.toThrow();
      await expect(
        fixture.runtime.handlers.openAgentArtifact({ ...request, runId: "foreign-run" }),
      ).rejects.toThrow();

      const foreign = await fixture.runtime.handlers.createCase({
        amountKrw: 1_000,
        jurisdiction: "domestic",
        paymentMethod: "bank-transfer",
      });
      if (foreign.status !== "accepted") throw new Error("foreign case fixture rejected");
      const foreignOpened = await fixture.runtime.handlers.openAgentCase({
        caseId: foreign.caseId,
      });
      await expect(
        fixture.runtime.handlers.openAgentArtifact({
          ...request,
          caseId: foreign.caseId,
          contextDigest: foreignOpened.contextDigest,
        }),
      ).rejects.toThrow();

      const mutation = fixture.runtime.handlers.advanceCivil({
        caseId: fixture.created.caseId,
        command: "apply-payment-order",
        userAttested: true,
      });
      const staleOpen = fixture.runtime.handlers.openAgentArtifact(request);
      await expect(mutation).resolves.toMatchObject({ status: "ok" });
      await expect(staleOpen).rejects.toThrow("context consent is stale");
    } finally {
      await fixture.runtime.dispose().catch(() => undefined);
    }
  });
});
