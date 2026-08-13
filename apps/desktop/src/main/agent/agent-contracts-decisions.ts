import { z } from "zod";
import {
  agentArtifactIdSchema,
  agentDecisionIdSchema,
  agentStepIdSchema,
  agentToolCallIdSchema,
  approvalDigestSchema,
  approvalIdSchema,
  boundedText,
  caseIdSchema,
  contextDigestSchema,
  interruptionSchema,
  koreanLawCitationIdSchema,
  observationDigestSchema,
  officialKoreanLawUrlSchema,
  terminalOutcomeSchema,
} from "./agent-contracts-core";

const inspectMaskedCaseToolCallSchema = z
  .strictObject({
    toolName: z.literal("inspect-masked-case"),
    toolCallId: agentToolCallIdSchema,
  })
  .readonly();
const searchOfficialLawToolCallSchema = z
  .strictObject({
    toolName: z.literal("search-official-law"),
    toolCallId: agentToolCallIdSchema,
    query: boundedText,
    basisObservationDigest: observationDigestSchema.optional(),
  })
  .readonly();
const readOfficialLawDetailToolCallSchema = z
  .strictObject({
    toolName: z.literal("read-official-law-detail"),
    toolCallId: agentToolCallIdSchema,
    citationId: koreanLawCitationIdSchema,
  })
  .readonly();
const computeEvidenceGapsToolCallSchema = z
  .strictObject({
    toolName: z.literal("compute-evidence-gaps"),
    toolCallId: agentToolCallIdSchema,
  })
  .readonly();
const writeLocalDraftToolCallSchema = z
  .strictObject({
    toolName: z.literal("write-local-draft"),
    toolCallId: agentToolCallIdSchema,
    artifactKind: z.union([z.literal("civil-demand"), z.literal("criminal-complaint")]),
    contentDigest: observationDigestSchema,
  })
  .readonly();
const requestUserInputToolCallSchema = z
  .strictObject({
    toolName: z.literal("request-user-input"),
    toolCallId: agentToolCallIdSchema,
    field: z.union([z.literal("case-fact"), z.literal("evidence-gap")]),
  })
  .readonly();
const requestUserActionToolCallSchema = z
  .strictObject({
    toolName: z.literal("request-user-action"),
    toolCallId: agentToolCallIdSchema,
    action: z.union([z.literal("review-draft"), z.literal("approve-filing")]),
  })
  .readonly();
export const agentToolCallSchema = z.discriminatedUnion("toolName", [
  inspectMaskedCaseToolCallSchema,
  searchOfficialLawToolCallSchema,
  readOfficialLawDetailToolCallSchema,
  computeEvidenceGapsToolCallSchema,
  writeLocalDraftToolCallSchema,
  requestUserInputToolCallSchema,
  requestUserActionToolCallSchema,
]);
export type AgentToolCall = z.infer<typeof agentToolCallSchema>;

export const agentCitationProvenanceSchema = z
  .strictObject({
    citationId: koreanLawCitationIdSchema,
    sourceUrl: officialKoreanLawUrlSchema,
    law: z.string().trim().min(1).max(160),
    versionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    retrievedAt: z
      .string()
      .max(64)
      .regex(/^\d{4}-\d{2}-\d{2}T/),
    toolName: z.enum(["search_law", "get_law_text"]),
    resultDigest: observationDigestSchema,
  })
  .readonly();
export type AgentCitationProvenance = z.infer<typeof agentCitationProvenanceSchema>;

const toolResult = <TToolName extends AgentToolCall["toolName"]>(toolName: TToolName) =>
  z
    .strictObject({
      toolName: z.literal(toolName),
      toolCallId: agentToolCallIdSchema,
      outcome: z.union([z.literal("completed"), z.literal("unavailable"), z.literal("rejected")]),
      observationDigest: observationDigestSchema,
      citationIds: z
        .array(koreanLawCitationIdSchema)
        .max(24)
        .refine((ids) => new Set(ids).size === ids.length)
        .default([])
        .readonly(),
      citations: z.array(agentCitationProvenanceSchema).max(24).default([]).readonly(),
    })
    .readonly();
const draftToolResultSchema = toolResult("write-local-draft")
  .unwrap()
  .extend({ artifactId: agentArtifactIdSchema.optional() })
  .readonly();

