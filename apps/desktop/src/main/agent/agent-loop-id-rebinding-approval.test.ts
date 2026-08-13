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
const PROVIDER_DIGEST = "e".repeat(64);
const WRONG_CONTEXT = "f".repeat(64);
const RAW_IDENTIFIERS = [PHONE_ID, ACCOUNT_ID, SECRET_ID, PROVIDER_DIGEST, WRONG_CONTEXT];

function expectNoRawIdentifiers(run: AgentRun): void {
  const serialized = JSON.stringify(run);
  for (const identifier of RAW_IDENTIFIERS) expect(serialized).not.toContain(identifier);
}

function approvalAttempt(
  decisionId: string,
  approvalId: string,
  approvalDigest: string,
  caseId = "case-1",
  contextDigest = DIGEST_A,
) {
  return {
    kind: "request-approval",
    decisionId,
    approval: {
      approvalId,
      approvalDigest,
      caseId,
      decisionId,
      action: "review-draft",
      contextDigest,
    },
  };
}

describe("host-owned Agent approval correlations", () => {
  test("rebinds phone account secret and digest approval correlations", async () => {
    const pairs: readonly (readonly [string, string])[] = [
      [PHONE_ID, ACCOUNT_ID],
      [ACCOUNT_ID, SECRET_ID],
      [SECRET_ID, PHONE_ID],
    ];

    for (const [decisionId, approvalId] of pairs) {
      const provider = new RecordingProvider(() =>
        approvalAttempt(decisionId, approvalId, PROVIDER_DIGEST),
      );
      const harness = createLoopHarness(provider);
      const run = await harness.service.start({
        caseId: "case-1",
        goal: civilGoal(),
        approvedContextDigest: DIGEST_A,
      });
      const approval = run.steps.find((step) => step.kind === "approval-requested")?.approval;

      expectNoRawIdentifiers(run);
      expect(approval).toMatchObject({
        approvalId: "approval-1",
        decisionId: "decision-1",
        caseId: "case-1",
        contextDigest: DIGEST_A,
      });
      expect(approval?.approvalDigest).not.toBe(PROVIDER_DIGEST);
    }
  });

  test("fails closed on malicious citation case context and digest references", async () => {
    const citationAttempts = [PHONE_ID, ACCOUNT_ID, SECRET_ID].map((citationId) => ({
      kind: "tool",
      decisionId: PHONE_ID,
      toolCall: {
        toolName: "read-official-law-detail",
        toolCallId: ACCOUNT_ID,
        citationId,
      },
    }));
    const invalidApprovalDigests = [PHONE_ID, ACCOUNT_ID, SECRET_ID].map((approvalDigest) =>
      approvalAttempt(PHONE_ID, SECRET_ID, approvalDigest),
    );
    const attempts = [
      ...citationAttempts,
      {
        kind: "tool",
        decisionId: ACCOUNT_ID,
        toolCall: {
          toolName: "write-local-draft",
          toolCallId: SECRET_ID,
          artifactKind: "civil-demand",
          contentDigest: PROVIDER_DIGEST,
        },
      },
      approvalAttempt(ACCOUNT_ID, SECRET_ID, PROVIDER_DIGEST, PHONE_ID),
      approvalAttempt(SECRET_ID, PHONE_ID, PROVIDER_DIGEST, "case-1", WRONG_CONTEXT),
      ...invalidApprovalDigests,
    ];

    for (const attempt of attempts) {
      const provider = new RecordingProvider(() => attempt);
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
      expectNoRawIdentifiers(run);
      expect(harness.lawDetails).toEqual([]);
      expect(harness.draftIdempotencyKeys).toEqual([]);
    }
  });
});
