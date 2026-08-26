import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { extname, isAbsolute, resolve } from "node:path";
import { frozenResearchCutoff } from "./qa-wiki-contract.ts";
import { ledgerRecordSchema } from "./qa-wiki-records.ts";

export type Input = Readonly<{
  kind: "url" | "markdown" | "pdf";
  identity: string;
  raw: Uint8Array;
  rawHash: string;
  content: string;
  canonicalUrl: string;
  flags: readonly string[];
}>;

const cutoff = frozenResearchCutoff;
export const digest = (value: Uint8Array | string) =>
  createHash("sha256").update(value).digest("hex");
export const serial = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

export class IntakeError extends Error {
  public constructor(readonly code: string) {
    super(code);
  }
}

function mask(value: string): Readonly<{ text: string; flags: readonly string[] }> {
  const flags = new Set<string>();
  let text = value.replace(/\r\n?/gu, "\n").normalize("NFC").trim();
  const patterns: readonly [string, RegExp][] = [
    ["phone", /\b01[016789][ -]?\d{3,4}[ -]?\d{4}\b/gu],
    ["email", /\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/gu],
    ["resident", /\b\d{6}[ -]?[1-4]\d{6}\b/gu],
    ["account", /(?:계좌|은행)\s*[:：-]?\s*(?:\d{2,6}[ -]?){2,5}\d{2,6}/gu],
    ["name", /(?:성명|이름)\s*[:：-]?\s*[가-힣]{2,4}/gu],
    [
      "address",
      /(?:서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주)[가-힣0-9 -]{3,80}(?:로|길|동|읍|면|층|호)/gu,
    ],
  ];
  for (const [kind, pattern] of patterns) {
    if (pattern.test(text)) flags.add(`masked_${kind}`);
    pattern.lastIndex = 0;
    text = text.replace(pattern, `[MASKED:${kind}]`);
  }
  if (/(?:[가-힣]{2,4}(?:님|씨)|(?:주소|거주지)\s*[:：])/u.test(text))
    flags.add("mandatory_person_or_address_review");
  return {
    text: [...text].slice(0, 500).join("") || "[WITHHELD: empty extraction]",
    flags: [...flags].toSorted(),
  };
}

function urlInput(value: string): Input {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new IntakeError("INPUT_INVALID");
  }
  if (url.protocol !== "https:") throw new IntakeError("INPUT_INVALID");
  url.hash = "";
  url.search = "";
  const raw = new TextEncoder().encode(value);
  return {
    kind: "url",
    identity: `url:${url.toString()}`,
    raw,
    rawHash: digest(raw),
    content: "URL metadata reference only; download remote material locally before extraction.",
    canonicalUrl: url.toString(),
    flags: ["metadata_only", "mandatory_review"],
  };
}

function localInput(value: string): Input {
  const path = resolve(value);
  if (!isAbsolute(value) || !existsSync(path)) throw new IntakeError("INPUT_INVALID");
  const raw = readFileSync(path);
  const type = extname(path).toLowerCase();
  let content: string;
  if (type === ".md") content = new TextDecoder().decode(raw);
  else if (type === ".pdf") {
    const result = spawnSync("pdftotext", [path, "-"], { encoding: "utf8" });
    if (result.status !== 0 || result.stdout.trim().length === 0)
      throw new IntakeError("PDF_INVALID");
    content = result.stdout;
  } else throw new IntakeError("INPUT_INVALID");
  if (content.trim().length === 0) throw new IntakeError("INPUT_INVALID");
  const rawHash = digest(raw);
  return {
    kind: type === ".pdf" ? "pdf" : "markdown",
    identity: `content:${digest(content)}`,
    raw,
    rawHash,
    content,
    canonicalUrl: `https://local.invalid/intake/${rawHash}`,
    flags: [],
  };
}

export function readInputs(values: readonly string[]): readonly Input[] {
  if (values.length === 0) throw new IntakeError("ARGUMENTS");
  return values
    .map((value) => (value.startsWith("https://") ? urlInput(value) : localInput(value)))
    .toSorted((left, right) =>
      `${left.identity}:${left.rawHash}`.localeCompare(`${right.identity}:${right.rawHash}`),
    );
}

