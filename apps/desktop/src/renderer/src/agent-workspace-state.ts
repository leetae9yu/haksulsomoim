import type {
  AgentRunProjection,
  AgentStepSummary,
  CodexStatusResponse,
} from "../../contracts/desktop-api";

export type AgentProviderState =
  | Readonly<{ status: "checking" }>
  | Readonly<{ status: "manual" }>
  | Readonly<{ status: "sign-in-required" }>
  | Readonly<{ status: "login-ready"; authorizationUrl: string }>
  | Readonly<{ status: "authenticated"; planType: string }>
  | Readonly<{ status: "error" }>;

export type AgentUiStatus =
  | "idle"
  | "manual"
  | "running"
  | "awaiting-approval"
  | "consent-required"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted"
  | "unresolved-tool";

export function providerFromResponse(response: CodexStatusResponse): AgentProviderState {
  if (response.status === "offline") return { status: "manual" };
  if (response.status === "sign-in-required") return { status: "sign-in-required" };
  return { status: "authenticated", planType: response.account.planType.slice(0, 48) };
}

export function trustedLoginUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "auth.openai.com" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

export function agentUiStatus(
  provider: AgentProviderState,
  projection: AgentRunProjection | undefined,
): AgentUiStatus {
  if (projection === undefined) {
    return provider.status === "manual" || provider.status === "error" ? "manual" : "idle";
  }
  if (projection.state.kind === "active") return "running";
  if (projection.state.kind === "paused") {
    if (projection.pendingApproval !== null || projection.state.reason === "approval-required") {
      return "awaiting-approval";
    }
    if (
      projection.state.reason === "provider-unavailable" ||
      projection.state.reason === "tool-unavailable"
    )
      return "manual";
    if (projection.state.reason === "context-changed") return "consent-required";
    return "paused";
  }
  if (projection.state.kind === "interrupted") {
    return projection.state.interruption.kind === "user-cancelled" ? "cancelled" : "interrupted";
  }
  return projection.state.outcome.kind === "completed" ? "completed" : "failed";
}

const statusMessages: Record<AgentUiStatus, string> = {
  idle: "목표와 전송 동의를 확인하면 Agent를 시작할 수 있습니다.",
  manual: "Agent 연결을 사용할 수 없습니다. 수동 절차는 계속 사용할 수 있습니다.",
  running: "Agent가 허용된 로컬 도구와 공식 근거를 확인하고 있습니다.",
  "awaiting-approval": "결과에 영향을 주는 작업이 사용자 승인을 기다리고 있습니다.",
  "consent-required": "사건 컨텍스트가 변경되어 새 전송 동의가 필요합니다.",
  paused: "Agent 실행이 일시정지되었습니다.",
  completed: "Agent 실행이 완료되었습니다. 인용 근거와 결과를 확인하세요.",
  failed: "Agent 실행이 안전 경계에서 종료되었습니다. 수동 절차를 계속 이용할 수 있습니다.",
  cancelled: "Agent 실행을 취소했습니다.",
  interrupted: "Agent 실행이 중단되었습니다. 확인 후 명시적으로 재개하세요.",
  "unresolved-tool":
    "이전 실행의 외부 도구 결과가 확인되지 않아 이 사건의 Agent 실행이 안전하게 잠겨 있습니다.",
};

export const statusMessage = (status: AgentUiStatus): string => statusMessages[status];

const toolNames: Record<Extract<AgentStepSummary, { kind: "tool-started" }>["toolName"], string> = {
  "inspect-masked-case": "마스킹 사건 확인",
  "search-official-law": "공식 법령 검색",
  "read-official-law-detail": "공식 법령 원문 확인",
  "compute-evidence-gaps": "증거 누락 분석",
  "write-local-draft": "암호화 로컬 초안 작성",
  "request-user-input": "추가 사실 질문",
  "request-user-action": "사용자 조치 요청",
};

export const toolLabel = (toolName: keyof typeof toolNames): string => toolNames[toolName];

export function stepLabel(step: AgentStepSummary): string {
  switch (step.kind) {
    case "decision-started":
      return "다음 판단 준비";
    case "decision-recorded":
      return "안전한 다음 단계 결정";
    case "tool-started":
      return `${toolLabel(step.toolName)} 시작`;
    case "tool-finished":
      return `${toolLabel(step.toolName)} ${step.outcome === "completed" ? "완료" : "확인 필요"}`;
    case "approval-requested":
      return step.action === "review-draft" ? "초안 검토 승인 요청" : "제출 승인 요청";
    case "approval-decided":
      return step.outcome === "approved" ? "사용자 승인 기록" : "사용자 거부 기록";
    case "interrupted":
      return "실행 중단 기록";
    case "terminal":
      return step.outcome.kind === "completed" ? "실행 계획 완료" : "안전 경계 종료";
  }
}

export function needsUserInput(projection: AgentRunProjection): boolean {
  return projection.steps.some(
    (step) => step.kind === "tool-finished" && step.toolName === "request-user-input",
  );
}
