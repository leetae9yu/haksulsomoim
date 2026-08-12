import type {
  CivilTransitionRequest,
  CriminalTransitionRequest,
  WorkflowSnapshot,
} from "../../../contracts/desktop-api";

const criminalLabels: Record<WorkflowSnapshot["criminalState"], string> = {
  "evidence-review": "증거 검토",
  "complaint-ready": "고소장 준비 완료",
  "complaint-filed": "고소 제출 확인",
};

const civilLabels: Record<WorkflowSnapshot["civilState"], string> = {
  "pre-filing": "신청 전",
  "payment-order-pending": "지급명령 진행 중",
  "service-attested": "송달 확인",
  "judgment-recorded": "판결·결정 확인",
  "enforceable-title-confirmed": "확정 확인",
};

interface ProcedureTracksProps {
  readonly workflow: WorkflowSnapshot;
  readonly criminalBusy: boolean;
  readonly civilBusy: boolean;
  readonly criminalError: string;
  readonly civilError: string;
  readonly onCriminal: (command: CriminalTransitionRequest["command"]) => void;
  readonly onCivil: (command: CivilTransitionRequest["command"]) => void;
}

export function ProcedureTracks({
  workflow,
  criminalBusy,
  civilBusy,
  criminalError,
  civilError,
  onCriminal,
  onCivil,
}: ProcedureTracksProps) {
  return (
    <div className="track-grid">
      <article className="track-card criminal">
        <span className="track-kicker">CRIMINAL</span>
        <h3>형사 절차</h3>
        <strong>고소장·증거목록</strong>
        <p>범죄사실과 입금 흐름을 정리하고, 최종 제출 여부는 사용자가 직접 기록합니다.</p>
        <div
          className="state-pill"
          data-state={workflow.criminalState}
          data-testid="criminal-state"
        >
          {criminalLabels[workflow.criminalState]}
        </div>
        <div className="track-action">
          {workflow.criminalState === "evidence-review" && (
            <button
              disabled={criminalBusy}
              onClick={() => onCriminal("prepare-complaint")}
              type="button"
            >
              고소장 준비 시작
            </button>
          )}
          {workflow.criminalState === "complaint-ready" && (
            <>
              <p className="attestation-copy">
                공식 사이트나 경찰서에서 제출을 끝낸 경우에만 직접 확인하세요.
              </p>
              <button
                disabled={criminalBusy}
                onClick={() => onCriminal("file-complaint")}
                type="button"
              >
                고소장 제출 완료를 직접 확인
              </button>
            </>
          )}
          {workflow.criminalState === "complaint-filed" && (
            <span className="track-complete">사용자가 고소 제출을 확인했습니다.</span>
          )}
          {criminalError.length > 0 && (
            <p className="notice error" role="alert">
              {criminalError}
            </p>
          )}
        </div>
      </article>

      <article className="track-card civil">
        <span className="track-kicker">CIVIL</span>
        <h3>민사 절차</h3>
        <strong>지급명령·소액사건</strong>
        <p>신청, 송달, 판결·결정, 확정 사실을 공식 문서와 대조하며 한 단계씩 기록합니다.</p>
        <div className="state-pill" data-state={workflow.civilState} data-testid="civil-state">
          {civilLabels[workflow.civilState]}
        </div>
        <div className="track-action">
          <CivilAction busy={civilBusy} onCivil={onCivil} state={workflow.civilState} />
          {civilError.length > 0 && (
            <p className="notice error" role="alert">
              {civilError}
            </p>
          )}
        </div>
      </article>
    </div>
  );
}

function CivilAction({
  busy,
  onCivil,
  state,
}: {
  readonly busy: boolean;
  readonly onCivil: ProcedureTracksProps["onCivil"];
  readonly state: WorkflowSnapshot["civilState"];
}) {
  if (state === "enforceable-title-confirmed") {
    return <span className="track-complete">송달과 확정 사실을 사용자가 확인했습니다.</span>;
  }

  const actions = {
    "pre-filing": {
      command: "apply-payment-order",
      copy: "공식 법원 사이트에서 신청을 마친 경우에만 직접 확인하세요.",
      label: "지급명령 신청 완료를 직접 확인",
    },
    "payment-order-pending": {
      command: "attest-service",
      copy: "본인이 송달 내역을 공식 법원 문서에서 직접 확인한 경우에만 진행하세요.",
      label: "송달 완료를 직접 확인",
    },
    "service-attested": {
      command: "record-judgment",
      copy: "본인이 판결문 또는 지급명령 결정문을 수령해 직접 확인한 경우에만 진행하세요.",
      label: "판결·결정문 수령을 직접 확인",
    },
    "judgment-recorded": {
      command: "attest-finality",
      copy: "본인이 송달과 확정 여부를 공식 법원 문서에서 직접 확인한 경우에만 표시하세요.",
      label: "집행권원 확보로 표시",
    },
  } as const;
  const action = actions[state];
  return (
    <>
      <p className="attestation-copy">{action.copy}</p>
      <button disabled={busy} onClick={() => onCivil(action.command)} type="button">
        {action.label}
      </button>
    </>
  );
}
