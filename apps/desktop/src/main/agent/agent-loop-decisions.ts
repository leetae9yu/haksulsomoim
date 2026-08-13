import { createHash } from "node:crypto";
import {
  type AgentDecision,
  type AgentRun,
  type AgentToolCall,
  type AgentToolResult,
  type ApprovalRequest,
  agentDecisionSchema,
  agentToolCallSchema,
} from "./agent-contracts";

export type AgentDecisionBindings = Readonly<{
  decisionId: string;
  toolCallId: string;
  approvalId: string;
  completionDigest: string;
}>;

export type ProviderToolCorrelation = Readonly<{ key: string }>;

export type ReboundAgentDecision = Readonly<{
  decision: AgentDecision;
  toolCorrelation?: ProviderToolCorrelation;
}>;

function digest(namespace: string, value: string): string {
  return createHash("sha256").update(namespace).update("\0").update(value).digest("hex");
}

export function createHostCompletionDigest(results: readonly AgentToolResult[]): string {
  return digest(
    "haksulsomoim:agent-completion:v1",
    JSON.stringify(results.map((result) => result.observationDigest)),
  );
}

function approvalDigest(
  bindings: AgentDecisionBindings,
  caseId: string,
  action: string,
  contextDigest: string,
): string {
  return digest(
    "haksulsomoim:agent-approval:v1",
    JSON.stringify({
      approvalId: bindings.approvalId,
      decisionId: bindings.decisionId,
      caseId,
      action,
      contextDigest,
    }),
  );
}

export function parseAndRebindAgentDecision(
  raw: unknown,
  bindings: AgentDecisionBindings,
  caseId: string,
  contextDigest: string,
): ReboundAgentDecision | undefined {
  const parsed = agentDecisionSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const decision = parsed.data;
  if (decision.kind === "tool") {
    if (String(decision.decisionId) === String(decision.toolCall.toolCallId)) return undefined;
    return {
      decision: agentDecisionSchema.parse({
        ...decision,
        decisionId: bindings.decisionId,
        toolCall: { ...decision.toolCall, toolCallId: bindings.toolCallId },
      }),
      toolCorrelation: {
        key: digest("haksulsomoim:provider-tool-correlation:v1", decision.toolCall.toolCallId),
      },
    };
  }
  if (decision.kind === "finish") {
    if (decision.outcome.kind !== "completed") return undefined;
    return {
      decision: agentDecisionSchema.parse({
        ...decision,
        decisionId: bindings.decisionId,
        outcome: { ...decision.outcome, summaryDigest: bindings.completionDigest },
      }),
    };
  }
  if (
    decision.approval.decisionId !== decision.decisionId ||
    decision.approval.caseId !== caseId ||
    decision.approval.contextDigest !== contextDigest ||
    String(decision.approval.approvalId) === String(decision.decisionId)
  ) {
    return undefined;
  }
  return {
    decision: agentDecisionSchema.parse({
      ...decision,
      decisionId: bindings.decisionId,
      approval: {
        ...decision.approval,
        approvalId: bindings.approvalId,
        approvalDigest: approvalDigest(bindings, caseId, decision.approval.action, contextDigest),
        decisionId: bindings.decisionId,
      },
    }),
  };
}

export type ToolCorrelationBinding = Readonly<{
  contentDigest: string;
  toolCallId: string;
}>;

export type ToolCorrelationResolution =
  | Readonly<{ kind: "new"; call: AgentToolCall; binding: ToolCorrelationBinding }>
  | Readonly<{ kind: "duplicate"; call: AgentToolCall }>
  | Readonly<{ kind: "collision" }>;

function toolContentDigest(call: AgentToolCall): string {
  return createHash("sha256")
    .update(JSON.stringify(call, (key, value) => (key === "toolCallId" ? undefined : value)))
    .digest("hex");
}

export function resolveToolCorrelation(
  bindings: ReadonlyMap<string, ToolCorrelationBinding>,
  correlation: ProviderToolCorrelation,
  call: AgentToolCall,
): ToolCorrelationResolution {
  const contentDigest = toolContentDigest(call);
  const existing = bindings.get(correlation.key);
  if (existing !== undefined) {
    if (existing.contentDigest !== contentDigest) return { kind: "collision" };
    return {
      kind: "duplicate",
      call: agentToolCallSchema.parse({ ...call, toolCallId: existing.toolCallId }),
    };
  }
  if ([...bindings.values()].some((binding) => binding.toolCallId === call.toolCallId)) {
    return { kind: "collision" };
  }
  return {
    kind: "new",
    call,
    binding: { contentDigest, toolCallId: call.toolCallId },
  };
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
