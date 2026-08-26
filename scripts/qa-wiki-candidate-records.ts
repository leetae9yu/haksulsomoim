import { z } from "zod";
import {
  laneSchema,
  nonEmptyStrings,
  researchCutoffSchema,
  timestampSchema,
} from "./qa-wiki-contract.ts";

export const candidateDispositionSchema = z.enum([
  "accepted_existing",
  "accepted_reported",
  "rejected_irrelevant",
  "rejected_weak",
  "duplicate_confirmation",
  "explicit_gap",
  "access_gap",
  "bounded_context",
  "superseded_by_canonical",
]);

export const candidateSchema = z.strictObject({
  record_type: z.literal("candidate"),
  id: z.string().regex(/^CAD-\d{4}$/),
  research_cutoff: researchCutoffSchema,
  candidate_identity: z.string().min(1),
  lanes: z
    .array(laneSchema.nullable())
    .min(1)
    .refine((values) => new Set(values).size === values.length),
  status: z.enum(["terminal", "queued"]),
  disposition: candidateDispositionSchema,
  material_novelty: z.boolean(),
  occurrence_ids: z
    .array(z.string().regex(/^CAO-\d{4}$/))
    .min(1)
    .refine((values) => new Set(values).size === values.length),
  caveats: nonEmptyStrings,
});

export const candidateOccurrenceSchema = z.strictObject({
  record_type: z.literal("candidate_occurrence"),
  id: z.string().regex(/^CAO-\d{4}$/),
  research_cutoff: researchCutoffSchema,
  candidate_id: z.string().regex(/^CAD-\d{4}$/),
  candidate_identity: z.string().min(1),
  source_occurrence_id: z.string().regex(/^CAN-\d{4}$/),
  candidate_key: z.string().min(1),
  lane: laneSchema.nullable(),
  origin_task: z.number().int().positive(),
  origin_type: z.string().min(1),
  origin_refs: nonEmptyStrings,
  evidence_refs: nonEmptyStrings,
  disposition: candidateDispositionSchema,
  material_novelty: z.boolean(),
  prompt_text_inert: z.literal(true),
  resolved_at: timestampSchema,
});
