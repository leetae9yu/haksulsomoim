export const naverCase538Fixture = Object.freeze({
  scenarioId: "naver-case-538-synthetic",
  sourceKind: "personal-process-diary",
  amountKrw: 5_380_000,
  civil: Object.freeze({
    complaintServiceDate: "2023-06-09",
    noHearingJudgment: "discretionary",
    sixMonthAnchor: "final-enforceable-title",
    registryMeansCollection: false,
  }),
  criminal: Object.freeze({
    sentenceCausation: "unverified",
  }),
  tracks: Object.freeze({
    civil: Object.freeze([
      "claim-preparation",
      "complaint-served",
      "judgment-recorded",
      "judgment-served",
      "judgment-final",
      "debtor-registry-entered",
    ]),
    criminal: Object.freeze([
      "complaint-preparation",
      "investigation-tracked",
      "disposition-recorded",
    ]),
  }),
  recovery: Object.freeze({ collectedKrw: 0, status: "not-collected" }),
} as const);
