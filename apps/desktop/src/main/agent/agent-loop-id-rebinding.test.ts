import { describe, expect, test } from "bun:test";
import type { AgentRun } from "./agent-contracts";
import {
  civilGoal,
  createLoopHarness,
  DIGEST_A,
  RecordingProvider,
} from "./agent-loop-test-fixtures";

const PHONE_ID = "010-1234-5678";
const ACCOUNT_ID = "110-123-456789";
const SECRET_ID = "secret_api_key_leak";
const SECOND_PHONE_ID = "010-9999-8888";
const PROVIDER_DIGEST = "e".repeat(64);
const RAW_IDENTIFIERS = [PHONE_ID, ACCOUNT_ID, SECRET_ID, SECOND_PHONE_ID, PROVIDER_DIGEST];

function expectNoRawIdentifiers(run: AgentRun): void {
  const serialized = JSON.stringify(run);
  for (const identifier of RAW_IDENTIFIERS) expect(serialized).not.toContain(identifier);
}

function toolCallIds(run: AgentRun): readonly string[] {
  return run.steps.flatMap((step) =>
    step.kind === "tool-started" ? [String(step.toolCall.toolCallId)] : [],
  );
}

describe("host-owned Agent tool correlations", () => {
  test("rebinds provider IDs for inspect law draft user-action and finish variants", async () => {
    const decisions = [
      {
        kind: "tool",
        decisionId: PHONE_ID,
        toolCall: { toolName: "inspect-masked-case", toolCallId: ACCOUNT_ID },
      },
      {
        kind: "tool",
        decisionId: ACCOUNT_ID,
        toolCall: {
          toolName: "search-official-law",
          toolCallId: SECRET_ID,
          query: "민법 부당이득",
        },
      },
      {
        kind: "tool",
        decisionId: SECRET_ID,
        toolCall: {
          toolName: "write-local-draft",
          toolCallId: PHONE_ID,
          artifactKind: "civil-demand",
          contentDigest: "from-observation",
        },
      },
      {
        kind: "tool",
        decisionId: PHONE_ID,
        toolCall: {
          toolName: "request-user-action",
          toolCallId: SECOND_PHONE_ID,
          action: "approve-filing",
        },
      },
    ];
    const provider = new RecordingProvider((input, index) => {
      const selected = decisions[index];
      if (selected === undefined) throw new Error("missing deterministic decision");
      if (selected.kind === "tool" && selected.toolCall.toolName === "write-local-draft") {
        const observation = input.observations[0];
        if (observation === undefined) throw new Error("missing approved observation");
        return {
          ...selected,
          toolCall: { ...selected.toolCall, contentDigest: observation.observationDigest },
        };
      }
      return selected;
    });
    const harness = createLoopHarness(provider);
    const run = await harness.service.start({
      caseId: "case-1",
      goal: civilGoal(),
      approvedContextDigest: DIGEST_A,
    });

    expect(run.state).toEqual({ kind: "paused", reason: "approval-required" });
    expectNoRawIdentifiers(run);
    expect(toolCallIds(run)).toEqual(["tool-1", "tool-2", "tool-3", "tool-4"]);
    expect(harness.draftIdempotencyKeys).toEqual(["tool-3"]);
    expect(harness.lawSearches).toEqual(["민법 부당이득"]);

    const finishProvider = new RecordingProvider(() => ({
      kind: "finish",
      decisionId: SECRET_ID,
      outcome: { kind: "completed", summaryDigest: PROVIDER_DIGEST },
    }));
    const finishHarness = createLoopHarness(finishProvider);
    const finished = await finishHarness.service.start({
      caseId: "case-1",
      goal: civilGoal(),
      approvedContextDigest: DIGEST_A,
    });
    expect(finished.state.kind).toBe("terminal");
    expectNoRawIdentifiers(finished);
  });

  test("rejects one provider correlation reused for different sanitized calls", async () => {
    const provider = new RecordingProvider((_input, index) =>
      index === 0
        ? {
            kind: "tool",
            decisionId: PHONE_ID,
            toolCall: { toolName: "inspect-masked-case", toolCallId: ACCOUNT_ID },
          }
        : {
            kind: "tool",
            decisionId: SECRET_ID,
            toolCall: {
              toolName: "search-official-law",
              toolCallId: ACCOUNT_ID,
              query: "민법",
            },
          },
    );
    const harness = createLoopHarness(provider);
    const run = await harness.service.start({
      caseId: "case-1",
      goal: civilGoal(),
      approvedContextDigest: DIGEST_A,
    });

    expect(run.state).toEqual({
      kind: "terminal",
      outcome: { kind: "failed-policy", reason: "unknown-tool" },
    });
    expect(run.steps.filter((step) => step.kind === "tool-started")).toHaveLength(1);
    expect(harness.lawSearches).toEqual([]);
    expectNoRawIdentifiers(run);
  });
});
