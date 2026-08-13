import { z } from "zod";
import {
  agentBudgetLimits,
  agentBudgetSchema,
  agentGoalSchema,
  agentRunIdSchema,
  caseIdSchema,
  interruptionSchema,
  terminalOutcomeSchema,
} from "./agent-contracts-core";
import { agentStepSchema, approvalDecisionSchema, approvalRequestSchema } from "./agent-contracts-decisions";

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
