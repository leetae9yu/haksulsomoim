# LLM Wiki source research report

## Executive conclusion

이 Wiki는 고정 기준일 현재 대한민국 온라인 물품·용역 거래의 개인 청구를 위한 절차 참고 코퍼스이며, 원자 법리·절차 claim과 공개적으로 남긴 gap을 함께 보존한다. 이 코퍼스는 대상 이용자의 대표 결과를 입증하는 결과 데이터셋이 아니다 [CLM-SCOPE-9014].

이 자료는 **대표적 결과, 회수 가능성, 단축된 기간, 인과적 회수, 제품 효과를 어느 것도 입증하지 않는다.** 신고, 재판, 집행권원, 예방 정책 또는 사례 trace가 그 결론을 대신하지 않으며, 실제 지급은 별도 자료가 필요한 상태다 [CLM-STATISTICS-9013] [CLM-ENFORCEMENT-0012].

## Seed audit

Repository seed disposition SED-0001 sets seed_id P1, verdict augment, scope_fit context_only, and source_quality secondary. 이 행은 원문 사건 결과나 지급 결과가 아니라 동결 시드의 감사 처분이다 [CLM-AUDIT-d5a0c8c09d840457].

## Methodology and exact cutoff

**Research cutoff:** `2026-08-25T06:42:44Z`. Repository coverage COV-CIVIL-0009 sets lane CIVIL, cell civil-answer-deadline, and status verified [CLM-AUDIT-39b1e6fae3df657c].

방법은 공식 전문과 현재성 확인을 우선하고, 원자 claim을 source→observation→claim→verification 경로로 추적하는 방식이다. 원문 접근이 제한되었거나 비식별 trace만 있는 경우에는 verified로 승격하지 않고 reported, rejected 또는 gap 상태와 caveat를 유지했다 [CLM-EVIDENCE-5004] [CLM-STATISTICS-9003].

## Source hierarchy

| Tier | Use in this report | Publication ceiling | Claim anchor |
| --- | --- | --- | --- |
| Official statute, judgment, court rule/form, or agency guidance | Current legal/procedural proposition | `verified` only after full-text and trace confirmation | [CLM-FRAUD-5001] [CLM-COMPENSATION-0003] |
| Official statistic or court publication with bounded access | Contextual metric or case-description only | `reported` or `withheld` when metric definition or traceability remains unresolved | [CLM-STATISTICS-9001] [CLM-STATISTICS-9002] |
| Platform policy | Product-flow or prevention context | `reported`; not a legal guarantee | [CLM-PAYMENT-9005] |
지표: R10이 주장한 플랫폼 사기 감소율; 단위: %; 모집단: 원자료에 정의되지 않음; 기간: 원자료에 정의되지 않음; 주장값: 약 95%; 한정: 비교집단·분류·개정 이력·측정방법이 없고 번개장터 URL도 애플리케이션 셸만 재현되어 검증 거절 및 출판 보류한다. [CLM-STATISTICS-9003]

계층은 출처의 신뢰도와 출판 상한을 구분한다. 예컨대 해시와 보관 경위는 동일성 판단 자료가 될 수 있지만 법원의 증거 채택이나 진정성 결론을 자동 보증하지 않으며, 같은 보수성은 보고서의 citation에도 적용했다 [CLM-EVIDENCE-5004].

## Coverage results by all 12 lanes

Repository coverage COV-CIVIL-0009 sets lane CIVIL, cell civil-answer-deadline, and status verified. 아래 각 행의 claim은 해당 범위의 상태와 한계를 별도로 밝힌다 [CLM-AUDIT-39b1e6fae3df657c] [CLM-SCOPE-9014].

