import { z } from "zod";

export const caseIdSchema = z.string().regex(/^case-[a-f0-9]{16}$/);
const isoDate = z.iso.date();
const isoDateTime = z.iso.datetime({ offset: true });

export const caseCreateInputSchema = z.strictObject({
  amountKrw: z.number().int().min(1).max(30_000_000),
  occurredAt: isoDate,
  summary: z.string().trim().min(1).max(2_000),
  counterpartyAlias: z.string().trim().min(1).max(100).optional(),
});

export const evidenceKindSchema = z.enum([
  "transfer-receipt",
  "conversation",
  "listing",
  "report",
  "court-document",
  "other",
]);

export const evidenceAddInputSchema = z.strictObject({
  caseId: caseIdSchema,
  path: z.string().trim().min(1).max(4_096),
  kind: evidenceKindSchema,
  description: z.string().trim().min(1).max(500),
});

export const criminalStageSchema = z.enum([
  "evidence-review",
  "complaint-ready",
  "complaint-filed",
]);

export const civilStageSchema = z.enum([
  "pre-filing",
  "payment-order-pending",
  "service-attested",
  "judgment-recorded",
  "enforceable-title-confirmed",
]);

export const trackUpdateInputSchema = z.discriminatedUnion("track", [
  z.strictObject({
    caseId: caseIdSchema,
    track: z.literal("criminal"),
    stage: criminalStageSchema,
  }),
  z.strictObject({
    caseId: caseIdSchema,
    track: z.literal("civil"),
    stage: civilStageSchema,
  }),
]);

export const evidenceRecordSchema = z.strictObject({
  evidenceId: z.string().regex(/^evidence-[a-f0-9]{16}$/),
  kind: evidenceKindSchema,
  path: z.string().min(1),
  description: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  addedAt: isoDateTime,
});

export const caseRecordSchema = z.strictObject({
  version: z.literal(1),
  caseId: caseIdSchema,
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
  amountKrw: z.number().int().min(1).max(30_000_000),
  occurredAt: isoDate,
  summary: z.string().min(1).max(2_000),
  counterpartyAlias: z.string().min(1).max(100).optional(),
  evidence: z.array(evidenceRecordSchema),
  criminalStage: criminalStageSchema,
  civilStage: civilStageSchema,
});

export type CaseCreateInput = z.infer<typeof caseCreateInputSchema>;
export type EvidenceAddInput = z.infer<typeof evidenceAddInputSchema>;
export type TrackUpdateInput = z.infer<typeof trackUpdateInputSchema>;
export type EvidenceRecord = z.infer<typeof evidenceRecordSchema>;
export type CaseRecord = z.infer<typeof caseRecordSchema>;

export type MaskedCaseSummary = Readonly<{
  caseId: string;
  amountKrw: number;
  occurredAt: string;
  summary: string;
  counterpartyAlias?: string;
  evidenceCount: number;
  criminalStage: CaseRecord["criminalStage"];
  civilStage: CaseRecord["civilStage"];
  updatedAt: string;
}>;
