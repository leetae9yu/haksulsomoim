import {
  type AgentDecision,
  type AgentRun,
  type AgentToolCall,
  type AgentToolResult,
  type ApprovalRequest,
  agentDecisionSchema,
} from "./agent-contracts";

export function parseAndRebindAgentDecision(
  raw: unknown,
  decisionId: string,
  caseId: string,
  contextDigest: string,
): AgentDecision | undefined {
  const parsed = agentDecisionSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const decision = parsed.data;
  if (decision.kind === "tool") {
    if (String(decision.decisionId) === String(decision.toolCall.toolCallId)) return undefined;
    return agentDecisionSchema.parse({ ...decision, decisionId });
  }
  if (decision.kind === "finish") {
    if (decision.outcome.kind !== "completed") return undefined;
    return agentDecisionSchema.parse({ ...decision, decisionId });
  }
  if (
    decision.approval.decisionId !== decision.decisionId ||
    decision.approval.caseId !== caseId ||
    decision.approval.contextDigest !== contextDigest ||
    String(decision.approval.approvalId) === String(decision.decisionId)
  ) {
    return undefined;
  }
  return agentDecisionSchema.parse({
    ...decision,
    decisionId,
    approval: { ...decision.approval, decisionId },
  });
}

export type ToolCallHistory =
  | Readonly<{ kind: "new" }>
  | Readonly<{ kind: "duplicate-result"; result: AgentToolResult }>
  | Readonly<{ kind: "collision" }>;

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function classifyToolCall(run: AgentRun, call: AgentToolCall): ToolCallHistory {
  let matchedCall: AgentToolCall | undefined;
  let matchedResult: AgentToolResult | undefined;
  for (const step of run.steps) {
    if (step.kind === "tool-started" && step.toolCall.toolCallId === call.toolCallId) {
      matchedCall = step.toolCall;
    }
    if (step.kind === "tool-finished" && step.result.toolCallId === call.toolCallId) {
      matchedResult = step.result;
    }
  }
  if (matchedCall === undefined) return { kind: "new" };
  if (!same(matchedCall, call) || matchedResult === undefined) return { kind: "collision" };
  return { kind: "duplicate-result", result: matchedResult };
}

export function toolResults(run: AgentRun): readonly AgentToolResult[] {
  return run.steps.flatMap((step) => (step.kind === "tool-finished" ? [step.result] : []));
}

export function pendingApproval(run: AgentRun): ApprovalRequest | undefined {
  const decided = new Set(
    run.steps.flatMap((step) =>
      step.kind === "approval-decided" ? [step.decision.approvalId] : [],
    ),
  );
  for (let index = run.steps.length - 1; index >= 0; index -= 1) {
    const step = run.steps[index];
    if (step?.kind === "approval-requested" && !decided.has(step.approval.approvalId)) {
      return step.approval;
    }
  }
  return undefined;
}
