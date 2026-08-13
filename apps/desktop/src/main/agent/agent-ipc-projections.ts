import { z } from "zod";
import {
  agentBudgetSchema,
  agentGoalSchema,
  interruptionSchema,
  terminalOutcomeSchema,
} from "./agent-contracts";
import {
  agentArtifactIdSchema,
  agentRunIdSchema,
  agentStepIdSchema,
  approvalDigestSchema,
  approvalIdSchema,
  caseIdSchema,
  contextDigestSchema,
  koreanLawCitationIdSchema,
  officialKoreanLawUrlSchema,
} from "./agent-contracts-core";

const runStateSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("active") }),
  z.strictObject({
    kind: z.literal("paused"),
    reason: z.enum([
      "approval-required",
      "provider-unavailable",
      "tool-unavailable",
      "context-changed",
      "user-paused",
    ]),
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
    dependsOnStepId: agentStepIdSchema.optional(),
    artifactId: agentArtifactIdSchema.optional(),
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
    reason: z.enum([
      "user-cancelled",
      "provider-timeout",
      "tool-timeout",
      "application-restarted",
      "user-paused",
    ]),
  }),
  z.strictObject({
    kind: z.literal("terminal"),
    stepId: agentStepIdSchema,
    outcome: terminalStepOutcomeSchema,
  }),
]);
export type AgentStepSummary = z.infer<typeof agentStepSummarySchema>;

export const agentOfficialCitationProjectionSchema = z.strictObject({
  citationId: koreanLawCitationIdSchema,
  stepId: agentStepIdSchema,
  sourceUrl: officialKoreanLawUrlSchema,
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
    revision: z.number().int().min(0).default(0),
    budget: agentBudgetSchema,
    state: runStateSchema,
    lastStepId: agentStepIdSchema.nullable(),
    pendingApproval: pendingApprovalSchema.nullable(),
    steps: z.array(agentStepSummarySchema).max(41).readonly(),
    citations: z.array(agentOfficialCitationProjectionSchema).max(24).readonly(),
  })
  .superRefine((projection, context) => {
    if (projection.lastStepId !== (projection.steps.at(-1)?.stepId ?? null)) {
      context.addIssue({
        code: "custom",
        message: "Agent projection last step must match its ordered summaries",
        path: ["lastStepId"],
      });
    }
    projection.steps.forEach((step, index) => {
      if (step.kind !== "tool-finished") return;
      if (
        step.artifactId !== undefined &&
        (step.toolName !== "write-local-draft" || step.outcome !== "completed")
      ) {
        context.addIssue({
          code: "custom",
          message: "Only a completed local draft may expose an artifact ID",
          path: ["steps", index, "artifactId"],
        });
      }
      if (step.dependsOnStepId === undefined) return;
      const sourceIndex = projection.steps.findIndex(
        (candidate) =>
          candidate.kind === "tool-finished" &&
          candidate.outcome === "completed" &&
          candidate.stepId === step.dependsOnStepId,
      );
      if (sourceIndex < 0 || sourceIndex >= index) {
        context.addIssue({
          code: "custom",
          message: "Agent tool dependency must link to a prior completed observation",
          path: ["steps", index, "dependsOnStepId"],
        });
      }
    });
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
export type AgentRunProjection = z.infer<typeof agentRunProjectionSchema>;
export type AgentRunEvent = z.infer<typeof agentRunEventSchema>;
