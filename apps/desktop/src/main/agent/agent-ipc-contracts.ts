import { z } from "zod";
import { agentGoalSchema } from "./agent-contracts";
import {
  agentRunIdSchema,
  approvalDigestSchema,
  approvalIdSchema,
  caseIdSchema,
  contextDigestSchema,
} from "./agent-contracts-core";

export type {
  AgentOfficialCitationProjection,
  AgentRunEvent,
  AgentRunProjection,
  AgentStepSummary,
} from "./agent-ipc-projections";
export {
  agentOfficialCitationProjectionSchema,
  agentRunEventSchema,
  agentRunListResponseSchema,
  agentRunProjectionSchema,
  agentStepSummarySchema,
} from "./agent-ipc-projections";

const runBinding = {
  caseId: caseIdSchema,
  runId: agentRunIdSchema,
  contextDigest: contextDigestSchema,
};

export const agentCaseOpenRequestSchema = z.strictObject({ caseId: caseIdSchema });
export const agentCaseContextSchema = z.strictObject({
  caseId: caseIdSchema,
  contextDigest: contextDigestSchema,
});
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

export type AgentCaseOpenRequest = z.input<typeof agentCaseOpenRequestSchema>;
export type AgentCaseContext = z.input<typeof agentCaseContextSchema>;
export type AgentRunStartIpcRequest = z.input<typeof agentRunStartIpcRequestSchema>;
export type AgentRunBinding = z.input<typeof agentRunGetRequestSchema>;
export type AgentRunListRequest = z.input<typeof agentRunListRequestSchema>;
export type AgentRunResumeRequest = z.input<typeof agentRunResumeRequestSchema>;
export type AgentApprovalDecisionIpcRequest = z.input<typeof agentApprovalDecisionIpcRequestSchema>;
