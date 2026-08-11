declare const krwAmountBrand: unique symbol;
export type KrwAmount = number & { readonly [krwAmountBrand]: true };

export type OcrFact = Readonly<{
  field: string;
  value: string;
  confirmation: "pending" | "confirmed";
}>;

export type CriminalState = "evidence-review" | "complaint-ready" | "complaint-filed";
export type CivilState = "pre-filing" | "payment-order-pending" | "enforceable-title-confirmed";

export type CaseWorkflow = Readonly<{
  caseType: "domestic-bank-transfer-fraud";
  amountKrw: KrwAmount;
  ocrFacts: readonly OcrFact[];
  criminalState: CriminalState;
  civilState: CivilState;
}>;

type DomainReason =
  | "ocr-facts-unconfirmed"
  | "ocr-facts-already-confirmed"
  | "user-confirmation-required"
  | "enforceable-title-required"
  | "transition-not-available";

export type DomainOutcome<T> =
  | Readonly<{ status: "ok"; value: T }>
  | Readonly<{ status: "not-allowed"; reason: DomainReason }>;

type NeutralRejectionData = Readonly<{
  supportedCase: "KRW domestic bank-transfer fraud";
}>;

export type ParseCaseResult =
  | Readonly<{ status: "accepted"; value: CaseWorkflow }>
  | Readonly<{
      status: "rejected";
      reason: "invalid-input" | "out-of-scope";
      data: NeutralRejectionData;
    }>;

export type CriminalCommand = "prepare-complaint" | "file-complaint";
export type CivilCommand = "apply-payment-order" | "confirm-enforceable-title";

export type EnforcementChoice = Readonly<
  | { kind: "asset-inquiry"; condition: "enforceable-title-confirmed" }
  | { kind: "seizure-and-collection"; condition: "attachable-asset-identified" }
  | { kind: "debtor-registry"; condition: "statutory-requirements-met" }
>;

const neutralRejectionData: NeutralRejectionData = {
  supportedCase: "KRW domestic bank-transfer fraud",
};

function rejected(reason: "invalid-input" | "out-of-scope"): ParseCaseResult {
  return { status: "rejected", reason, data: neutralRejectionData };
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function parseKrwAmount(input: unknown): KrwAmount | undefined {
  if (typeof input !== "number" || !Number.isInteger(input) || input < 1 || input > 30_000_000) {
    return undefined;
  }
  return input as KrwAmount;
}

function parseOcrFacts(input: unknown): readonly OcrFact[] | undefined {
  if (!Array.isArray(input) || input.length === 0) {
    return undefined;
  }

  const facts: OcrFact[] = [];
  for (const candidate of input) {
    if (
      !isRecord(candidate) ||
      typeof candidate.field !== "string" ||
      candidate.field.length === 0 ||
      typeof candidate.value !== "string" ||
      candidate.value.length === 0
    ) {
      return undefined;
    }
    facts.push({
      field: candidate.field,
      value: candidate.value,
      confirmation: "pending",
    });
  }
  return facts;
}

export function parseCaseInput(input: unknown): ParseCaseResult {
  if (!isRecord(input)) {
    return rejected("invalid-input");
  }

  if (
    input.jurisdiction !== "KR-domestic" ||
    input.paymentMethod !== "bank-transfer" ||
    input.currency !== "KRW"
  ) {
    return rejected("out-of-scope");
  }

  const amountKrw = parseKrwAmount(input.amount);
  const ocrFacts = parseOcrFacts(input.ocrFacts);
  if (amountKrw === undefined || !ocrFacts) {
    return rejected("invalid-input");
  }

  return {
    status: "accepted",
    value: {
      caseType: "domestic-bank-transfer-fraud",
      amountKrw,
      ocrFacts,
      criminalState: "evidence-review",
      civilState: "pre-filing",
    },
  };
}

function allFactsConfirmed(workflow: CaseWorkflow): boolean {
  return workflow.ocrFacts.every((fact) => fact.confirmation === "confirmed");
}

export function confirmOcrFacts(workflow: CaseWorkflow): DomainOutcome<CaseWorkflow> {
  if (allFactsConfirmed(workflow)) {
    return { status: "not-allowed", reason: "ocr-facts-already-confirmed" };
  }

  return {
    status: "ok",
    value: {
      ...workflow,
      ocrFacts: workflow.ocrFacts.map((fact) => ({ ...fact, confirmation: "confirmed" })),
    },
  };
}

export function advanceCriminal(
  workflow: CaseWorkflow,
  command: CriminalCommand,
): DomainOutcome<CaseWorkflow> {
  if (!allFactsConfirmed(workflow)) {
    return { status: "not-allowed", reason: "ocr-facts-unconfirmed" };
  }

  switch (workflow.criminalState) {
    case "evidence-review":
      return command === "prepare-complaint"
        ? { status: "ok", value: { ...workflow, criminalState: "complaint-ready" } }
        : { status: "not-allowed", reason: "transition-not-available" };
    case "complaint-ready":
      return command === "file-complaint"
        ? { status: "ok", value: { ...workflow, criminalState: "complaint-filed" } }
        : { status: "not-allowed", reason: "transition-not-available" };
    case "complaint-filed":
      return { status: "not-allowed", reason: "transition-not-available" };
  }
}

export function advanceCivil(
  workflow: CaseWorkflow,
  command: CivilCommand,
  userConfirmed = false,
): DomainOutcome<CaseWorkflow> {
  switch (workflow.civilState) {
    case "pre-filing":
      return command === "apply-payment-order"
        ? { status: "ok", value: { ...workflow, civilState: "payment-order-pending" } }
        : { status: "not-allowed", reason: "transition-not-available" };
    case "payment-order-pending":
      if (command !== "confirm-enforceable-title") {
        return { status: "not-allowed", reason: "transition-not-available" };
      }
      return userConfirmed
        ? {
            status: "ok",
            value: { ...workflow, civilState: "enforceable-title-confirmed" },
          }
        : { status: "not-allowed", reason: "user-confirmation-required" };
    case "enforceable-title-confirmed":
      return { status: "not-allowed", reason: "transition-not-available" };
  }
}

export function enforcementChoices(
  workflow: CaseWorkflow,
): DomainOutcome<readonly EnforcementChoice[]> {
  if (workflow.civilState !== "enforceable-title-confirmed") {
    return { status: "not-allowed", reason: "enforceable-title-required" };
  }

  return {
    status: "ok",
    value: [
      { kind: "asset-inquiry", condition: "enforceable-title-confirmed" },
      { kind: "seizure-and-collection", condition: "attachable-asset-identified" },
      { kind: "debtor-registry", condition: "statutory-requirements-met" },
    ],
  };
}
