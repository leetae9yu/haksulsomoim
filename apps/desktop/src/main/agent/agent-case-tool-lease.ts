import { z } from "zod";
import { agentRunIdSchema, caseIdSchema } from "./agent-contracts-core";

export const agentToolLeaseSchema = z
  .strictObject({
    caseId: caseIdSchema,
    runId: agentRunIdSchema,
    stepId: z.string().min(1).max(160),
    toolExecutionToken: z.string().min(1).max(160),
    startedAt: z.number().int().nonnegative(),
    deadline: z.number().int().nonnegative(),
    state: z.enum(["executing", "quarantined"]),
  })
  .readonly();

export type AgentToolLease = z.infer<typeof agentToolLeaseSchema>;
export type AgentToolLeaseIdentity = Pick<
  AgentToolLease,
  "caseId" | "runId" | "stepId" | "toolExecutionToken"
>;
export type AgentToolLeaseTransition =
  | Readonly<{ kind: "executing"; lease: AgentToolLease }>
  | Readonly<{ kind: "settled" | "quarantined"; lease: AgentToolLeaseIdentity }>;

export function sameToolLease(lease: AgentToolLease, expected: AgentToolLeaseIdentity): boolean {
  return (
    lease.caseId === expected.caseId &&
    lease.runId === expected.runId &&
    lease.stepId === expected.stepId &&
    lease.toolExecutionToken === expected.toolExecutionToken
  );
}
