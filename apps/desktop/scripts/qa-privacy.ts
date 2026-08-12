import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Redactor, sanitizeSecret } from "../src/security/redaction";

const identifiers = {
  account: "110-123-456789",
  address: "서울특별시 종로구 세종대로 209",
  caseNumber: "2024가단123456",
  phone: "010-1234-5678",
  residentNumber: "900101-1234567",
} as const;

function evidenceDirectory(arguments_: readonly string[]): string {
  const optionIndex = arguments_.indexOf("--evidence-dir");
  const value = optionIndex >= 0 ? arguments_[optionIndex + 1] : undefined;
  if (value === undefined || value.length === 0) {
    throw new TypeError("Usage: qa:privacy -- --evidence-dir <directory>");
  }
  return resolve(value);
}

const rawText = [
  `주민등록번호 ${identifiers.residentNumber}`,
  `전화 ${identifiers.phone}`,
  `주소 ${identifiers.address}`,
  `계좌 ${identifiers.account}`,
  `사건 ${identifiers.caseNumber}`,
].join(", ");

const redactor = new Redactor(new Uint8Array(32).fill(0x4c));
const redacted = redactor.redact("qa-case-privacy", rawText);
const lawQuery = redactor.redact(
  "qa-case-privacy",
  `계좌 ${identifiers.account} 사건 ${identifiers.caseNumber} 관련 법령`,
);
const rawMatches = Object.values(identifiers).filter((identifier) => redacted.includes(identifier));
const lawQueryRawMatches = [identifiers.account, identifiers.caseNumber].filter((identifier) =>
  lawQuery.includes(identifier),
);
const expectedTokenClasses = ["RRN", "PHONE", "ADDRESS", "ACCOUNT", "CASE"] as const;
const maskedClasses = expectedTokenClasses.filter((kind) =>
  new RegExp(`\\[${kind}_[A-Z2-7]{16}\\]`, "u").test(redacted),
);
const stable = redacted === redactor.redact("qa-case-privacy", rawText);
const passed =
  rawMatches.length === 0 &&
  lawQueryRawMatches.length === 0 &&
  lawQuery.includes("[ACCOUNT_") &&
  lawQuery.includes("[CASE_") &&
  maskedClasses.length === expectedTokenClasses.length &&
  stable;

const evidence = Object.freeze({
  scenario: "privacy-egress-redaction",
  status: passed ? "PASS" : "FAIL",
  maskedClasses,
  rawMatchCount: rawMatches.length,
  lawQueryRawMatchCount: lawQueryRawMatches.length,
  lawQuery,
  stableTokens: stable,
  redacted,
});

const outputDirectory = evidenceDirectory(process.argv.slice(2));
await mkdir(outputDirectory, { recursive: true });
const outputPath = resolve(outputDirectory, "privacy-proof.json");
const serializedEvidence = sanitizeSecret(JSON.stringify(evidence, null, 2), process.env.LAW_OC);
await writeFile(outputPath, `${serializedEvidence}\n`, {
  encoding: "utf8",
  mode: 0o600,
});

console.log(
  sanitizeSecret(JSON.stringify({ ...evidence, evidencePath: outputPath }), process.env.LAW_OC),
);

if (!passed) {
  process.exitCode = 1;
}
