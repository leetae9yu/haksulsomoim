import type { AgentRunProjection, AgentStepSummary } from "../../contracts/desktop-api";
import { stepLabel } from "./agent-workspace-state";
import { OfficialLink } from "./components/OfficialLink";

function stepMeta(step: AgentStepSummary): string {
  if (step.kind === "tool-finished") {
    if (step.outcome === "completed") return "호스트가 결과를 검증해 기록했습니다.";
    return "도구 결과를 사용할 수 없어 수동 확인이 필요합니다.";
  }
  if (step.kind === "approval-requested")
    return "사용자 결정 전에는 다음 행동을 실행하지 않습니다.";
  if (step.kind === "approval-decided") return "결정은 실행 기록에 순서대로 남습니다.";
  if (step.kind === "interrupted") return "자동 반복 없이 명시적 재개를 기다립니다.";
  if (step.kind === "terminal") return "허용된 범위의 실행이 종료되었습니다.";
  return "호스트가 순서와 예산을 확인했습니다.";
}

export function AgentTimeline({ projection }: { readonly projection: AgentRunProjection }) {
  const hasDraft = projection.steps.some(
    (step) =>
      step.kind === "tool-finished" &&
      step.toolName === "write-local-draft" &&
      step.outcome === "completed",
  );
  const completed =
    projection.state.kind === "terminal" && projection.state.outcome.kind === "completed";

  return (
    <section className="agent-timeline-panel" aria-labelledby="agent-timeline-title">
      <div className="agent-subheading">
        <div>
          <span className="panel-kicker">ORDERED TRACE</span>
          <h4 id="agent-timeline-title">실행 타임라인</h4>
        </div>
        <span className="agent-step-count">{projection.steps.length}개 기록</span>
      </div>
      {projection.steps.length === 0 ? (
        <p className="agent-empty">아직 기록된 실행 단계가 없습니다.</p>
      ) : (
        <ol className="agent-timeline">
          {projection.steps.map((step, index) => (
            <li
              data-agent-step={step.stepId}
              {...(step.kind === "tool-finished" ? { "data-agent-tool": step.toolName } : {})}
              key={step.stepId}
            >
              <span className="agent-step-index" aria-hidden="true">
                {String(index + 1).padStart(2, "0")}
              </span>
              <div>
                <strong>{stepLabel(step)}</strong>
                <p>{stepMeta(step)}</p>
              </div>
            </li>
          ))}
        </ol>
      )}
      {hasDraft && (
        <details className="agent-artifact" data-agent-artifact="encrypted-draft">
          <summary>암호화 초안 상태 보기</summary>
          <p>초안은 이 앱의 암호화 저장소에만 보관되며 외부 파일 경로를 노출하지 않습니다.</p>
        </details>
      )}
      {completed && (
        <section className="agent-final-plan" aria-label="인용된 최종 실행 계획">
          <span className="panel-kicker">CITED PLAN</span>
          <h4>인용된 최종 실행 계획</h4>
          <p>아래 공식 근거를 대조한 뒤 제출과 법적 확인은 사용자가 직접 진행합니다.</p>
          {projection.citations.length === 0 ? (
            <p className="agent-empty">연결된 공식 근거가 없어 수동 대조가 필요합니다.</p>
          ) : (
            <ul className="agent-citation-links">
              {projection.citations.map((citation) => (
                <li
                  data-agent-citation={citation.citationId}
                  data-agent-citation-step={citation.stepId}
                  key={citation.citationId}
                >
                  <strong>{citation.law}</strong>
                  <span>
                    기준일 {citation.versionDate} · 조회 {citation.retrievedAt}
                  </span>
                  <OfficialLink url={citation.sourceUrl}>
                    {citation.law} 공식 원문 열기
                  </OfficialLink>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </section>
  );
}
