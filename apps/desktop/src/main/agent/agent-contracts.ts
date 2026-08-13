import { z } from "zod";

const semanticId = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const boundedText = z.string().trim().min(1).max(2_000);

const caseIdSchema = semanticId.brand<"CaseId">();
const agentRunIdSchema = semanticId.brand<"AgentRunId">();
const agentStepIdSchema = semanticId.brand<"AgentStepId">();
const agentDecisionIdSchema = semanticId.brand<"AgentDecisionId">();
const agentToolCallIdSchema = semanticId.brand<"AgentToolCallId">();
const approvalIdSchema = semanticId.brand<"ApprovalId">();
const approvalDigestSchema = digest.brand<"ApprovalDigest">();
const contextDigestSchema = digest.brand<"ContextDigest">();
const observationDigestSchema = digest.brand<"ObservationDigest">();

export const agentBudgetLimits = Object.freeze({
  decisions: 12,
  tools: 8,
  durationMs: 300_000,
});

export const agentBudgetSchema = z
  .strictObject({
    decisionsRemaining: z.number().int().min(0).max(agentBudgetLimits.decisions),
    toolsRemaining: z.number().int().min(0).max(agentBudgetLimits.tools),
    durationMsRemaining: z.number().int().min(0).max(agentBudgetLimits.durationMs),
  })
  .readonly();
export type AgentBudget = z.infer<typeof agentBudgetSchema>;

const civilGoalSchema = z
  .strictObject({
    kind: z.literal("civil-recovery"),
    caseId: caseIdSchema,
    objective: z.literal("prepare-civil-demand"),
  })
  .readonly();
const criminalGoalSchema = z
  .strictObject({
    kind: z.literal("criminal-complaint"),
    caseId: caseIdSchema,
    objective: z.literal("prepare-criminal-complaint"),
  })
  .readonly();
export const agentGoalSchema = z.discriminatedUnion("kind", [civilGoalSchema, criminalGoalSchema]);
export type AgentGoal = z.infer<typeof agentGoalSchema>;

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
  })
  .readonly();
