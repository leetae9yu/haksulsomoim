import { z } from "zod";
import { candidateOccurrenceSchema, candidateSchema } from "./qa-wiki-candidate-records.ts";
import { claimSchema } from "./qa-wiki-claim-records.ts";
import {
  hashSchema,
  idSchema,
  laneSchema,
  nonEmptyStrings,
  observationSchema,
  researchCutoffSchema,
  sourceClassSchema,
  sourceSchema,
  timestampSchema,
} from "./qa-wiki-contract.ts";
import { candidateReviewSchema, cellQueryMappingSchema } from "./qa-wiki-methodology-records.ts";
import { publicRenderRecordSchema } from "./qa-wiki-public-records.ts";

export const verificationSchema = z.strictObject({
  record_type: z.literal("verification"),
  id: z.string().regex(/^VRF-\d{4}$/),
  research_cutoff: researchCutoffSchema,
  claim_id: idSchema.regex(/^CLM-/),
  method: z.enum([
    "source_identity",
    "primary_source_trace",
    "counter_search",
    "date_recheck",
    "manual_review",
    "automated_check",
  ]),
  outcome: z.enum(["confirmed", "contradicted", "insufficient"]),
  observation_ids: nonEmptyStrings,
  reviewed_at: timestampSchema,
  reviewer_role: z.enum(["researcher", "reviewer", "validator"]),
  caveats: nonEmptyStrings,
  repository_fact_digest: hashSchema.nullable().optional(),
});

export const conflictSchema = z.strictObject({
  record_type: z.literal("conflict"),
  id: z.string().regex(/^CNF-\d{4}$/),
  research_cutoff: researchCutoffSchema,
  claim_ids: z.array(idSchema.regex(/^CLM-/)).min(2),
  conflict_type: z.enum([
    "fact",
    "legal_interpretation",
    "temporal_validity",
    "scope",
    "statistic_definition",
    "source_identity",
  ]),
  status: z.enum(["open", "resolved", "superseded"]),
  resolution: z.string().min(1).nullable(),
  resolved_by_verification_id: z
    .string()
    .regex(/^VRF-\d{4}$/)
    .nullable(),
  caveats: nonEmptyStrings,
});

export const redirectSchema = z.strictObject({
  record_type: z.literal("redirect"),
  id: z.string().regex(/^RDR-\d{4}$/),
  research_cutoff: researchCutoffSchema,
  from_ref: z.string().min(1),
  to_ref: z.string().min(1),
  reason: z.enum(["renamed_note", "superseded_claim", "duplicate_source", "case_family_link"]),
  status: z.enum(["active", "retired"]),
});

export const coverageSchema = z
  .strictObject({
    record_type: z.literal("coverage"),
    id: z
      .string()
      .regex(
        /^COV-(?:SCOPE|FRAUD|EVIDENCE|CRIMINAL|COMPENSATION|CIVIL|SERVICE|TITLE|ENFORCEMENT|SAFETY|PAYMENT|STATISTICS)-\d{4}$/,
      ),
    lane: laneSchema,
    research_cutoff: researchCutoffSchema,
    cell: z.string().min(1),
    status: z.enum(["verified", "reported", "gap"]),
    required_source_class: sourceClassSchema,
    claim_ids: nonEmptyStrings,
    source_ids: nonEmptyStrings,
    searched_at: timestampSchema,
    gap_reason: z.string().min(1).nullable(),
    caveats: nonEmptyStrings,
  })
  .superRefine((coverage, context) => {
    if (
      coverage.status === "verified" &&
      (coverage.claim_ids.length === 0 ||
        coverage.source_ids.length === 0 ||
        coverage.gap_reason !== null)
    )
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "Verified coverage needs claims and sources.",
      });
    if (
      coverage.status === "reported" &&
      (coverage.claim_ids.length === 0 || coverage.gap_reason !== null)
    )
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "Reported coverage needs claims.",
      });
    if (
      coverage.status === "gap" &&
      (coverage.claim_ids.length > 0 ||
        coverage.source_ids.length > 0 ||
        coverage.gap_reason === null)
    )
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "Gap coverage has no evidence references.",
      });
  });

export const saturationSchema = z.strictObject({
  record_type: z.literal("saturation"),
  id: z.string().regex(/^SAT-\d{4}$/),
  research_cutoff: researchCutoffSchema,
  scope: z.union([z.literal("global"), laneSchema]),
  wave: z.number().int().positive(),
  query_manifest_sha256: hashSchema,
  query_identity_sha256s: z.array(hashSchema).min(1),
  coverage_matrix_sha256: hashSchema,
  searched_at: timestampSchema,
  candidate_identity_count: z.number().int().nonnegative(),
  candidate_occurrence_count: z.number().int().nonnegative(),
  candidate_queue_count: z.number().int().nonnegative(),
  material_novelty_count: z.number().int().nonnegative(),
  coverage_proof_status: z
    .enum(["unassessed", "inadequate", "cell_adequate"])
    .default("unassessed"),
  cell_query_mappings: z.array(cellQueryMappingSchema).default([]),
  prior_wave_id: z
    .string()
    .regex(/^SAT-\d{4}$/)
    .nullable(),
  status: z.enum(["incomplete", "active", "saturated"]),
  caveats: nonEmptyStrings,
});

export const seedDispositionSchema = z.strictObject({
  record_type: z.literal("seed_disposition"),
  id: z.string().regex(/^SED-\d{4}$/),
  research_cutoff: researchCutoffSchema,
  seed_id: z.string().regex(/^(?:P|R)\d{1,2}$|^INDEX-0001$/),
  filename: z.string().min(1),
  task1_seed_sha256: hashSchema,
  verdict: z.enum(["keep", "augment", "context_only", "unverified", "replace_content_keep_id"]),
  scope_fit: z.enum(["target", "context_only", "out_of_scope", "unknown"]),
  source_quality: z.enum(["primary", "secondary", "anecdotal", "mixed", "unknown"]),
  missing_urls: nonEmptyStrings,
  factual_conflicts: nonEmptyStrings,
  duplicate_family: z.string().min(1).nullable(),
  primary_follow_up: z.string().min(1),
  intended_destination: z.string().min(1),
  caveats: nonEmptyStrings,
});

export const ledgerRecordSchema = z.discriminatedUnion("record_type", [
  sourceSchema,
  observationSchema,
  claimSchema,
  verificationSchema,
  conflictSchema,
  redirectSchema,
  coverageSchema,
  saturationSchema,
  seedDispositionSchema,
  candidateSchema,
  candidateOccurrenceSchema,
  candidateReviewSchema,
  publicRenderRecordSchema,
]);
