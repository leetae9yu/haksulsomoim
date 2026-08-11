# Slide Architecture

## Narrative contract

The deck moves through five questions:

1. **왜 필요한가?** 피해자는 절차 부재가 아니라 절차 단절 때문에 멈춘다.
2. **무엇이 실제 구제 절차인가?** 형사 신고, 집행권원, 강제집행은 서로 다른 관문이다.
3. **AI가 어디서 가치가 있는가?** 증거 무결성, 사실 구조화, 상태·기한 관리, 공공 handoff.
4. **어디까지 하면 안 되는가?** 개인화 법률판단, 완성 서식, 대리·협상, 회수 보장 금지.
5. **어떻게 검증하며 구현할 것인가?** 5단계 로드맵과 Go/No-Go 통제.

## Slides

| # | Working title | Narrative job | Required visual | Evidence constraint |
|---:|---|---|---|---|
| 1 | 사용자 통제형 AI 증거·절차 내비게이터 | Identify topic, author, and scope | Cover with evidence thread | No unsupported claims |
| 2 | 구제 절차는 있다. 연결이 없다. | State the central thesis | One statement + four disconnects | Criminal procedure alone does not recover money; include compensation-order nuance [S001–S003, S039, S102] |
| 3 | 100,539건이 말하는 것과 말하지 않는 것 | Establish measured scale without market-size inflation | Metric tile + boundary strip | Police-recorded cyber-fraud occurrence count; distinguish autonomous dispute committee data [S041, S051, S062] |
| 4 | 첫 관문은 ‘사기’ 판정이 아니라 사실 분류다 | Explain fraud / civil / consumer routing | Three-branch decision route | No automatic fraud conclusion; pure C2C condition; ordinary-goods payment-freeze exclusion [S059, S088, S097–S098] |
| 5 | 신고에서 회수까지, 여섯 개의 법적 게이트 | Show complete remedy sequence | Six-node legal route | ECRM attendance exception, compensation-order dismissal terminology, alternative civil paths [S013–S014, S020, S032, S039, S047, S101–S102] |
| 6 | 집행권원은 돈이 아니다 | Correct the most important misconception | Dark chapter + title/recovery split | No automatic recovery; do not state a protected-deposit amount because the ledger lacks the current decree source [S035–S044, S102] |
| 7 | 제품의 답: 사용자가 통제하는 내비게이터 | Introduce product identity and non-goals | Product definition split | Product risk policy, not a legal Safe Harbor; preserve the benefit element of Attorney-at-Law Act Article 109 [S089] |
| 8 | 증거 Dossier: 원본에서 공공 제출까지 | Explain evidence architecture | Five-stage evidence thread | Integrity after collection only [S063–S069, S078] |
| 9 | 사건을 놓치지 않는 9단계 상태 머신 | Show state management | Nine compact route nodes | Transitions require user/external confirmation |
| 10 | 기능은 넓히지 않고, 경계를 선명하게 | Compare product-policy allowed, controlled, prohibited | Three-column spectrum | Risk-control policy, not definitive legality; include benefit element [S089] |
| 11 | 개인정보와 인간 책임성을 제품 구조로 만든다 | Explain PIPA lifecycle and sign-off | Split lifecycle + accountability | Use 개인정보, conditional overseas-transfer basis, statutory retention exceptions [S093–S094] |
| 12 | 공공 시스템을 대체하지 않고 연결한다 | Position handoff and differentiation | Hub-and-spoke official services | Designed handoff, not implemented direct API integration [S013, S018, S030, S050, S052, S054, S058] |
| 13 | Phase 0에서 Phase 4까지 | Present implementation plan | Five-stage roadmap | Legal-risk-first sequence; supervision without referral consideration [S089, S093–S094] |
| 14 | 출시 조건은 기능 수가 아니라 오류 0건이다 | Present Go/No-Go metrics | Five metric tiles | No invented performance results |
| 15 | 검증된 결론과 남은 질문 | Synthesize value, limits, research needs | 2×2 conclusion/limits | Support possible mitigation, not proven resolution; preserve seven abstentions [S001–S002, S042, S048, S063–S069, S078, S089, S093–S094] |
| 16 | 연구 근거와 토론 질문 | Close and support Q&A | Methodology strip + 3 discussion questions | Self-reported 14 researchers and 2 waves; S001–S102 is a source ledger count, not equal-quality proof; no causal efficacy claim |

## Copy budget for agy

- Slide title: 24 Korean characters preferred, 34 maximum.
- Takeaway: one sentence, 45 Korean characters preferred.
- Bullets: zero to three; each 22 Korean characters preferred, 38 maximum.
- Diagram labels: 2–10 Korean characters.
- Speaker notes: 70–130 Korean words per slide, except cover (30–70) and appendix (70–100).
- Every factual slide must include valid `[Snnn]` source IDs already present in the report.
- The output may summarize but must not add new statutes, statistics, product capabilities, market claims, efficacy claims, or legal conclusions.
