import { z } from "zod";
import {
  hashSchema,
  nonEmptyStrings,
  researchCutoffSchema,
  timestampSchema,
} from "./qa-wiki-contract.ts";

const renderId = z.string().regex(/^PRM-\d{4}$/);
const fileId = z.string().regex(/^PRF-\d{4}$/);
const citationId = z.string().regex(/^PRC-\d{4}$/);
const rootPath = z.string().regex(/^[^/]+\.md$/);
const seedId = z.string().regex(/^(?:P|R)\d{1,2}$|^INDEX-0001$/);
const claimId = z.string().regex(/^CLM-(?:[A-Z]+-\d{4}|AUDIT-[a-f0-9]{16})$/);

export const publicRenderSchema = z.strictObject({
  record_type: z.literal("public_render"),
  id: renderId,
  research_cutoff: researchCutoffSchema,
  rendered_at: timestampSchema,
  task10_commit: z.string().regex(/^[a-f0-9]{40}$/),
  coverage_sha256: hashSchema,
  seed_audit_sha256: hashSchema,
  seed_dispositions_sha256: hashSchema,
  caveats: nonEmptyStrings,
});

export const publicFileSchema = z.strictObject({
  record_type: z.literal("public_file"),
  id: fileId,
  manifest_id: renderId,
  path: rootPath,
  public_id: z.string().min(1).nullable(),
  sha256: hashSchema,
  seed_id: seedId.nullable(),
  seed_disposition_id: z
    .string()
    .regex(/^SED-\d{4}$/)
    .nullable(),
  task1_seed_sha256: hashSchema.nullable(),
});

export const publicCitationSchema = z.strictObject({
  record_type: z.literal("public_citation"),
  id: citationId,
  manifest_id: renderId,
  path: rootPath,
  paragraph_sha256: hashSchema,
  claim_id: claimId,
  evidence_status: z.enum(["candidate", "reported", "verified", "gap", "rejected"]),
  publication_status: z.enum(["draft", "published", "withheld", "superseded"]),
  qualifier_class: z.enum(["published", "draft", "reported", "rejected", "withheld", "context"]),
  locator: z.string().min(1).max(160),
  rationale: z.string().min(1).max(240),
});

const reportRenderId = z.string().regex(/^RRM-\d{4}$/);
const reportAssertionId = z.string().regex(/^RRA-\d{4}$/);
const reportBindingSchema = z.strictObject({
  claim_id: claimId,
  evidence_status: z.enum(["candidate", "reported", "verified", "gap", "rejected"]),
  publication_status: z.enum(["draft", "published", "withheld", "superseded"]),
  qualifier_class: z.enum(["published", "draft", "reported", "rejected", "withheld", "context"]),
  rationale: z.string().min(1).max(240),
  exact_statement: z.boolean().optional(),
  repository_fact: z
    .strictObject({
      fact_kind: z.enum([
        "seed_disposition",
        "coverage_cell",
        "public_file",
        "saturation_wave",
        "repository_text",
      ]),
      subject_id: z.string().min(1),
      record_id: z.string().min(1),
      fact_digest: hashSchema,
    })
    .nullable()
    .optional(),
});

export const reportRenderSchema = z.strictObject({
  record_type: z.literal("report_render"),
  id: reportRenderId,
  research_cutoff: researchCutoffSchema,
  rendered_at: timestampSchema,
  report_sha256: hashSchema,
  task10_commit: z.string().regex(/^[a-f0-9]{40}$/),
  task11_commit: z.string().regex(/^[a-f0-9]{40}$/),
  task12_commit: z.string().regex(/^[a-f0-9]{40}$/),
  ledger_sha256s: z.record(z.string(), hashSchema).refine((value) => Object.keys(value).length > 0),
  required_sections: z.array(z.string().min(1)).min(1),
  caveats: nonEmptyStrings,
});

export const reportAssertionSchema = z.strictObject({
  record_type: z.literal("report_assertion"),
  id: reportAssertionId,
  manifest_id: reportRenderId,
  path: z.literal("report.md"),
  section: z.string().min(1),
  kind: z.enum(["paragraph", "table_row"]),
  content_sha256: hashSchema,
  claim_bindings: z.array(reportBindingSchema).min(1),
});

export const publicRenderRecordSchema = z.discriminatedUnion("record_type", [
  publicRenderSchema,
  publicFileSchema,
  publicCitationSchema,
  reportRenderSchema,
  reportAssertionSchema,
]);
