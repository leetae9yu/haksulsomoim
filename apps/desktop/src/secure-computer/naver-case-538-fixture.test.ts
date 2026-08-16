import { describe, expect, test } from "bun:test";

import { naverCase538Fixture } from "./naver-case-538-fixture";

describe("naverCase538Fixture", () => {
  test("encodes only the verified case-trace acceptance values", () => {
    expect(naverCase538Fixture.amountKrw).toBe(5_380_000);
    expect(naverCase538Fixture.sourceKind).toBe("personal-process-diary");
    expect(naverCase538Fixture.civil.complaintServiceDate).toBe("2023-06-09");
    expect(naverCase538Fixture.civil.noHearingJudgment).toBe("discretionary");
    expect(naverCase538Fixture.civil.sixMonthAnchor).toBe("final-enforceable-title");
    expect(naverCase538Fixture.civil.registryMeansCollection).toBe(false);
    expect(naverCase538Fixture.criminal.sentenceCausation).toBe("unverified");
  });

  test("keeps civil, criminal, and recovery states distinct", () => {
    expect(naverCase538Fixture.tracks.civil).toEqual([
      "claim-preparation",
      "complaint-served",
      "judgment-recorded",
      "judgment-served",
      "judgment-final",
      "debtor-registry-entered",
    ]);
    expect(naverCase538Fixture.tracks.criminal).toEqual([
      "complaint-preparation",
      "investigation-tracked",
      "disposition-recorded",
    ]);
    expect(naverCase538Fixture.recovery).toEqual({ collectedKrw: 0, status: "not-collected" });
  });
});
