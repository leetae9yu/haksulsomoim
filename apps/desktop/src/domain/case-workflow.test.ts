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

function acceptedCase(input: unknown): CaseWorkflow {
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

describe("domestic bank-transfer fraud case workflow", () => {
  test("accepts a KRW 5,380,000 case and treats OCR facts as unconfirmed", () => {
    const workflow = acceptedCase(domesticTransferInput);

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

  test("advances criminal and civil tracks independently after explicit OCR confirmation", () => {
    const initial = acceptedCase(domesticTransferInput);
    const confirmed = outcomeValue(confirmOcrFacts(initial));
    expect(confirmed.ocrFacts.every((fact) => fact.confirmation === "confirmed")).toBe(true);

    const criminalAdvanced = outcomeValue(advanceCriminal(confirmed, "prepare-complaint"));
    expect(criminalAdvanced.criminalState).toBe("complaint-ready");
    expect(criminalAdvanced.civilState).toBe("pre-filing");

    const civilAdvanced = outcomeValue(advanceCivil(criminalAdvanced, "apply-payment-order"));
    expect(civilAdvanced.criminalState).toBe("complaint-ready");
    expect(civilAdvanced.civilState).toBe("payment-order-pending");
  });

  test("unlocks conditional enforcement choices only for a user-confirmed enforceable title", () => {
    const confirmed = outcomeValue(confirmOcrFacts(acceptedCase(domesticTransferInput)));
    const paymentOrder = outcomeValue(advanceCivil(confirmed, "apply-payment-order"));

    expect(enforcementChoices(paymentOrder)).toEqual({
      status: "not-allowed",
      reason: "enforceable-title-required",
    });
    expect(advanceCivil(paymentOrder, "confirm-enforceable-title", false)).toEqual({
      status: "not-allowed",
      reason: "user-confirmation-required",
    });

    const titled = outcomeValue(advanceCivil(paymentOrder, "confirm-enforceable-title", true));
    expect(titled.civilState).toBe("enforceable-title-confirmed");
    expect(enforcementChoices(titled)).toEqual({
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
  test.each([1, 30_000_000])(
    "accepts integer KRW amounts at the inclusive boundary: %d",
    (amount) => {
      expect(parseCaseInput({ ...domesticTransferInput, amount }).status).toBe("accepted");
    },
  );

  test.each([0, 1.5, 30_000_001])(
    "rejects an amount outside the supported integer range: %s",
    (amount) => {
      expect(parseCaseInput({ ...domesticTransferInput, amount })).toEqual({
        status: "rejected",
        reason: "invalid-input",
        data: { supportedCase: "KRW domestic bank-transfer fraud" },
      });
    },
  );

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
