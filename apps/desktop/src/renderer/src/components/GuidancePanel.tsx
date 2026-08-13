import { useEffect, useState } from "react";
import type { KoreanLawCitation } from "../../../contracts/desktop-api";
import { boundedMetadata, messages, safeHost } from "../renderer-state";
import { OfficialLink } from "./OfficialLink";

type GuidanceState =
  | Readonly<{ status: "loading" }>
  | Readonly<{ status: "ready"; citations: readonly KoreanLawCitation[] }>
  | Readonly<{ status: "manual"; message: string }>
  | Readonly<{ status: "error"; message: string }>;

const GUIDANCE_QUERY = "국내 계좌이체 소액사기 지급명령 송달 확정 강제집행 공식 법령";

export function GuidancePanel({
  caseId,
  onCitations,
}: {
  readonly caseId: string;
  readonly onCitations: (citations: readonly KoreanLawCitation[]) => void;
}) {
  const [state, setState] = useState<GuidanceState>({ status: "loading" });

  useEffect(() => {
    const guidance = window.haksul.guidance;
    if (guidance === undefined) {
      setState({ status: "manual", message: messages.guidanceUnavailable });
      onCitations([]);
      return;
    }
    let current = true;
    void guidance({ caseId, query: GUIDANCE_QUERY })
      .then((result) => {
        if (!current) return;
        if (result.status === "ok") {
          setState({ status: "ready", citations: result.citations });
          onCitations(result.citations);
          return;
        }
        onCitations([]);
        setState({
          status: result.status === "needs-credentials" ? "manual" : "error",
          message:
            result.status === "needs-credentials"
              ? "공식 근거 조회 설정이 없어 수동 확인이 필요합니다."
              : messages.guidanceFailed,
        });
      })
      .catch(() => {
        if (!current) return;
        onCitations([]);
        setState({ status: "error", message: messages.guidanceFailed });
      });
    return () => {
      current = false;
    };
  }, [caseId, onCitations]);

  return (
    <section className="guidance-panel" data-guidance-state={state.status}>
      <span className="panel-kicker">OFFICIAL BASIS</span>
      <h3>공식 근거 확인</h3>
      <p className="muted-copy">제목, 공식 출처, 기준일과 조회 시각을 함께 대조하세요.</p>
      {state.status === "loading" && <p role="status">공식 근거를 확인하고 있습니다…</p>}
      {(state.status === "manual" || state.status === "error") && (
        <p className="notice" role="status">
          {state.message}
        </p>
      )}
      {state.status === "ready" && (
        <div className="citation-list">
          {state.citations.length === 0 && (
            <p className="notice">인용 결과가 없어 공식 사이트에서 직접 확인해야 합니다.</p>
          )}
          {state.citations.map((citation) => {
            const host = safeHost(citation.sourceUrl);
            const title = boundedMetadata(citation.law);
            return (
              <article
                className="citation-card"
                data-checked={boundedMetadata(citation.retrievedAt)}
                data-source={host}
                data-testid={`citation-${citation.id}`}
                key={citation.id}
              >
                <strong>{title}</strong>
                <div className="citation-meta">
                  <span>출처 · 국가법령정보센터 ({host})</span>
                  <span>
                    확인 정보 · 기준일 {boundedMetadata(citation.versionDate)} · 조회{" "}
                    {boundedMetadata(citation.retrievedAt)}
                  </span>
                </div>
                <OfficialLink url={citation.sourceUrl}>{title} 공식 원문 열기</OfficialLink>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
