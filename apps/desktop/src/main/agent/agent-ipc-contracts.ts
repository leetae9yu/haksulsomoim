import { z } from "zod";
import {
  agentBudgetSchema,
  agentGoalSchema,
  interruptionSchema,
  terminalOutcomeSchema,
} from "./agent-contracts";
import {
  agentRunIdSchema,
  approvalDigestSchema,
  approvalIdSchema,
  caseIdSchema,
  contextDigestSchema,
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
export const agentRunProjectionSchema = z.strictObject({
  caseId: caseIdSchema,
  runId: agentRunIdSchema,
  goal: agentGoalSchema,
  budget: agentBudgetSchema,
  state: runStateSchema,
  lastStepId: z.string().min(1).max(128).nullable(),
  pendingApproval: pendingApprovalSchema.nullable(),
});
export const agentRunListResponseSchema = z.array(agentRunProjectionSchema).max(100);
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
