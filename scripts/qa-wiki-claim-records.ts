import { z } from "zod";
import {
  hashSchema,
  idSchema,
  laneSchema,
  nonEmptyStrings,
  nullableDateSchema,
  researchCutoffSchema,
} from "./qa-wiki-contract.ts";

const temporalScopeSchema = z.strictObject({
  start_date: nullableDateSchema,
  end_date: nullableDateSchema,
  as_of_date: nullableDateSchema,
});

export const claimSchema = z
  .strictObject({
    record_type: z.literal("claim"),
    id: idSchema.regex(/^CLM-/),
    lane: laneSchema,
    research_cutoff: researchCutoffSchema,
    claim_type: z.enum([
      "terminology",
      "legal_rule",
      "procedural_rule",
      "evidence_guidance",
      "factual_case",
      "service_policy",
      "statistic",
      "prevention",
      "judgment",
      "service",
      "finality",
      "enforceable_title",
      "enforcement_action",
      "debtor_registry_entry",
      "actual_payment",
      "derived_synthesis",
      "repository_audit",
    ]),
    statement: z.string().min(1),
    evidence_status: z.enum(["candidate", "reported", "verified", "gap", "rejected"]),
    publication_status: z.enum(["draft", "published", "withheld", "superseded"]),
    scope_fit: z.enum(["target", "context_only", "out_of_scope", "unknown"]),
    temporal_scope: temporalScopeSchema,
    supporting_observation_ids: nonEmptyStrings,
    counter_observation_ids: nonEmptyStrings,
    derived_from_claim_ids: nonEmptyStrings,
    case_family_id: z.string().min(1).nullable(),
    confidence: z.enum(["high", "medium", "low"]),
    caveats: nonEmptyStrings,
    repository_binding: z
      .strictObject({
        source_id: idSchema.regex(/^SRC-/),
        observation_id: idSchema.regex(/^OBS-/),
        fact_kind: z.enum([
          "seed_disposition",
          "coverage_cell",
          "public_file",
          "saturation_wave",
          "repository_text",
        ]),
        subject_id: z.string().min(1),
        record_id: z.string().min(1),
        selected_fields: z.record(
          z.string(),
          z.union([z.string(), z.number(), z.boolean(), z.null()]),
        ),
        fact_digest: hashSchema,
        identity_digest: hashSchema,
        proposition: z.string().min(1),
      })
      .nullable()
      .optional(),
  })
  .superRefine((claim, context) => {
    if (claim.claim_type === "derived_synthesis") {
      if (claim.derived_from_claim_ids.length === 0)
        context.addIssue({
          code: "custom",
          path: ["derived_from_claim_ids"],
          message: "Derived claims need a parent.",
        });
      if (claim.supporting_observation_ids.length > 0)
        context.addIssue({
          code: "custom",
          path: ["supporting_observation_ids"],
          message: "Derived claims have no direct observations.",
        });
    } else if (claim.evidence_status !== "gap" && claim.supporting_observation_ids.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["supporting_observation_ids"],
        message: "Non-gap claims need an observation.",
      });
    }
    if (claim.claim_type === "repository_audit" && claim.repository_binding == null)
      context.addIssue({
        code: "custom",
        path: ["repository_binding"],
        message: "Repository audit claims bind one exact observation.",
      });
    if (claim.claim_type !== "repository_audit" && claim.repository_binding != null)
      context.addIssue({
        code: "custom",
        path: ["repository_binding"],
        message: "Only repository audit claims carry repository bindings.",
      });
    if (claim.evidence_status === "gap" && claim.supporting_observation_ids.length > 0)
      context.addIssue({
        code: "custom",
        path: ["supporting_observation_ids"],
        message: "Gap claims have no observations.",
      });
  });