| Lane | Current result | Report treatment | Claim anchor |
| --- | --- | --- | --- |
| Scope and terminology | Official-source gap documented | Boundary stated; no missing rule invented | [CLM-SCOPE-9013] |
| Fraud elements | Verified doctrine cells | Facts remain case-specific | [CLM-FRAUD-5001] [CLM-FRAUD-5002] |
| Evidence | Verified doctrine/capture cells | Preservation is not automatic admissibility | [CLM-EVIDENCE-5004] |
| Criminal procedure | Verified cells plus reported portal limit | Intake and repayment remain separate | [CLM-CRIMINAL-0001] [CLM-CRIMINAL-0005] |
| Compensation order | Verified cells plus current-form gap | Eligibility and payment remain separate | [CLM-COMPENSATION-0001] [CLM-COMPENSATION-0011] |
| Civil/payment order/small claim | Verified rules plus reported portal/form limits | Route turns on service, objection and scope facts | [CLM-CIVIL-0002] [CLM-CIVIL-0006] |
| Identity/jurisdiction/service | Verified rules plus reported identification aid | A clue is not a guaranteed identification result | [CLM-SERVICE-0001] [CLM-SERVICE-0002] |
| Judgment/finality/title | Verified state-specific cells | Each state is independently checked | [CLM-TITLE-0001] [CLM-TITLE-0006] |
| Enforcement/insolvency/recovery | Verified procedures plus reported payment/recoverability limits | Procedure availability is not economic recovery | [CLM-ENFORCEMENT-0005] [CLM-ENFORCEMENT-0013] |
| Privacy/legal-service/AI boundaries | Verified legal cells plus reported policy limits | Policy is not a safe harbor | [CLM-SAFETY-0008] [CLM-SAFETY-0014] |
| Payment/platform branches | Verified statutory boundary plus reported platform context/gaps | Platform language is not a guarantee | [CLM-PAYMENT-9001] [CLM-PAYMENT-9005] |
| Statistics/prevention/lived experience | Reported context, one withheld metric-definition conflict, and documented gaps | No outcome or effect inference | [CLM-STATISTICS-9001] [CLM-STATISTICS-9013] |

## All seed dispositions

각 행은 동결 seed ID를 유지한 출판 처분이다. `augment`는 ID 보존과 보강 필요를, `unverified`는 trace 상한을, `context_only`는 대상 개인 결과가 아닌 문맥을 뜻한다; 어떤 행도 대표적 유죄·회수·기간 결과로 읽지 않는다 [CLM-AUDIT-d5a0c8c09d840457].

| Seed | Disposition | Public treatment | Claim anchor |
| --- | --- | --- | --- |
| P1 | augment | Frozen audit disposition; not an outcome finding | [CLM-AUDIT-d5a0c8c09d840457] |
| P2 | augment | Frozen audit disposition; not an outcome finding | [CLM-AUDIT-9d4b458c25d5b8c9] |
| P3 | augment | Frozen audit disposition; not an outcome finding | [CLM-AUDIT-a487eeac7eecd06f] |
| P4 | augment | Frozen audit disposition; not an outcome finding | [CLM-AUDIT-af015fa2dfd997a7] |
| P5 | augment | Frozen audit disposition; not an outcome finding | [CLM-AUDIT-52d45cf9907cc9ff] |
| P6 | augment | Frozen audit disposition; not an outcome finding | [CLM-AUDIT-8db2a2b9de7a4ce5] |
| P7 | augment | Frozen audit disposition; not an outcome finding | [CLM-AUDIT-b03e28ce1399813c] |
| P8 | augment | Frozen audit disposition; not an outcome finding | [CLM-AUDIT-a2f89f3d90dee189] |
| P9 | context_only | Frozen audit disposition; not an outcome finding | [CLM-AUDIT-9c6981b86b1e9d61] |
| P10 | context_only | Frozen audit disposition; not an outcome finding | [CLM-AUDIT-7d4151073972275e] |
| R1 | unverified | Frozen audit disposition; not an outcome finding | [CLM-AUDIT-34a55ebb944272f0] |
| R2 | unverified | Frozen audit disposition; not an outcome finding | [CLM-AUDIT-293e8ca9ef2ad256] |
| R3 | unverified | Frozen audit disposition; not an outcome finding | [CLM-AUDIT-39586e720e9bf246] |
| R4 | unverified | Frozen audit disposition; not an outcome finding | [CLM-AUDIT-6110b6a66edf4068] |
| R5 | unverified | Frozen audit disposition; not an outcome finding | [CLM-AUDIT-721380d68c1b733a] |
| R6 | unverified | Frozen audit disposition; not an outcome finding | [CLM-AUDIT-138b703b411051aa] |
| R7 | context_only | Frozen audit disposition; not an outcome finding | [CLM-AUDIT-f24834b1df98dac9] |
| R8 | unverified | Frozen audit disposition; not an outcome finding | [CLM-AUDIT-abd4a86b173a72e2] |
| R9 | unverified | Frozen audit disposition; not an outcome finding | [CLM-AUDIT-51a413dfcc37c63a] |
| R10 | context_only | Frozen audit disposition; not an outcome finding | [CLM-AUDIT-d6e24a1a4d63a30c] |
| INDEX-0001 | keep | Frozen audit disposition; not an outcome finding | [CLM-AUDIT-8c00d9c60d61afe6] |

## Legal and procedural findings

사기 구성요건은 사람을 기망하여 재물을 교부받거나 재산상 이익을 취득하는 행위로 정리되며, 거래형 사기의 의사·능력과 고의는 거래 당시 객관적 사정을 종합해 판단한다. 이후 미이행이나 경제사정 악화만으로 성립을 단정하지 않으며, 개별 사실에 대한 법률판단은 이 보고서의 범위를 벗어난다 [CLM-FRAUD-5001] [CLM-FRAUD-5002].

