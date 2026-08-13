import type { AgentRecoveryControl } from "./use-agent-recovery";

export function agentStartControlLabel(recovery: AgentRecoveryControl, busy: boolean): string {
  if (recovery.issue === "unresolved-tool") return "안전 잠금으로 새 실행 차단";
  return busy ? "Agent 확인 중…" : "Agent 실행 시작";
}

export function AgentRecoveryNotice({
  error,
  recovery,
}: {
  readonly error: string;
  readonly recovery: AgentRecoveryControl;
}) {
  if (recovery.issue === undefined && !recovery.denied && error.length === 0) return null;
  return (
    <div data-testid="agent-recovery-boundary">
      {recovery.issue === "unresolved-tool" && (
        <section className="notice" data-testid="agent-unresolved-tool">
          <strong>이 사건의 Agent 실행이 안전하게 잠겨 있습니다.</strong>
          <p>이전 실행의 외부 도구 결과가 확인되지 않아 자동 재개와 새 실행을 차단했습니다.</p>
          <div className="agent-run-controls">
            <button
              className="button-secondary"
              data-testid="agent-recovery-recheck"
              disabled={recovery.checking}
              onClick={recovery.recheck}
              type="button"
            >
              {recovery.checking ? "안전 상태 확인 중…" : "중단된 실행 다시 확인"}
            </button>
          </div>
        </section>
      )}
      {recovery.denied && (
        <p className="notice error" data-testid="agent-recovery-denied" role="alert">
          확인되지 않은 외부 도구 작업 때문에 이 사건의 Agent 재개가 거부되었습니다.
        </p>
      )}
      {error.length > 0 && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
