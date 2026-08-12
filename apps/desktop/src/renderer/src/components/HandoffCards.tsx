import { OfficialLink } from "./OfficialLink";

export function HandoffCards() {
  return (
    <section className="handoff-section reveal" aria-labelledby="handoff-title">
      <span className="section-number">HANDOFF</span>
      <h2 id="handoff-title">공식 사이트로 넘기기 전 점검</h2>
      <p className="section-copy">
        준비 목적과 자료를 확인한 뒤, 본인인증과 최종 제출은 공식 사이트에서 직접 진행하세요.
      </p>
      <div className="handoff-grid">
        <article className="handoff-card">
          <span className="track-kicker">ECRM</span>
          <h3>형사 접수 인계</h3>
          <dl>
            <dt>목적</dt>
            <dd>고소·진정 접수와 피해 경위 전달</dd>
            <dt>준비물</dt>
            <dd>확인된 이체내역, 대화 캡처, 피해 경위, 상대방 정보, 신분 확인 자료</dd>
          </dl>
          <p className="final-submit-note">
            본인인증, 문서 검토, 최종 제출은 ECRM 또는 경찰서에서 사용자가 직접 합니다.
          </p>
          <OfficialLink url="https://ecrm.police.go.kr">ECRM 공식 사이트 열기</OfficialLink>
        </article>
        <article className="handoff-card">
          <span className="track-kicker">COURT</span>
          <h3>민사 신청 인계</h3>
          <dl>
            <dt>목적</dt>
            <dd>지급명령 또는 소액사건 신청과 이후 송달·확정 확인</dd>
            <dt>준비물</dt>
            <dd>청구원인, 송금 증빙, 상대방 정보, 송달 주소, 법원에서 요구하는 첨부자료</dd>
          </dl>
          <p className="final-submit-note">
            본인인증, 비용 납부, 최종 제출은 대한민국 법원 공식 사이트에서 사용자가 직접 합니다.
          </p>
          <OfficialLink url="https://scourt.go.kr">대한민국 법원 공식 사이트 열기</OfficialLink>
        </article>
      </div>
      <p className="no-guarantee">
        이 안내는 절차 준비를 돕는 도구이며 피해금 회수, 수사 결과 또는 재판 결과를 보장하지
        않습니다.
      </p>
    </section>
  );
}
