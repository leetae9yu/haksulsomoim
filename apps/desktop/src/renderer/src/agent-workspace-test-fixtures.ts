import { mock } from "bun:test";
import {
  type AgentApprovalDecisionIpcRequest,
  type AgentRunBinding,
  type AgentRunProjection,
  type AgentRunResumeRequest,
  type AgentRunStartIpcRequest,
  agentRunProjectionSchema,
  type DesktopApi,
} from "../../contracts/desktop-api";

export const contextDigest = "a".repeat(64);
const summaryDigest = "b".repeat(64);

export function completedProjection(
  caseId = "case-1",
  goal: AgentRunStartIpcRequest["goal"] = {
    kind: "civil-recovery",
    caseId,
    objective: "prepare-civil-demand",
  },
): AgentRunProjection {
  return agentRunProjectionSchema.parse({
    caseId,
    runId: `run-${caseId}`,
    goal,
    budget: { decisionsRemaining: 8, toolsRemaining: 5, durationMsRemaining: 238_000 },
    state: { kind: "terminal", outcome: { kind: "completed", summaryDigest } },
    lastStepId: "step-finish",
    pendingApproval: null,
    steps: [
      { kind: "tool-started", stepId: "step-inspect", toolName: "inspect-masked-case" },
      {
        kind: "tool-finished",
        stepId: "step-inspect-done",
        toolName: "inspect-masked-case",
        outcome: "completed",
      },
      { kind: "tool-started", stepId: "step-law", toolName: "search-official-law" },
      {
        kind: "tool-finished",
        stepId: "step-law-done",
        toolName: "search-official-law",
        outcome: "completed",
      },
      { kind: "terminal", stepId: "step-finish", outcome: { kind: "completed" } },
    ],
    citations: [
      {
        citationId: "law-1",
        stepId: "step-law-done",
        sourceUrl: "https://law.go.kr/법령/민사집행법",
        law: "민사집행법",
        versionDate: "2026-01-01",
        retrievedAt: "2026-08-11T00:00:00.000Z",
      },
    ],
  });
}

export function activeProjection(caseId = "case-1"): AgentRunProjection {
  return agentRunProjectionSchema.parse({
    ...completedProjection(caseId),
    budget: { decisionsRemaining: 11, toolsRemaining: 7, durationMsRemaining: 290_000 },
    state: { kind: "active" },
    lastStepId: "step-inspect-done",
    steps: completedProjection(caseId).steps.slice(0, 2),
    citations: [],
  });
}

export function approvalProjection(caseId = "case-1"): AgentRunProjection {
  return agentRunProjectionSchema.parse({
    ...activeProjection(caseId),
    state: { kind: "paused", reason: "approval-required" },
    lastStepId: "step-approval",
    pendingApproval: {
      approvalId: "approval-1",
      approvalDigest: contextDigest,
      contextDigest,
      action: "review-draft",
    },
    steps: [
      ...activeProjection(caseId).steps,
      { kind: "approval-requested", stepId: "step-approval", action: "review-draft" },
    ],
  });
}

export function installWorkspaceApi(overrides: Partial<DesktopApi> = {}) {
  const startAgentRun = mock(async (request: AgentRunStartIpcRequest) =>
    completedProjection(request.caseId, request.goal),
  );
  const pauseAgentRun = mock(async (request: AgentRunBinding) =>
    agentRunProjectionSchema.parse({
      ...activeProjection(request.caseId),
      state: { kind: "paused" as const, reason: "context-changed" as const },
    }),
  );
  const resumeAgentRun = mock(async (request: AgentRunResumeRequest) =>
    activeProjection(request.caseId),
  );
  const cancelAgentRun = mock(async (request: AgentRunBinding) =>
    agentRunProjectionSchema.parse({
      ...activeProjection(request.caseId),
      state: { kind: "interrupted" as const, interruption: { kind: "user-cancelled" as const } },
    }),
  );
  const decideAgentApproval = mock(async (request: AgentApprovalDecisionIpcRequest) =>
    agentRunProjectionSchema.parse({
      ...activeProjection(request.caseId),
      lastStepId: "step-approval-decided",
      steps: [
        ...activeProjection(request.caseId).steps,
        {
          kind: "approval-decided" as const,
          stepId: "step-approval-decided",
          outcome: request.outcome,
        },
      ],
    }),
  );
  const api: DesktopApi = {
    createCase: mock(async () => ({ status: "out-of-scope" as const, reason: "not used" })),
    analyzeEvidence: mock(async () => {
      throw new Error("not used");
    }),
    codexStatus: mock(async () => ({
      status: "authenticated" as const,
      account: { type: "chatgpt" as const, email: null, planType: "plus" },
    })),
    listAgentRuns: mock(async () => []),
    startAgentRun,
    pauseAgentRun,
    resumeAgentRun,
    cancelAgentRun,
    decideAgentApproval,
    subscribeAgentRun: mock(() => () => undefined),
    openOfficialSource: mock(async () => undefined),
    ...overrides,
  };
  Object.defineProperty(window, "haksul", { configurable: true, value: api });
  return { api, startAgentRun, pauseAgentRun, resumeAgentRun, cancelAgentRun, decideAgentApproval };
}
