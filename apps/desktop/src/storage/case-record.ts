import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import type { CivilState, CriminalState } from "../domain/case-workflow";
import { LocalCaseStoreError } from "./evidence-record";

const ID = /^[a-f0-9]{32}$/;
const HASH = /^[a-f0-9]{64}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export interface CaseEvidence {
  readonly evidenceId: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly sha256: string;
}

export interface CaseDossier {
  readonly caseId: string;
  readonly amountKrw: number;
  readonly scope: Readonly<{
    caseType: "domestic-bank-transfer-fraud";
    jurisdiction: "KR-domestic";
    paymentMethod: "bank-transfer";
    currency: "KRW";
  }>;
  readonly evidence: readonly CaseEvidence[];
  readonly confirmedOcrFacts: readonly Readonly<{ field: string; value: string }>[];
  readonly workflow: Readonly<{
    criminalState: CriminalState;
    civilState: CivilState;
  }>;
}

export class UnknownCaseError extends LocalCaseStoreError {
  constructor(options?: ErrorOptions) {
    super("UNKNOWN_CASE", "Case dossier was not found", options);
  }
}

export class CaseAlreadyExistsError extends LocalCaseStoreError {
  constructor(options?: ErrorOptions) {
    super("CASE_ALREADY_EXISTS", "Case dossier already exists", options);
  }
}

export class EvidenceAlreadyAttachedError extends LocalCaseStoreError {
  constructor(options?: ErrorOptions) {
    super("EVIDENCE_ALREADY_ATTACHED", "Evidence is already attached to this case", options);
  }
}

export class MalformedCaseDossierError extends LocalCaseStoreError {
  constructor(options?: ErrorOptions) {
    super("MALFORMED_CASE_DOSSIER", "Case dossier metadata is malformed", options);
  }
}

export class CorruptCaseDossierError extends LocalCaseStoreError {
  constructor(options?: ErrorOptions) {
    super("CORRUPT_CASE_DOSSIER", "Case dossier failed integrity verification", options);
  }
}

interface CaseRecord {
  readonly version: 1;
  readonly algorithm: "aes-256-gcm";
  readonly nonce: string;
  readonly ciphertext: string;
  readonly authTag: string;
}