대화·화면 캡처는 원본 보존, 생성·전달·보관 경위와 무결성 자료를 함께 관리할 이유가 있지만, 그 관리만으로 법원의 증거 채택이나 진정성을 보장하지 않는다 [CLM-EVIDENCE-5002] [CLM-EVIDENCE-5004].

ECRM 입력은 경찰서 방문 전 서류작성을 지원하는 공식 안내 경로이고, 신고 자체는 사건 결과나 변제를 보장하지 않는다. 형사 신고·수사 상태와 금전 반환 상태는 분리해 기록하고 별도 민사 경로를 검토할 수 있다 [CLM-CRIMINAL-0001] [CLM-CRIMINAL-0010].

배상신청은 제1심 또는 제2심 공판의 변론 종결 전까지라는 제도적 시기와 법정 요건이 있으며, 신청만으로 인용되는 것이 아니다. 법이 정한 배상명령 정본의 효력은 집행 가능성과 관련된 상태일 뿐 실제 입금을 입증하지 않는다 [CLM-COMPENSATION-0003] [CLM-COMPENSATION-0008].

지급명령은 국내에서 공시송달 아닌 방법이 가능한 경우로 제한되고, 소액사건 범위도 제소 당시 소가와 규칙상 제외사유를 검토한다. 일부 단서는 법원을 통한 사실조회와 당사자 표시 보정의 출발점이 될 수 있지만, 식별·관할·송달 결과를 보장하지 않는다 [CLM-CIVIL-0002] [CLM-CIVIL-0006] [CLM-SERVICE-0001].

선고, 재판서 정본 교부, 확정, 집행권원과 집행행위는 같은 상태가 아니다. 종국재판은 확정되었거나 즉시 강제할 수 있다고 선고된 경우에 강제절차의 기초가 되고, 압류 효력에는 제3채무자에 대한 명령 송달이 요구되지만, 실제 지급에는 해당 거래를 확인할 별도 자료가 필요하다 [CLM-TITLE-0003] [CLM-TITLE-0006] [CLM-ENFORCEMENT-0005] [CLM-ENFORCEMENT-0012].

## Case-trace and statistical limits

경찰청·공공데이터포털의 후보 지표는 같은 공식 페이지 안에서 표 헤더와 상세 설명의 범주가 충돌한다. 따라서 전체 발생건수나 직거래 발생건수 어느 쪽의 확정값도 채택하지 않고 **status**를 withheld로 유지한다 [CLM-STATISTICS-9001] [CLM-STATISTICS-9005].

법원 게시 요지에 적힌 개별 편취액 범위도 특정 병합 사건군·특정 선고일의 문맥일 뿐 대표 피해액, 실제 지급, 회수 가능성 또는 일반 양형 결과가 아니다. R10의 안전결제 감소율 주장은 지표·모집단·기간·비교군·방법을 확인하지 못해 rejected/withheld로 남았고, 보고서는 이를 예방 또는 제품 효과의 증거로 채택하지 않는다 [CLM-STATISTICS-9002] [CLM-STATISTICS-9003].

비식별 R trace와 집단 보도는 탐색 맥락을 보존하지만 표본틀, 반사실 비교, 지급영수 자료가 없다. 따라서 이 report는 대표적 결과, 회수 가능성, 단축된 기간, 인과적 회수 또는 제품 효과를 주장하지 않는다 [CLM-STATISTICS-9013].

## Wiki and ledger design

고정 기준일 코퍼스는 지정된 절차 주제의 원자 claim 또는 문서화된 gap을 보이는 제한적 절차 참고자료이며, 대상 이용자의 대표 결과를 입증하는 결과 데이터셋이 아니다. [CLM-SCOPE-9014].

레저는 source identity, 짧은 observation, 원자 claim, verification, coverage, conflict, redirect, candidate 및 saturation을 분리한다. 특히 자료 보존·해시 기록은 사후 변경 탐지와 동일성 판단의 한 자료일 수 있으나, 원본 진정성·법정 증거능력·사실의 진실을 자동으로 확정하지 않는다고 설계했다 [CLM-EVIDENCE-5003] [CLM-EVIDENCE-5004].

## Conflict, deduplication, and saturation

형사상 편취액과 배상명령의 법정 손해 범위는 다른 질문이므로 서로 대체하지 않는다. 이 분리는 일부 대가 지급이 있는 형사 법리를 민사 손해액이나 실제 지급 금액으로 바꾸는 오류를 막는다 [CLM-FRAUD-5004] [CLM-COMPENSATION-0002].

