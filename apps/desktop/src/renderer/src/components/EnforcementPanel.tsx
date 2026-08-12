import { useEffect, useState } from "react";
import type {
  EnforcementChoice,
  EnforcementChoicesResponse,
  WorkflowSnapshot,
} from "../../../contracts/desktop-api";
import { messages } from "../renderer-state";
import { OfficialLink } from "./OfficialLink";

const kindLabels: Record<EnforcementChoice["kind"], string> = {
  "asset-inquiry": "재산조회",
  "seizure-and-collection": "압류·추심",
  "debtor-registry": "채무불이행자명부",
};

const conditionLabels: Record<EnforcementChoice["condition"], string> = {
  "enforceable-title-confirmed": "집행권원과 확정 확인",
  "attachable-asset-identified": "압류할 재산 특정",
  "statutory-requirements-met": "법정 요건 충족 확인",
};

export function EnforcementPanel({
  caseId,
  civilState,
}: {
  readonly caseId: string;
  readonly civilState: WorkflowSnapshot["civilState"];
}) {
  const [response, setResponse] = useState<EnforcementChoicesResponse>();
  const [error, setError] = useState("");

  useEffect(() => {
    setResponse(undefined);
    setError("");
    if (civilState !== "enforceable-title-confirmed") return;
    const loadChoices = window.haksul.enforcementChoices;
    if (loadChoices === undefined) {
      setError(messages.enforcementUnavailable);
      return;
    }
    let current = true;
    void loadChoices({ caseId })
      .then((result) => {
        if (!current) return;
        if (result.status === "ok") setResponse(result);
        else setError(messages.enforcementUnavailable);
      })
      .catch(() => {
        if (current) setError(messages.enforcementUnavailable);
      });
    return () => {
      current = false;
    };
  }, [caseId, civilState]);

  if (civilState !== "enforceable-title-confirmed") return null;
  if (response?.status !== "ok") {
    return error.length > 0 ? (
      <p className="notice error" role="alert">
        {error}
      </p>
    ) : (
      <p className="enforcement-loading" role="status">
        집행 선택지를 확인하고 있습니다…
      </p>
    );
  }

  return (
    <section className="enforcement-panel reveal" aria-labelledby="enforcement-title">
      <div>
        <span className="section-number">04</span>
        <h2 id="enforcement-title">판결 뒤 집행 검토</h2>
        <p>송달과 확정 사실을 확인한 뒤, 재산 상황과 법정 요건에 맞는 절차만 검토하세요.</p>
      </div>
      <ul>
        {response.choices.map((choice) => (
          <li key={choice.kind}>
            <strong>{kindLabels[choice.kind]}</strong>
            <span className="condition">{conditionLabels[choice.condition]}</span>
          </li>
        ))}
      </ul>
      <OfficialLink className="enforcement-link" url="https://law.go.kr/법령/민사집행법">
        민사집행법 근거 보기
      </OfficialLink>
    </section>
  );
}