export function recordBundle(inputs: readonly Input[]) {
  const counts = new Map<string, number>();
  for (const input of inputs) counts.set(input.identity, (counts.get(input.identity) ?? 0) + 1);
  const records: unknown[][] = [[], [], [], [], []];
  const inventory = inputs.map((input, index) => {
    const number = String(index + 1).padStart(4, "0");
    const source = `SRC-EVIDENCE-${number}`;
    const observation = `OBS-EVIDENCE-${number}`;
    const claim = `CLM-EVIDENCE-${number}`;
    const masked = mask(input.content);
    const metadataOnly = input.kind === "url";
    const caveats = [
      ...new Set(["local draft; not verified", ...input.flags, ...masked.flags]),
    ].toSorted();
    records[0]?.push({
      record_type: "source",
      id: source,
      lane: "EVIDENCE",
      research_cutoff: cutoff,
      source_class: metadataOnly ? "metadata_only" : "secondary_professional",
      institution: "user-supplied local material",
      canonical_url: input.canonicalUrl,
      identifier: input.rawHash,
      publication_date: null,
      effective_date: null,
      accessed_at: cutoff,
      access_state: metadataOnly ? "metadata_only" : "full_text",
      independence_group: input.identity,
      quotation_license_basis: "no_quotation",
      confidence: "low",
      caveats,
      content_sha256: metadataOnly ? null : digest(input.content),
    });
    records[1]?.push({
      record_type: "observation",
      id: observation,
      lane: "EVIDENCE",
      research_cutoff: cutoff,
      source_id: source,
      locator_type: metadataOnly ? "metadata" : "paragraph",
      locator: metadataOnly ? "user URL reference" : "local extraction",
      excerpt: masked.text,
      captured_at: cutoff,
      excerpt_digest: digest(masked.text),
      caveats,
    });
    records[2]?.push({
      record_type: "claim",
      id: claim,
      lane: "EVIDENCE",
      research_cutoff: cutoff,
      claim_type: "evidence_guidance",
      statement: metadataOnly
        ? "URL reference retained as metadata only; remote material was not fetched."
        : "Local material retained as an unverified reported draft.",
      evidence_status: "reported",
      publication_status: masked.flags.includes("mandatory_person_or_address_review")
        ? "withheld"
        : "draft",
      scope_fit: "unknown",
      temporal_scope: { start_date: null, end_date: null, as_of_date: "2026-08-25" },
      supporting_observation_ids: [observation],
      counter_observation_ids: [],
      derived_from_claim_ids: [],
      case_family_id: null,
      confidence: "low",
      caveats,
    });
    records[3]?.push({
      record_type: "verification",
      id: `VRF-${number}`,
      research_cutoff: cutoff,
      claim_id: claim,
      method: "manual_review",
      outcome: "insufficient",
      observation_ids: [observation],
      reviewed_at: cutoff,
      reviewer_role: "researcher",
      caveats,
    });
    records[4]?.push({
      record_type: "coverage",
      id: `COV-EVIDENCE-${number}`,
      lane: "EVIDENCE",
      research_cutoff: cutoff,
      cell: `intake-${number}`,
      status: "reported",
      required_source_class: "primary_official_agency_guidance",
      claim_ids: [claim],
      source_ids: [source],
      searched_at: cutoff,
      gap_reason: null,
      caveats,
    });
    return {
      occurrence_id: `INTAKE-${number}`,
      kind: input.kind,
      raw_sha256: input.rawHash,
      content_sha256: metadataOnly ? null : digest(input.content),
      canonical_identity: input.identity,
      metadata_only: metadataOnly,
      duplicate: (counts.get(input.identity) ?? 0) > 1,
      review_flags: caveats,
      intended_destination: "manual P/R/index selection",
    };
  });
  for (const group of records) for (const record of group) ledgerRecordSchema.parse(record);
  return { records, inventory };
}

export function ledger(records: readonly unknown[]): string {
  return `# Generated draft ledger\n\n\`\`\`jsonl\n${records.map((record) => JSON.stringify(record)).join("\n")}\n\`\`\`\n`;
}