export const agentToolResultSchema = z.discriminatedUnion("toolName", [
  toolResult("inspect-masked-case"),
  toolResult("search-official-law"),
  toolResult("read-official-law-detail"),
  toolResult("compute-evidence-gaps"),
  draftToolResultSchema,
  toolResult("request-user-input"),
  toolResult("request-user-action"),
]);
export type AgentToolResult = z.infer<typeof agentToolResultSchema>;

export const approvalRequestSchema = z
  .strictObject({
    approvalId: approvalIdSchema,
    approvalDigest: approvalDigestSchema,
    caseId: caseIdSchema,
    decisionId: agentDecisionIdSchema,
    action: z.union([z.literal("review-draft"), z.literal("approve-filing")]),
    contextDigest: contextDigestSchema,
  })
  .readonly();
export type ApprovalRequest = z.infer<typeof approvalRequestSchema>;

export const approvalDecisionSchema = z
  .strictObject({
    approvalId: approvalIdSchema,
    approvalDigest: approvalDigestSchema,
    outcome: z.union([z.literal("approved"), z.literal("denied")]),
  })
  .readonly();
export type ApprovalDecision = z.infer<typeof approvalDecisionSchema>;

const toolDecisionSchema = z
  .strictObject({
    kind: z.literal("tool"),
    decisionId: agentDecisionIdSchema,
    toolCall: agentToolCallSchema,
  })
  .readonly();
const approvalDecisionRequestSchema = z
  .strictObject({
    kind: z.literal("request-approval"),
    decisionId: agentDecisionIdSchema,
    approval: approvalRequestSchema,
  })
  .readonly();
const finishDecisionSchema = z
  .strictObject({
    kind: z.literal("finish"),
    decisionId: agentDecisionIdSchema,
    outcome: terminalOutcomeSchema,
  })
  .readonly();
export const agentDecisionSchema = z.discriminatedUnion("kind", [
  toolDecisionSchema,
  approvalDecisionRequestSchema,
  finishDecisionSchema,
]);
export type AgentDecision = z.infer<typeof agentDecisionSchema>;

const decisionStartedStepSchema = z
  .strictObject({
    kind: z.literal("decision-started"),
    stepId: agentStepIdSchema,
    decisionId: agentDecisionIdSchema,
  })
  .readonly();
const decisionRecordedStepSchema = z
  .strictObject({
    kind: z.literal("decision-recorded"),
    stepId: agentStepIdSchema,
    decision: agentDecisionSchema,
  })
  .readonly();
const toolStartedStepSchema = z
  .strictObject({
    kind: z.literal("tool-started"),
    stepId: agentStepIdSchema,
    decisionId: agentDecisionIdSchema,
    toolCall: agentToolCallSchema,
  })
  .readonly();
const toolFinishedStepSchema = z
  .strictObject({
    kind: z.literal("tool-finished"),
    stepId: agentStepIdSchema,
    result: agentToolResultSchema,
  })
  .readonly();
const approvalRequestedStepSchema = z
  .strictObject({
    kind: z.literal("approval-requested"),
    stepId: agentStepIdSchema,
    approval: approvalRequestSchema,
  })
  .readonly();
const approvalDecidedStepSchema = z
  .strictObject({
    kind: z.literal("approval-decided"),
    stepId: agentStepIdSchema,
    decision: approvalDecisionSchema,
  })
  .readonly();
const interruptedStepSchema = z
  .strictObject({
    kind: z.literal("interrupted"),
    stepId: agentStepIdSchema,
    interruption: interruptionSchema,
  })
  .readonly();
const terminalStepSchema = z
  .strictObject({
    kind: z.literal("terminal"),
    stepId: agentStepIdSchema,
    outcome: terminalOutcomeSchema,
  })
  .readonly();
export const agentStepSchema = z.discriminatedUnion("kind", [
  decisionStartedStepSchema,
  decisionRecordedStepSchema,
  toolStartedStepSchema,
  toolFinishedStepSchema,
  approvalRequestedStepSchema,
  approvalDecidedStepSchema,
  interruptedStepSchema,
  terminalStepSchema,
]);
export type AgentStep = z.infer<typeof agentStepSchema>;
