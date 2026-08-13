import { z } from "zod";

const semanticId = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);

export const boundedText = z.string().trim().min(1).max(2_000);
export const caseIdSchema = semanticId.brand<"CaseId">();
export const agentRunIdSchema = semanticId.brand<"AgentRunId">();
export const agentStepIdSchema = semanticId.brand<"AgentStepId">();
export const agentDecisionIdSchema = semanticId.brand<"AgentDecisionId">();
export const agentToolCallIdSchema = semanticId.brand<"AgentToolCallId">();
export const agentArtifactIdSchema = semanticId.brand<"AgentArtifactId">();
export const approvalIdSchema = semanticId.brand<"ApprovalId">();
export const approvalDigestSchema = digest.brand<"ApprovalDigest">();
export const contextDigestSchema = digest.brand<"ContextDigest">();
export const observationDigestSchema = digest.brand<"ObservationDigest">();
export const koreanLawCitationIdSchema = semanticId.brand<"KoreanLawCitationId">();
const officialKoreanLawOrigins = new Set(["https://law.go.kr", "https://www.law.go.kr"]);
export const officialKoreanLawUrlSchema = z
  .string()
  .max(2_048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return officialKoreanLawOrigins.has(url.origin) && url.username === "" && url.password === "";
    } catch {
      return false;
    }
  }, "Citation must use an official Korean law HTTPS origin");

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
      z.literal("user-paused"),
    ]),
  })
  .readonly();
export type Interruption = z.infer<typeof interruptionSchema>;
