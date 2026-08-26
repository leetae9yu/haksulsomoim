import { z } from "zod";

export const lanes = [
  "SCOPE",
  "FRAUD",
  "EVIDENCE",
  "CRIMINAL",
  "COMPENSATION",
  "CIVIL",
  "SERVICE",
  "TITLE",
  "ENFORCEMENT",
  "SAFETY",
  "PAYMENT",
  "STATISTICS",
] as const;

export const laneSchema = z.enum(lanes);
export const frozenResearchCutoff = "2026-08-25T06:42:44Z";
export const timestampSchema = z.iso
  .datetime({ offset: true, precision: 0 })
  .refine((value) => value.endsWith("Z"));
export const researchCutoffSchema = timestampSchema.refine(
  (value) => value === frozenResearchCutoff,
);
export const nullableDateSchema = z.iso.date().nullable();
export const idSchema = z
  .string()
  .regex(
    /^(?:(?:SRC|OBS|CLM)-(?:SCOPE|FRAUD|EVIDENCE|CRIMINAL|COMPENSATION|CIVIL|SERVICE|TITLE|ENFORCEMENT|SAFETY|PAYMENT|STATISTICS)-\d{4}|(?:OBS|CLM)-AUDIT-[a-f0-9]{16})$/,
  );
export const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const nonEmptyStrings = z
  .array(z.string().min(1))
  .refine((values) => new Set(values).size === values.length);
export const sourceClassSchema = z.enum([
  "primary_official_statute",
  "primary_official_judgment",
  "primary_official_court_rule_or_form",
  "primary_official_agency_guidance",
  "primary_official_statistics",
  "secondary_academic",
  "secondary_news",
  "secondary_professional",
  "platform_policy",
  "anecdote",
  "search_snippet",
  "ai_summary",
  "metadata_only",
  "inaccessible",
  "repository_artifact",
]);

export const sourceSchema = z
  .strictObject({
    record_type: z.literal("source"),
    id: idSchema.regex(/^SRC-/),
    lane: laneSchema,
    research_cutoff: researchCutoffSchema,
    source_class: sourceClassSchema,
    institution: z.string().min(1),
    canonical_url: z.string().regex(/^(?:https:\/\/|repo:\/\/wiki\/).+/),
    identifier: z.string().min(1),
    publication_date: nullableDateSchema,
    effective_date: nullableDateSchema,
    accessed_at: timestampSchema,
    access_state: z.enum([
      "full_text",
      "partial_text",
      "metadata_only",
      "inaccessible",
      "discovery_only",
      "repository_snapshot",
    ]),
    independence_group: z.string().min(1),
    quotation_license_basis: z.enum([
      "public_law",
      "public_judgment",
      "government_publication",
      "fair_quotation",
      "permission",
      "no_quotation",
    ]),
    confidence: z.enum(["high", "medium", "low"]),
    caveats: nonEmptyStrings,
    content_sha256: hashSchema.nullable(),
    repository_commit: z
      .string()
      .regex(/^[a-f0-9]{40}$/)
      .nullable()
      .optional(),
    repository_path: z
      .string()
      .regex(/^wiki\/.+\.md$/)
      .nullable()
      .optional(),
    repository_blob_sha256: hashSchema.nullable().optional(),
  })
  .superRefine((source, context) => {
    const repository = source.source_class === "repository_artifact";
    if (
      repository &&
      (!source.canonical_url.startsWith("repo://wiki/") ||
        source.access_state !== "repository_snapshot" ||
        source.content_sha256 === null ||
        source.repository_commit === null ||
        source.repository_path === null ||
        source.repository_blob_sha256 === null)
    )
      context.addIssue({
        code: "custom",
        path: ["repository_path"],
        message: "Repository artifacts need an exact repository binding.",
      });
    if (
      !repository &&
      (source.repository_commit != null ||
        source.repository_path != null ||
        source.repository_blob_sha256 != null)
    )
      context.addIssue({
        code: "custom",
        path: ["repository_path"],
        message: "Only repository artifacts carry repository bindings.",
      });
  });

export const observationSchema = z.strictObject({
  record_type: z.literal("observation"),
  id: idSchema.regex(/^OBS-/),
  lane: laneSchema,
  research_cutoff: researchCutoffSchema,
  source_id: idSchema.regex(/^SRC-/),
  locator_type: z.enum([
    "article",
    "section",
    "paragraph",
    "page",
    "table",
    "heading",
    "search_result",
    "metadata",
    "repository_record",
  ]),
  locator: z.string().min(1),
  excerpt: z.string().min(1).max(500),
  captured_at: timestampSchema,
  excerpt_digest: hashSchema,
  caveats: nonEmptyStrings,
  repository_record_id: z.string().min(1).nullable().optional(),
  repository_fact_kind: z
    .enum([
      "seed_disposition",
      "coverage_cell",
      "public_file",
      "saturation_wave",
      "repository_text",
    ])
    .nullable()
    .optional(),
  repository_selected_fields: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
    .nullable()
    .optional(),
  repository_fact_digest: hashSchema.nullable().optional(),
  repository_identity_digest: hashSchema.nullable().optional(),
});

export const legacySchemas = {
  P: z.strictObject({
    id: z.string().regex(/^P(?:10|[1-9])$/),
    유형: z.string(),
    사건명: z.string(),
    법원_출처: z.string(),
    사건번호: z.string(),
    수법유형: z.string(),
    자료유형: z.string(),
    출처: z.string(),
    tags: z.array(z.string()),
  }),
  R: z.strictObject({
    id: z.string().regex(/^R(?:10|[1-9])$/),
    유형: z.string(),
    사건명: z.string(),
    절차구분: z.string(),
    진행상태: z.string(),
    결과유형: z.string(),
    수법유형: z.string(),
    자료유형: z.string(),
    출처: z.string(),
    tags: z.array(z.string()),
  }),
  index: z.strictObject({
    id: z.literal("INDEX-0001"),
    유형: z.string(),
    제목: z.string(),
    tags: z.array(z.string()),
  }),
} as const;
