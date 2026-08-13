import type { RefObject } from "react";
import type { AgentRunProjection } from "../../contracts/desktop-api";
import { AgentProviderStatus } from "./AgentProviderStatus";
import { AgentTimeline } from "./AgentTimeline";
import {
  type AgentProviderState,
  type AgentUiStatus,
  needsUserInput,
  statusMessage,
} from "./agent-workspace-state";

type GoalChoice = "civil" | "criminal" | undefined;

interface AgentWorkspaceViewProps {
  readonly approvalRef: RefObject<HTMLDivElement | null>;
  readonly busy: boolean;
  readonly caseId: string;
  readonly consent: boolean;
  readonly contextDigest: string;
  readonly error: string;
  readonly goal: GoalChoice;
  readonly inputValue: string;
  readonly officialCitationCount: number;
  readonly projection: AgentRunProjection | undefined;
  readonly provider: AgentProviderState;
  readonly providerBusy: boolean;
  readonly status: AgentUiStatus;
  readonly onApproval: (outcome: "approved" | "denied") => void;
  readonly onCancel: () => void;
  readonly onConsent: (value: boolean) => void;
  readonly onGoal: (value: Exclude<GoalChoice, undefined>) => void;
  readonly onInput: (value: string) => void;
  readonly onLogin: () => void;
  readonly onOpenLogin: () => void;
  readonly onPause: () => void;
  readonly onRefresh: () => void;
  readonly onResume: () => void;
  readonly onStart: () => void;
}

