import { z } from "zod";
import {
  agentBudgetSchema,
  agentGoalSchema,
  interruptionSchema,
  terminalOutcomeSchema,
} from "./agent-contracts";
import {
  agentRunIdSchema,
  agentStepIdSchema,
  approvalDigestSchema,
  approvalIdSchema,
  caseIdSchema,
  contextDigestSchema,
  koreanLawCitationIdSchema,
} from "./agent-contracts-core";

const runBinding = {
  caseId: caseIdSchema,
  runId: agentRunIdSchema,
  contextDigest: contextDigestSchema,
};

export const agentRunStartIpcRequestSchema = z
  .strictObject({
    caseId: caseIdSchema,
    goal: agentGoalSchema,
    contextDigest: contextDigestSchema,
  })
  .superRefine((request, context) => {
    if (request.caseId !== request.goal.caseId) {
      context.addIssue({
        code: "custom",
        message: "Agent goal must belong to the requested case",
        path: ["goal", "caseId"],
      });
    }
  });
export const agentRunGetRequestSchema = z.strictObject(runBinding);
export const agentRunListRequestSchema = z.strictObject({ caseId: caseIdSchema });
export const agentRunPauseRequestSchema = z.strictObject(runBinding);
export const agentRunResumeRequestSchema = z.strictObject({
  ...runBinding,
  userInput: z.string().trim().min(1).max(2_000).optional(),
});
export const agentRunCancelRequestSchema = z.strictObject(runBinding);
export const agentApprovalDecisionIpcRequestSchema = z.strictObject({
  ...runBinding,
  approvalId: approvalIdSchema,
  approvalDigest: approvalDigestSchema,
  outcome: z.enum(["approved", "denied"]),
});
export const agentRunSubscribeRequestSchema = z.strictObject(runBinding);
export const agentRunSubscriptionControlSchema = z.union([
  agentRunSubscribeRequestSchema.extend({ action: z.literal("subscribe") }).strict(),
  agentRunSubscribeRequestSchema.extend({ action: z.literal("unsubscribe") }).strict(),
]);

const runStateSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("active") }),
  z.strictObject({
    kind: z.literal("paused"),
    reason: z.enum(["approval-required", "provider-unavailable", "context-changed"]),
  }),
  z.strictObject({ kind: z.literal("terminal"), outcome: terminalOutcomeSchema }),
  z.strictObject({ kind: z.literal("interrupted"), interruption: interruptionSchema }),
]);
const pendingApprovalSchema = z.strictObject({
  approvalId: approvalIdSchema,
  approvalDigest: approvalDigestSchema,
  contextDigest: contextDigestSchema,
  action: z.enum(["review-draft", "approve-filing"]),
});
const agentToolNameSchema = z.enum([
  "inspect-masked-case",
  "search-official-law",
  "read-official-law-detail",
  "compute-evidence-gaps",
  "write-local-draft",
  "request-user-input",
  "request-user-action",
]);
const terminalStepOutcomeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("completed") }),
  z.strictObject({
    kind: z.literal("budget-exhausted"),
    exhausted: z.enum(["decisions", "tools", "duration"]),
  }),
  z.strictObject({
    kind: z.literal("failed-policy"),
    reason: z.enum(["unknown-tool", "stale-approval", "context-changed"]),
  }),
]);
export const agentStepSummarySchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("decision-started"), stepId: agentStepIdSchema }),
  z.strictObject({
    kind: z.literal("decision-recorded"),
    stepId: agentStepIdSchema,
    decisionKind: z.enum(["tool", "request-approval", "finish"]),
  }),
  z.strictObject({
    kind: z.literal("tool-started"),
    stepId: agentStepIdSchema,
    toolName: agentToolNameSchema,
  }),
  z.strictObject({
    kind: z.literal("tool-finished"),
    stepId: agentStepIdSchema,
    toolName: agentToolNameSchema,
    outcome: z.enum(["completed", "unavailable", "rejected"]),
  }),
  z.strictObject({
    kind: z.literal("approval-requested"),
    stepId: agentStepIdSchema,
    action: z.enum(["review-draft", "approve-filing"]),
  }),
  z.strictObject({
    kind: z.literal("approval-decided"),
    stepId: agentStepIdSchema,
    outcome: z.enum(["approved", "denied"]),
  }),
  z.strictObject({
    kind: z.literal("interrupted"),
    stepId: agentStepIdSchema,
    reason: z.enum(["user-cancelled", "provider-timeout", "application-restarted"]),
  }),
  z.strictObject({
    kind: z.literal("terminal"),
    stepId: agentStepIdSchema,
    outcome: terminalStepOutcomeSchema,
  }),
]);
export type AgentStepSummary = z.infer<typeof agentStepSummarySchema>;

