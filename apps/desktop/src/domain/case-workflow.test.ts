/// <reference path="../../node_modules/bun-types/test.d.ts" />

import { describe, expect, test } from "bun:test";
import {
  advanceCivil,
  advanceCriminal,
  type CaseWorkflow,
  confirmOcrFacts,
  type DomainOutcome,
  enforcementChoices,
  parseCaseInput,
} from "./case-workflow";

const domesticTransferInput = {
  jurisdiction: "KR-domestic",
  paymentMethod: "bank-transfer",
  currency: "KRW",
  amount: 5_380_000,
  ocrFacts: [
    { field: "transferredAt", value: "2026-08-01" },
    { field: "recipientBank", value: "예시은행" },
  ],
};

function acceptedCase(input: unknown = domesticTransferInput): CaseWorkflow {
  const result = parseCaseInput(input);
  expect(result.status).toBe("accepted");
  if (result.status !== "accepted") {
    throw new Error(`Expected an accepted case, received ${result.status}`);
  }
  return result.value;
}

function outcomeValue<T>(outcome: DomainOutcome<T>): T {
  expect(outcome.status).toBe("ok");
  if (outcome.status !== "ok") {
    throw new Error(`Expected an ok outcome, received ${outcome.reason}`);
  }
  return outcome.value;
}

function confirmedCase(): CaseWorkflow {
  return outcomeValue(confirmOcrFacts(acceptedCase()));
}

describe("separate criminal and civil tracks", () => {
  test("progresses the criminal complaint without advancing the civil track", () => {
    const prepared = outcomeValue(advanceCriminal(confirmedCase(), "prepare-complaint"));
    expect(prepared).toMatchObject({
      criminalState: "complaint-ready",
      civilState: "pre-filing",
    });

    const filed = outcomeValue(advanceCriminal(prepared, "file-complaint"));
    expect(filed).toMatchObject({
      criminalState: "complaint-filed",
      civilState: "pre-filing",
    });
  });

  test("progresses civil service, judgment, and finality without advancing criminal complaint", () => {
    const pending = outcomeValue(advanceCivil(confirmedCase(), "apply-payment-order"));
    const served = outcomeValue(advanceCivil(pending, "attest-service", true));
    expect(served).toMatchObject({
      criminalState: "evidence-review",
      civilState: "service-attested",
    });

    const judged = outcomeValue(advanceCivil(served, "record-judgment"));
    expect(judged).toMatchObject({
      criminalState: "evidence-review",
      civilState: "judgment-recorded",
    });

    const final = outcomeValue(advanceCivil(judged, "attest-finality", true));
    expect(final).toMatchObject({
      criminalState: "evidence-review",
      civilState: "enforceable-title-confirmed",
    });
  });
});

describe("enforceable title attestations", () => {
  test("requires user-attested service and does not permit skipping to judgment", () => {
    const pending = outcomeValue(advanceCivil(confirmedCase(), "apply-payment-order"));

    expect(advanceCivil(pending, "attest-service", false)).toEqual({
      status: "not-allowed",
      reason: "user-confirmation-required",
    });
    expect(advanceCivil(pending, "record-judgment")).toEqual({
      status: "not-allowed",
      reason: "transition-not-available",
    });
    expect(enforcementChoices(pending)).toEqual({
      status: "not-allowed",
      reason: "enforceable-title-required",
    });
  });

  test("requires user-attested finality after judgment before enforcement", () => {
    const pending = outcomeValue(advanceCivil(confirmedCase(), "apply-payment-order"));
    const served = outcomeValue(advanceCivil(pending, "attest-service", true));
    const judged = outcomeValue(advanceCivil(served, "record-judgment"));

    expect(advanceCivil(judged, "attest-finality", false)).toEqual({
      status: "not-allowed",
      reason: "user-confirmation-required",
    });
    expect(enforcementChoices(judged)).toEqual({
      status: "not-allowed",
      reason: "enforceable-title-required",
    });

    const final = outcomeValue(advanceCivil(judged, "attest-finality", true));
    expect(enforcementChoices(final)).toEqual({
      status: "ok",
      value: [
        { kind: "asset-inquiry", condition: "enforceable-title-confirmed" },
        { kind: "seizure-and-collection", condition: "attachable-asset-identified" },
        { kind: "debtor-registry", condition: "statutory-requirements-met" },
      ],
    });
  });
});

describe("case intake boundary", () => {
  test("accepts an in-scope case with pending OCR facts", () => {
    const workflow = acceptedCase();
    expect(workflow.caseType).toBe("domestic-bank-transfer-fraud");
    expect(Number(workflow.amountKrw)).toBe(5_380_000);
    expect(workflow.ocrFacts).toEqual([
      { field: "transferredAt", value: "2026-08-01", confirmation: "pending" },
      { field: "recipientBank", value: "예시은행", confirmation: "pending" },
    ]);
    expect(advanceCriminal(workflow, "prepare-complaint")).toEqual({
      status: "not-allowed",
      reason: "ocr-facts-unconfirmed",
    });
  });

  test.each([1, 30_000_000])("accepts integer KRW boundary amount: %d", (amount) => {
    expect(parseCaseInput({ ...domesticTransferInput, amount }).status).toBe("accepted");
  });

  test.each([0, 1.5, 30_000_001])("rejects unsupported KRW amount: %s", (amount) => {
    expect(parseCaseInput({ ...domesticTransferInput, amount })).toEqual({
      status: "rejected",
      reason: "invalid-input",
      data: { supportedCase: "KRW domestic bank-transfer fraud" },
    });
  });

  test.each([{ jurisdiction: "international" }, { paymentMethod: "card" }])(
    "returns neutral data for an out-of-scope case: %o",
    (override) => {
      expect(
        parseCaseInput({
          ...domesticTransferInput,
          ocrFacts: [{ field: "privateAccount", value: "sensitive-account-value" }],
          ...override,
        }),
      ).toEqual({
        status: "rejected",
        reason: "out-of-scope",
        data: { supportedCase: "KRW domestic bank-transfer fraud" },
      });
    },
  );
});