export function AgentWorkspaceView(props: AgentWorkspaceViewProps) {
  const canStart =
    props.goal !== undefined &&
    props.consent &&
    props.provider.status === "authenticated" &&
    !props.busy &&
    (props.projection === undefined || props.projection.state.kind === "terminal");
  const active = props.projection?.state.kind === "active";
  const resumable =
    props.projection?.state.kind === "paused" || props.projection?.state.kind === "interrupted";
  const pendingApproval = props.projection?.pendingApproval;

  return (
    <section
      className="agent-workspace"
      data-agent-provider={props.provider.status}
      data-agent-status={props.status}
      data-case-id={props.caseId}
      data-testid="agent-workspace"
      aria-labelledby="agent-workspace-title"
    >
      <header className="agent-workspace-header">
        <div>
          <span className="panel-kicker">CASE AGENT · HOST CONTROLLED</span>
          <h3 id="agent-workspace-title">사건 Agent 작업공간</h3>
          <p>채팅이 아니라 목표, 도구 기록, 공식 근거와 사용자 결정 경계를 순서대로 관리합니다.</p>
        </div>
        <div className="agent-status-orb" aria-hidden="true">
          <span />
          LOCAL
        </div>
      </header>

      <div className="agent-provider-bar">
        <AgentProviderStatus
          busy={props.providerBusy}
          onLogin={props.onLogin}
          onOpenLogin={props.onOpenLogin}
          onRefresh={props.onRefresh}
          state={props.provider}
        />
      </div>

      <div className="agent-status-banner" data-state={props.status}>
        <span className="agent-status-mark" aria-hidden="true" />
        <strong>{statusMessage(props.status)}</strong>
      </div>
      <p
        className="visually-hidden"
        data-testid="agent-announcement"
        role="status"
        aria-live="polite"
      >
        {statusMessage(props.status)}
      </p>

      <fieldset className="agent-goal-fieldset" disabled={props.busy || active}>
        <legend>1. 사건 목표 선택</legend>
        <div className="agent-goal-grid">
          <label className="agent-goal-card civil" data-testid="agent-civil-track">
            <input
              aria-label="민사 회수"
              checked={props.goal === "civil"}
              name="agent-goal"
              onChange={() => props.onGoal("civil")}
              type="radio"
            />
            <span className="track-kicker">CIVIL RECOVERY</span>
            <strong>민사 회수</strong>
            <small>지급명령과 회수 요구 초안 준비</small>
          </label>
          <label className="agent-goal-card criminal" data-testid="agent-criminal-track">
            <input
              aria-label="형사 고소 준비"
              checked={props.goal === "criminal"}
              name="agent-goal"
              onChange={() => props.onGoal("criminal")}
              type="radio"
            />
            <span className="track-kicker">CRIMINAL COMPLAINT</span>
            <strong>형사 고소 준비</strong>
            <small>확인된 사실을 기반으로 고소 자료 준비</small>
          </label>
        </div>
      </fieldset>

      <div className="agent-consent-panel">
        <div>
          <span className="panel-kicker">2. OUTBOUND CONSENT</span>
          <strong>현재 사건 컨텍스트 지문</strong>
          <code title={props.contextDigest}>{props.contextDigest.slice(0, 16)}…</code>
          <small>확인된 증거 지문 · 공식 근거 {props.officialCitationCount}건</small>
        </div>
        <label className="checkbox-row">
          <input
            checked={props.consent}
            disabled={props.busy || active}
            onChange={(event) => props.onConsent(event.target.checked)}
            type="checkbox"
          />
          <span>이 지문에 묶인 마스킹된 사건 컨텍스트 전송을 승인합니다</span>
        </label>
        <button
          data-testid="agent-start"
          disabled={!canStart}
          onClick={props.onStart}
          type="button"
        >
          {props.busy ? "Agent 확인 중…" : "Agent 실행 시작"}
        </button>
      </div>

      {props.projection !== undefined && (
        <>
          <dl className="agent-budget" aria-label="남은 실행 예산">
            <div>
              <dt>판단</dt>
              <dd>{props.projection.budget.decisionsRemaining}</dd>
            </div>
            <div>
              <dt>도구</dt>
              <dd>{props.projection.budget.toolsRemaining}</dd>
            </div>
            <div>
              <dt>시간</dt>
              <dd>{Math.ceil(props.projection.budget.durationMsRemaining / 60_000)}분</dd>
            </div>
          </dl>
          <fieldset className="agent-run-controls">
            <legend className="visually-hidden">Agent 실행 제어</legend>
            {active && (
              <button
                className="button-secondary"
                disabled={props.busy}
                onClick={props.onPause}
                type="button"
              >
                일시정지
              </button>
            )}
            {resumable && (
              <button disabled={props.busy} onClick={props.onResume} type="button">
                명시적으로 재개
              </button>
            )}
            {(active || resumable) && (
              <button
                className="agent-cancel"
                disabled={props.busy}
                onClick={props.onCancel}
                type="button"
              >
                실행 취소
              </button>
            )}
          </fieldset>
          {needsUserInput(props.projection) && resumable && (
            <label className="agent-input-panel">
              <span>Agent 질문에 답변</span>
              <textarea
                maxLength={2_000}
                onChange={(event) => props.onInput(event.target.value)}
                value={props.inputValue}
              />
              <small>확인한 사실만 2,000자 이하로 입력하세요. 재개할 때 전달됩니다.</small>
            </label>
          )}
          {pendingApproval !== null && pendingApproval !== undefined && (
            <div
              className="agent-approval"
              data-testid="agent-approval"
              ref={props.approvalRef}
              tabIndex={-1}
            >
              <span className="panel-kicker">USER BOUNDARY</span>
              <h4>
                {pendingApproval.action === "review-draft" ? "암호화 초안 검토" : "제출 행동 승인"}
              </h4>
              <p>승인 전에는 결과에 영향을 주는 행동을 실행하지 않습니다.</p>
              <div>
                <button
                  className="button-secondary"
                  disabled={props.busy}
                  onClick={() => props.onApproval("denied")}
                  type="button"
                >
                  거부
                </button>
                <button
                  disabled={props.busy}
                  onClick={() => props.onApproval("approved")}
                  type="button"
                >
                  승인
                </button>
              </div>
            </div>
          )}
          <AgentTimeline projection={props.projection} />
        </>
      )}
      {props.error.length > 0 && (
        <p className="notice error" role="alert">
          {props.error}
        </p>
      )}
    </section>
  );
}