const officialCitationOrigins = new Set(["https://law.go.kr", "https://www.law.go.kr"]);
export const agentOfficialCitationProjectionSchema = z.strictObject({
  citationId: koreanLawCitationIdSchema,
  stepId: agentStepIdSchema,
  sourceUrl: z
    .string()
    .max(2_048)
    .refine((value) => {
      try {
        return officialCitationOrigins.has(new URL(value).origin);
      } catch {
        return false;
      }
    }, "Citation must use an official Korean law HTTPS origin"),
  law: z.string().trim().min(1).max(160),
  versionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  retrievedAt: z
    .string()
    .max(64)
    .regex(/^\d{4}-\d{2}-\d{2}T/),
});
export type AgentOfficialCitationProjection = z.infer<typeof agentOfficialCitationProjectionSchema>;

export const agentRunProjectionSchema = z
  .strictObject({
    caseId: caseIdSchema,
    runId: agentRunIdSchema,
    goal: agentGoalSchema,
    budget: agentBudgetSchema,
    state: runStateSchema,
    lastStepId: agentStepIdSchema.nullable(),
    pendingApproval: pendingApprovalSchema.nullable(),
    steps: z.array(agentStepSummarySchema).max(41).readonly(),
    citations: z.array(agentOfficialCitationProjectionSchema).max(24).readonly(),
  })
  .superRefine((projection, context) => {
    const expectedLastStep = projection.steps.at(-1)?.stepId ?? null;
    if (projection.lastStepId !== expectedLastStep) {
      context.addIssue({
        code: "custom",
        message: "Agent projection last step must match its ordered summaries",
        path: ["lastStepId"],
      });
    }
    const officialStepIds = new Set(
      projection.steps
        .filter(
          (step) =>
            step.kind === "tool-finished" &&
            step.outcome === "completed" &&
            (step.toolName === "search-official-law" ||
              step.toolName === "read-official-law-detail"),
        )
        .map((step) => step.stepId),
    );
    const citationIds = new Set<string>();
    projection.citations.forEach((citation, index) => {
      if (!officialStepIds.has(citation.stepId)) {
        context.addIssue({
          code: "custom",
          message: "Agent citation must link to a completed official-law step",
          path: ["citations", index, "stepId"],
        });
      }
      if (citationIds.has(citation.citationId)) {
        context.addIssue({
          code: "custom",
          message: "Agent citation IDs must be unique",
          path: ["citations", index, "citationId"],
        });
      }
      citationIds.add(citation.citationId);
    });
  });
export const agentRunListResponseSchema = z
  .array(agentRunProjectionSchema)
  .max(100)
  .superRefine((runs, context) => {
    const identities = new Set<string>();
    runs.forEach((run, index) => {
      const identity = JSON.stringify([run.caseId, run.runId]);
      if (identities.has(identity)) {
        context.addIssue({
          code: "custom",
          message: "Duplicate Agent run identity",
          path: [index],
        });
      }
      identities.add(identity);
    });
  });
export const agentRunEventSchema = z.strictObject({
  caseId: caseIdSchema,
  runId: agentRunIdSchema,
  projection: agentRunProjectionSchema,
});

export type AgentRunStartIpcRequest = z.input<typeof agentRunStartIpcRequestSchema>;
export type AgentRunBinding = z.input<typeof agentRunGetRequestSchema>;
export type AgentRunListRequest = z.input<typeof agentRunListRequestSchema>;
export type AgentRunResumeRequest = z.input<typeof agentRunResumeRequestSchema>;
export type AgentApprovalDecisionIpcRequest = z.input<typeof agentApprovalDecisionIpcRequestSchema>;
export type AgentRunProjection = z.infer<typeof agentRunProjectionSchema>;
export type AgentRunEvent = z.infer<typeof agentRunEventSchema>;
