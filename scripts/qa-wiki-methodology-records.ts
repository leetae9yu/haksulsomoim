import { z } from "zod";
import { candidateDispositionSchema } from "./qa-wiki-candidate-records.ts";
import {
  hashSchema,
  nonEmptyStrings,
  researchCutoffSchema,
  timestampSchema,
} from "./qa-wiki-contract.ts";

const retrievalSchema = z.strictObject({
  status: z.enum(["retrieved", "unavailable"]),
  url: z.string().min(1),
  request_started_at: timestampSchema,
  response_received_at: timestampSchema,
  response_status: z.number().int().min(100).max(599).nullable(),
  response_sha256: hashSchema.nullable(),
  response_bytes: z.number().int().nonnegative().nullable(),
});

const responseParserSchema = z.discriminatedUnion("method", [
  z.strictObject({ method: z.literal("law_search_json"), target: z.enum(["prec", "law"]) }),
  z.strictObject({ method: z.literal("official_html_results"), profile: z.string().min(1) }),
  z.strictObject({
    method: z.literal("content_terms"),
    candidate_url: z.string().url().startsWith("https://"),
  }),
]);

const accessErrorSchema = z.strictObject({
  kind: z.enum(["dns", "transport"]),
  code: z.string().min(1),
  message: z.string().min(1),
});

const canonicalTargetSchema = z.strictObject({
  record_type: z.enum(["source", "candidate_occurrence"]),
  id: z.string().regex(/^(?:SRC-[A-Z]+-\d{4}|CAO-\d{4})$/),
  canonical_url: z.string().min(1),
});

export const candidateReviewSchema = z.strictObject({
  record_type: z.literal("candidate_review"),
  id: z.string().regex(/^CRV-\d{4}$/),
  research_cutoff: researchCutoffSchema,
  candidate_occurrence_id: z.string().regex(/^CAO-\d{4}$/),
  query_id: z.string().regex(/^[A-Z]-[A-Z]+-\d{2}$/),
  candidate_url: z.string().min(1),
  disposition: candidateDispositionSchema,
  retrieval: retrievalSchema.nullable(),
  canonical_target: canonicalTargetSchema.nullable(),
  rationale: z.string().min(1),
  reviewed_at: timestampSchema,
  material_novelty: z.boolean(),
  caveats: nonEmptyStrings,
});

export const cellQueryMappingSchema = z.strictObject({
  coverage_id: z.string().regex(/^COV-[A-Z]+-\d{4}$/),
  lane: z.string().min(1),
  cell: z.string().min(1),
  query_id: z.string().regex(/^[A-Z]-[A-Z]+-\d{2}$/),
  query_identity_sha256: hashSchema,
  query_text: z.string().min(1),
  target_proposition: z.string().min(1),
  semantic_terms: z
    .array(z.string().min(2))
    .min(2)
    .refine((values) => new Set(values).size === values.length),
  response_parser: responseParserSchema,
  request_method: z.enum(["GET", "POST"]),
  request_url: z.string().url().startsWith("https://"),
  request_body: z.string().nullable(),
  request_started_at: timestampSchema,
  response_received_at: timestampSchema,
  response_status: z.number().int().min(100).max(599).nullable(),
  response_url: z.string().url().startsWith("https://"),
  response_sha256: hashSchema.nullable(),
  response_bytes: z.number().int().nonnegative().nullable(),
  access_state: z.enum(["retrieved", "access_gap"]),
  access_error: accessErrorSchema.nullable(),
  result_count: z.number().int().nonnegative(),
  result_occurrence_ids: z
    .array(z.string().regex(/^CAO-\d{4}$/))
    .refine((values) => new Set(values).size === values.length),
  result_receipt_sha256: hashSchema,
  reviewed_at: timestampSchema,
  adjudication: z.string().min(1),
  material_novelty_count: z.number().int().nonnegative(),
  candidate_queue_before_review: z.number().int().nonnegative(),
  candidate_queue_after_review: z.number().int().nonnegative(),
});