function record(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function exactKeys(input: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(input).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function boundedString(input: unknown, maximum = 512): input is string {
  return typeof input === "string" && input.length > 0 && input.length <= maximum;
}

function canonicalBase64(input: unknown, length?: number): input is string {
  if (typeof input !== "string" || !BASE64.test(input)) return false;
  const decoded = Buffer.from(input, "base64");
  return (
    decoded.toString("base64") === input && (length === undefined || decoded.length === length)
  );
}

function parseEvidence(input: unknown): CaseEvidence | undefined {
  if (!record(input) || !exactKeys(input, ["evidenceId", "filename", "mimeType", "sha256"])) {
    return undefined;
  }
  if (
    typeof input.evidenceId !== "string" ||
    !ID.test(input.evidenceId) ||
    !boundedString(input.filename) ||
    !boundedString(input.mimeType, 255) ||
    typeof input.sha256 !== "string" ||
    !HASH.test(input.sha256)
  ) {
    return undefined;
  }
  return {
    evidenceId: input.evidenceId,
    filename: input.filename,
    mimeType: input.mimeType,
    sha256: input.sha256,
  };
}

export function parseCaseDossier(input: unknown): CaseDossier {
  if (
    !record(input) ||
    !exactKeys(input, [
      "amountKrw",
      "caseId",
      "confirmedOcrFacts",
      "evidence",
      "scope",
      "workflow",
    ]) ||
    !boundedString(input.caseId) ||
    typeof input.amountKrw !== "number" ||
    !Number.isInteger(input.amountKrw) ||
    input.amountKrw < 1 ||
    input.amountKrw > 30_000_000 ||
    !record(input.scope) ||
    !exactKeys(input.scope, ["caseType", "currency", "jurisdiction", "paymentMethod"]) ||
    input.scope.caseType !== "domestic-bank-transfer-fraud" ||
    input.scope.jurisdiction !== "KR-domestic" ||
    input.scope.paymentMethod !== "bank-transfer" ||
    input.scope.currency !== "KRW" ||
    !Array.isArray(input.evidence) ||
    !Array.isArray(input.confirmedOcrFacts) ||
    !record(input.workflow) ||
    !exactKeys(input.workflow, ["civilState", "criminalState"])
  ) {
    throw new MalformedCaseDossierError();
  }
  const workflow = input.workflow;
  const evidence = input.evidence.map(parseEvidence);
  const facts = input.confirmedOcrFacts.map((fact) => {
    if (
      !record(fact) ||
      !exactKeys(fact, ["field", "value"]) ||
      !boundedString(fact.field, 255) ||
      !boundedString(fact.value, 4096)
    ) {
      return undefined;
    }
    return { field: fact.field, value: fact.value };
  });
  const criminalStates = ["evidence-review", "complaint-ready", "complaint-filed"] as const;
  const civilStates = [
    "pre-filing",
    "payment-order-pending",
    "service-attested",
    "judgment-recorded",
    "enforceable-title-confirmed",
  ] as const;
  if (
    evidence.some((item) => item === undefined) ||
    new Set(evidence.map((item) => item?.evidenceId)).size !== evidence.length ||
    facts.some((fact) => fact === undefined) ||
    !criminalStates.some((state) => state === workflow.criminalState) ||
    !civilStates.some((state) => state === workflow.civilState)
  ) {
    throw new MalformedCaseDossierError();
  }
  return {
    caseId: input.caseId,
    amountKrw: input.amountKrw,
    scope: {
      caseType: "domestic-bank-transfer-fraud",
      jurisdiction: "KR-domestic",
      paymentMethod: "bank-transfer",
      currency: "KRW",
    },
    evidence: evidence as CaseEvidence[],
    confirmedOcrFacts: facts as { field: string; value: string }[],
    workflow: workflow as CaseDossier["workflow"],
  };
}

export function caseLocator(key: Uint8Array, caseId: string): string {
  return createHmac("sha256", key).update(`haksulsomoim:case-locator:v1\0${caseId}`).digest("hex");
}

function aad(locator: string): Buffer {
  return Buffer.from(`haksulsomoim:case:v1\0${locator}`, "utf8");
}

export function encryptCase(key: Uint8Array, locator: string, input: unknown): string {
  const dossier = parseCaseDossier(input);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad(locator));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(dossier)), cipher.final()]);
  const output: CaseRecord = {
    version: 1,
    algorithm: "aes-256-gcm",
    nonce: nonce.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
  };
  return `${JSON.stringify(output)}\n`;
}

export function decryptCase(key: Uint8Array, locator: string, serialized: string): CaseDossier {
  let input: unknown;
  try {
    input = JSON.parse(serialized);
  } catch (error) {
    throw new MalformedCaseDossierError({ cause: error });
  }
  if (
    !record(input) ||
    !exactKeys(input, ["algorithm", "authTag", "ciphertext", "nonce", "version"]) ||
    input.version !== 1 ||
    input.algorithm !== "aes-256-gcm" ||
    !canonicalBase64(input.nonce, 12) ||
    !canonicalBase64(input.ciphertext) ||
    !canonicalBase64(input.authTag, 16)
  ) {
    throw new MalformedCaseDossierError();
  }
  let plaintext: string;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(input.nonce, "base64"));
    decipher.setAAD(aad(locator));
    decipher.setAuthTag(Buffer.from(input.authTag, "base64"));
    plaintext = Buffer.concat([
      decipher.update(Buffer.from(input.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch (error) {
    throw new CorruptCaseDossierError({ cause: error });
  }
  try {
    return parseCaseDossier(JSON.parse(plaintext));
  } catch (error) {
    if (error instanceof MalformedCaseDossierError) throw error;
    throw new MalformedCaseDossierError({ cause: error });
  }
}