const readOfficialLawDetailToolCallSchema = z
  .strictObject({
    toolName: z.literal("read-official-law-detail"),
    toolCallId: agentToolCallIdSchema,
    citationId: semanticId.brand<"KoreanLawCitationId">(),
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

const toolResult = <TToolName extends AgentToolCall["toolName"]>(toolName: TToolName) =>
  z
    .strictObject({
      toolName: z.literal(toolName),
      toolCallId: agentToolCallIdSchema,
      outcome: z.union([z.literal("completed"), z.literal("unavailable"), z.literal("rejected")]),
      observationDigest: observationDigestSchema,
    })
    .readonly();

export const agentToolResultSchema = z.discriminatedUnion("toolName", [
  toolResult("inspect-masked-case"),
  toolResult("search-official-law"),
  toolResult("read-official-law-detail"),
  toolResult("compute-evidence-gaps"),
  toolResult("write-local-draft"),
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

const completedOutcomeSchema = z
  .strictObject({
    kind: z.literal("completed"),
    summaryDigest: observationDigestSchema,
  })
  .readonly();
const budgetExhaustedOutcomeSchema = z
  .strictObject({
    kind: z.literal("budget-exhausted"),
    exhausted: z.union([z.literal("decisions"), z.literal("tools"), z.literal("duration")]),
  })
  .readonly();
const failedPolicyOutcomeSchema = z
  .strictObject({
    kind: z.literal("failed-policy"),
    reason: z.union([
      z.literal("unknown-tool"),
      z.literal("stale-approval"),
      z.literal("context-changed"),
    ]),
  })
  .readonly();
export const terminalOutcomeSchema = z.discriminatedUnion("kind", [
  completedOutcomeSchema,
  budgetExhaustedOutcomeSchema,
  failedPolicyOutcomeSchema,
]);
export type TerminalOutcome = z.infer<typeof terminalOutcomeSchema>;

export const interruptionSchema = z
  .strictObject({
    kind: z.union([
      z.literal("user-cancelled"),
      z.literal("provider-timeout"),
      z.literal("application-restarted"),
    ]),
  })
  .readonly();
export type Interruption = z.infer<typeof interruptionSchema>;

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

const activeRunStateSchema = z.strictObject({ kind: z.literal("active") }).readonly();
const pausedRunStateSchema = z
  .strictObject({
    kind: z.literal("paused"),
    reason: z.union([
      z.literal("approval-required"),
      z.literal("provider-unavailable"),
      z.literal("context-changed"),
    ]),
  })
  .readonly();
const terminalRunStateSchema = z
  .strictObject({
    kind: z.literal("terminal"),
    outcome: terminalOutcomeSchema,
  })
  .readonly();
const interruptedRunStateSchema = z
  .strictObject({
    kind: z.literal("interrupted"),
    interruption: interruptionSchema,
  })
  .readonly();
const agentRunStateSchema = z.discriminatedUnion("kind", [
  activeRunStateSchema,
  pausedRunStateSchema,
  terminalRunStateSchema,
  interruptedRunStateSchema,
]);

export const agentRunSchema = z
  .strictObject({
    runId: agentRunIdSchema,
    caseId: caseIdSchema,
    goal: agentGoalSchema,
    budget: agentBudgetSchema,
    state: agentRunStateSchema,
    steps: z.array(agentStepSchema).max(41).readonly(),
  })
  .superRefine((run, context) => {
    if (run.caseId !== run.goal.caseId) {
      context.addIssue({
        code: "custom",
        message: "Agent run caseId must match its goal caseId",
        path: ["goal", "caseId"],
      });
    }

    const decisions = run.steps.filter((step) => step.kind === "decision-recorded").length;
    if (decisions > agentBudgetLimits.decisions) {
      context.addIssue({
        code: "custom",
        message: "Agent run exceeds the decision limit",
        path: ["steps"],
      });
    }

    const toolCalls = run.steps.filter((step) => step.kind === "tool-started").length;
    if (toolCalls > agentBudgetLimits.tools) {
      context.addIssue({
        code: "custom",
        message: "Agent run exceeds the tool limit",
        path: ["steps"],
      });
    }

    if (
      run.state.kind === "active" &&
      (run.budget.decisionsRemaining === 0 ||
        run.budget.toolsRemaining === 0 ||
        run.budget.durationMsRemaining === 0)
    ) {
      context.addIssue({
        code: "custom",
        message: "Active Agent runs require available budget",
        path: ["budget"],
      });
    }

    if (run.state.kind === "terminal" && run.state.outcome.kind === "budget-exhausted") {
      const exhaustedBudget = run.state.outcome.exhausted;
      const remaining =
        exhaustedBudget === "decisions"
          ? run.budget.decisionsRemaining
          : exhaustedBudget === "tools"
            ? run.budget.toolsRemaining
            : run.budget.durationMsRemaining;
      if (remaining !== 0) {
        context.addIssue({
          code: "custom",
          message: "Budget-exhausted runs require the named budget to be exhausted",
          path: ["budget"],
        });
      }
    }
  })
  .readonly();
export type AgentRun = z.infer<typeof agentRunSchema>;

export const activeAgentRunSchema = z
  .strictObject({
    caseId: caseIdSchema,
    run: agentRunSchema,
  })
  .superRefine((activeRun, context) => {
    if (activeRun.caseId !== activeRun.run.caseId) {
      context.addIssue({
        code: "custom",
        message: "Active Agent run caseId must match its run caseId",
        path: ["run", "caseId"],
      });
    }
    if (activeRun.run.state.kind !== "active") {
      context.addIssue({
        code: "custom",
        message: "Only active Agent runs may occupy a case slot",
        path: ["run", "state"],
      });
    }
  })
  .readonly();
export type ActiveAgentRun = z.infer<typeof activeAgentRunSchema>;

export const activeAgentRunsSchema = z
  .array(activeAgentRunSchema)
  .superRefine((activeRuns, context) => {
    const caseIds = new Set<string>();
    activeRuns.forEach((activeRun, index) => {
      if (caseIds.has(activeRun.caseId)) {
        context.addIssue({
          code: "custom",
          message: "Only one active Agent run is allowed per case",
          path: [index, "caseId"],
        });
      }
      caseIds.add(activeRun.caseId);
    });
  })
  .readonly();
export type ActiveAgentRuns = z.infer<typeof activeAgentRunsSchema>;

export const agentRunStartRequestSchema = z
  .strictObject({
    caseId: caseIdSchema,
    goal: agentGoalSchema,
  })
  .superRefine((request, context) => {
    if (request.caseId !== request.goal.caseId) {
      context.addIssue({
        code: "custom",
        message: "Agent run start caseId must match its goal caseId",
        path: ["goal", "caseId"],
      });
    }
  })
  .readonly();
export type AgentRunStartRequest = z.infer<typeof agentRunStartRequestSchema>;

export const agentApprovalDecisionRequestSchema = z
  .strictObject({
    approval: approvalRequestSchema,
    decision: approvalDecisionSchema,
  })
  .superRefine((request, context) => {
    if (request.approval.approvalId !== request.decision.approvalId) {
      context.addIssue({
        code: "custom",
        message: "Approval decision must reference the current approval ID",
        path: ["decision", "approvalId"],
      });
    }
    if (request.approval.approvalDigest !== request.decision.approvalDigest) {
      context.addIssue({
        code: "custom",
        message: "Approval decision must reference the current approval digest",
        path: ["decision", "approvalDigest"],
      });
    }
  })
  .readonly();
export type AgentApprovalDecisionRequest = z.infer<typeof agentApprovalDecisionRequestSchema>;

export const agentRunInterruptRequestSchema = z
  .strictObject({
    caseId: caseIdSchema,
    runId: agentRunIdSchema,
    interruption: interruptionSchema,
  })
  .readonly();
export type AgentRunInterruptRequest = z.infer<typeof agentRunInterruptRequestSchema>;
