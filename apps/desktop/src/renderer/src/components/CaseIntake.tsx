import type { SyntheticEvent } from "react";
import type { CaseCreateResponse } from "../../../contracts/desktop-api";

type AcceptedCase = Extract<CaseCreateResponse, { status: "accepted" }>;

const amountFormatter = new Intl.NumberFormat("ko-KR", {
  style: "currency",
  currency: "KRW",
  maximumFractionDigits: 0,
});

export function Hero() {
  return (
    <div className="hero">
      <p className="eyebrow">국내 계좌이체 사기 · 피해금 3,000만 원 이하</p>
      <h1>
        놓치기 쉬운 절차를
        <br />
        확인 가능한 단계로 정리합니다.
      </h1>
      <p className="hero-copy">
        캡처는 이 PC에서 읽고, 사용자가 확인한 사실만 민사·형사 작업에 사용합니다.
      </p>
    </div>
  );
}

interface CaseIntakeProps {
  readonly amount: string;
  readonly busy: boolean;
  readonly error: string;
  readonly onAmountChange: (value: string) => void;
  readonly onSubmit: (event: SyntheticEvent<HTMLFormElement>) => void;
}

export function CaseIntake({ amount, busy, error, onAmountChange, onSubmit }: CaseIntakeProps) {
  return (
    <section className="intake-card" aria-labelledby="intake-title">
      <div>
        <span className="section-number">01</span>
        <h2 id="intake-title">사건 시작</h2>
        <p className="section-copy">피해금액을 입력하면 지원 범위를 먼저 확인합니다.</p>
      </div>
      <form aria-busy={busy} onSubmit={onSubmit}>
        <label htmlFor="amount">피해금액</label>
        <div className="amount-row">
          <span>₩</span>
          <input
            id="amount"
            inputMode="numeric"
            onChange={(event) => onAmountChange(event.target.value.replace(/\D/gu, ""))}
            placeholder="5,380,000"
            value={amount}
          />
          <button disabled={busy} type="submit">
            사건 시작
          </button>
        </div>
        {error.length > 0 && (
          <p className="notice error" role="alert">
            {error}
          </p>
        )}
      </form>
    </section>
  );
}

export function CaseSummary({ activeCase }: { readonly activeCase: AcceptedCase }) {
  return (
    <section className="case-strip reveal" aria-label="생성된 사건">
      <div>
        <span className="case-label">피해금</span>
        <strong>{amountFormatter.format(activeCase.amountKrw)}</strong>
      </div>
      <div>
        <span className="case-label">유형</span>
        <strong>국내 계좌이체 사기</strong>
      </div>
      <div>
        <span className="case-label">보관</span>
        <strong>이 PC의 암호화 금고</strong>
      </div>
    </section>
  );
}