통상 불복기간에 따른 확정 규칙과 공시송달을 과실 없이 알지 못한 경우의 예외도 강제로 병합하지 않았다. 따라서 날짜 계산만으로 모든 사건의 확정을 기계적으로 단정하지 않는다 [CLM-TITLE-0011] [CLM-TITLE-0012].

역사적 Wave A/B의 광범위한 lane query는 검색 포화의 증명이 아니다. Task 14A의 독립 Wave C와 D는 각각 107개 cell에 고유한 proposition-anchored query와 receipt를 결속했고, 두 wave 모두 material novelty 0, candidate queue 0으로 종료되어 고정 matrix에 대한 검색 포화 기준을 충족한다. 이 결론은 문서화된 evidence gap을 해소한다는 뜻이 아니다. [CLM-SCOPE-9016].

## Unresolved gaps

scope-and-terminology lane에는 고정 기준일의 공식 출처 gap이 남아 있으므로, 그 빈칸을 일반 법리나 제품 기획 문구로 채우지 않았다 [CLM-SCOPE-9013].

현행 B3002 파일 본문·파일 다이제스트·전자제출 지원 여부, 일부 법원 포털/양식 접근, 플랫폼 정책 본문, 통계 원자료와 방법론은 각각 gap 또는 reported ceiling으로 남아 있다 [CLM-COMPENSATION-0011] [CLM-CIVIL-0013] [CLM-PAYMENT-9006] [CLM-STATISTICS-9003].

실제 지급과 경제적 회수는 개별 거래를 확인할 자료와 집행 현실을 별도로 확인해야 한다. 법적 수단을 사용할 수 있다는 정보는 회수 금액이나 회수 가능성을 보장하지 않는다 [CLM-ENFORCEMENT-0012] [CLM-ENFORCEMENT-0013].

## Copyright and privacy

개인정보 수집ㆍ이용에는 항목과 목적별 법적 근거가 필요하다 [CLM-SAFETY-0001]. 개인정보는 처리 목적에 필요한 최소 범위로 수집하여야 한다 [CLM-SAFETY-0002]. 불필요해진 개인정보는 법정 보존 예외를 제외하고 지체 없이 파기하여야 한다 [CLM-SAFETY-0003].

전자문서 사본·출력물의 형사상 증거능력에는 원본과의 동일성 및 무결성 증명이 요구될 수 있고, 해시 비교는 여러 증명 방법 중 하나이지 단독·자동 보증이 아니다 [CLM-EVIDENCE-5003]. 대화·화면 캡처의 원본 보존, 생성·전달·보관 경위 기록과 해시 비교는 동일성 판단 자료가 될 수 있으나, 법원의 증거 채택 또는 진정성 판단 결과를 보장하지 않는다 [CLM-EVIDENCE-5004].

Repository text wiki/_ledgers/SCHEMA.md at SCHEMA.md#Shared enumerations states: `search_snippet`, `ai_summary`, `metadata_only`, and `inaccessible` sources are discovery-only and cannot support a `verified` claim. [CLM-AUDIT-8762b6ac8f4ee3c7]
Repository text wiki/README.md at README.md#Limitations and user controls#identifiers states: 개인 이름, 연락처, 계좌, 주소, 식별번호 및 자격증명은 수집·게시하지 않는다. [CLM-AUDIT-e5679024bb51d447]
Repository text wiki/README.md at README.md#Limitations and user controls#source-text states: 원문 판결·기사·게시물의 전문을 복제하지 않고, 필요한 범위의 짧은 관찰과 출처 식별자만 레저에 남긴다. [CLM-AUDIT-c62418a774e4644c]

## Recommendations for later LLM/agent use

후속 LLM 또는 agent는 source의 원문·기준일·locator를 다시 확인하고, claim 상태·caveat·gap을 출력에서 지우지 말아야 한다. 사용자가 원문과 추출값을 대조·승인하도록 하고, 충돌 자료는 임의로 병합하지 않으며, 자동 제출·개별 사건처리 주도·회수 예측을 피하는 것이 이 코퍼스의 보수적 사용법이다 [CLM-SAFETY-9013] [CLM-EVIDENCE-5004].

제품 정책은 법적 안전지대가 아니며, 유상 법률사무 취급·알선과 실질적 대리의 경계, 개인정보 처리 근거, 현행 포털·양식의 변동은 전문 검토와 공식 확인이 필요하다. 이 report의 추천은 법률 자문, 대리 또는 자동 제출의 승인으로 읽혀서는 안 된다 [CLM-SAFETY-0008] [CLM-SAFETY-0009] [CLM-SAFETY-0014].
