const steps = ["사건 접수", "증빙 확인", "민·형사 준비", "집행 준비"] as const;

export function Topbar() {
  return (
    <header className="topbar">
      <div className="brand-lockup">
        <span aria-hidden="true" className="brand-sigil">
          소
        </span>
        <div className="brand-mark">소액사기 사건 코파일럿</div>
      </div>
      <div className="privacy-badge">원본 로컬 보관 · 외부 전송 전 마스킹</div>
    </header>
  );
}

export function ProgressRail({ activeStep }: { readonly activeStep: number }) {
  return (
    <aside className="rail" aria-label="사건 진행 단계">
      <p className="rail-label">CASE ROUTE</p>
      <ol>
        {steps.map((step, index) => (
          <li
            aria-current={index === activeStep ? "step" : undefined}
            className={index < activeStep ? "complete" : ""}
            data-testid={`progress-step-${index + 1}`}
            key={step}
          >
            <span className="step-number">{index + 1}</span>
            {step}
          </li>
        ))}
      </ol>
      <div className="rail-note">
        <strong>사용자가 최종 결정합니다.</strong>
        <p>로그인, 본인인증, 제출과 비용 납부는 공식 사이트에서 직접 진행합니다.</p>
      </div>
    </aside>
  );
}
