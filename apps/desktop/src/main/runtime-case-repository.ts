import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { link, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { confirmOcrFacts, parseCaseInput } from "../domain/case-workflow";
import type { RuntimeCaseDossier, RuntimeCaseRepository } from "./runtime-case-types";

const factSchema = z.strictObject({
  field: z.string().min(1).max(255),
  value: z.string().min(1).max(4096),
});
const citationSchema = z.strictObject({
  citationId: z.string().regex(/^[a-f0-9]{64}$/),
  sourceUrl: z.string().url().max(2048),
  law: z.string().min(1).max(1000),
  versionDate: z.string().min(1).max(100),
  retrievedAt: z.string().datetime(),
  toolName: z.enum([
    "legal_research",
    "legal_analysis",
    "search_law",
    "get_law_text",
    "get_annexes",
    "search_decisions",
    "get_decision_text",
  ]),
  resultDigest: z.string().regex(/^[a-f0-9]{64}$/),
});
const persistedDossierSchema = z.strictObject({
  caseId: z.string().min(1).max(255),
  amountKrw: z.number().int().min(1).max(30_000_000),
  evidence: z.array(
    z.strictObject({
      evidenceId: z.string().min(1).max(255),
      filename: z.string().min(1).max(255),
      mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
    }),
  ),
  confirmedOcrFacts: z.array(factSchema),
  retrievedCitations: z.array(citationSchema).default([]),
  workflow: z.strictObject({
    criminalState: z.enum(["evidence-review", "complaint-ready", "complaint-filed"]),
    civilState: z.enum([
      "pre-filing",
      "payment-order-pending",
      "service-attested",
      "judgment-recorded",
      "enforceable-title-confirmed",
    ]),
  }),
});
const encryptedRecordSchema = z.strictObject({
  version: z.literal(1),
  nonce: z.string(),
  ciphertext: z.string(),
  authTag: z.string(),
});

type PersistedDossier = z.infer<typeof persistedDossierSchema>;

function persisted(dossier: RuntimeCaseDossier): PersistedDossier {
  return {
    caseId: dossier.caseId,
    amountKrw: dossier.amountKrw,
    evidence: dossier.evidence.map((item) => ({ ...item })),
    confirmedOcrFacts: dossier.confirmedOcrFacts.map((fact) => ({ ...fact })),
    retrievedCitations: dossier.retrievedCitations.map((citation) => ({ ...citation })),
    workflow: {
      criminalState: dossier.workflow.criminalState,
      civilState: dossier.workflow.civilState,
    },
  };
}

function restore(input: unknown): RuntimeCaseDossier {
  const dossier = persistedDossierSchema.parse(input);
  const facts =
    dossier.confirmedOcrFacts.length > 0
      ? dossier.confirmedOcrFacts
      : [{ field: "claimed-amount", value: String(dossier.amountKrw) }];
  const parsed = parseCaseInput({
    jurisdiction: "KR-domestic",
    paymentMethod: "bank-transfer",
    currency: "KRW",
    amount: dossier.amountKrw,
    ocrFacts: facts,
  });
  if (parsed.status !== "accepted") throw new Error("Persisted case workflow is invalid");
  const workflow =
    dossier.confirmedOcrFacts.length > 0
      ? confirmOcrFacts(parsed.value)
      : { status: "ok" as const, value: parsed.value };
  if (workflow.status !== "ok") throw new Error("Persisted OCR workflow is invalid");
  return {
    ...dossier,
    workflow: {
      ...workflow.value,
      criminalState: dossier.workflow.criminalState,
      civilState: dossier.workflow.civilState,
    },
  };
}

export class EncryptedRuntimeCaseRepository implements RuntimeCaseRepository {
  readonly #directory: string;
  readonly #key: Uint8Array;

  constructor(directory: string, key: Uint8Array) {
    if (key.byteLength !== 32) throw new RangeError("AES-256-GCM requires a 32-byte key");
    this.#directory = directory;
    this.#key = Uint8Array.from(key);
  }

  async create(dossier: RuntimeCaseDossier): Promise<void> {
    await this.#write(dossier, true);
  }

  async read(caseId: string): Promise<RuntimeCaseDossier> {
    const locator = this.#locator(caseId);
    const serialized = await readFile(join(this.#directory, `${locator}.json`), "utf8");
    const record = encryptedRecordSchema.parse(JSON.parse(serialized));
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.#key,
      Buffer.from(record.nonce, "base64"),
    );
    decipher.setAAD(Buffer.from(locator));
    decipher.setAuthTag(Buffer.from(record.authTag, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(record.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
    const dossier = restore(JSON.parse(plaintext));
    if (dossier.caseId !== caseId) throw new Error("Case locator does not match its dossier");
    return dossier;
  }

  async save(dossier: RuntimeCaseDossier): Promise<void> {
    await this.read(dossier.caseId);
    await this.#write(dossier, false);
  }

  async #write(dossier: RuntimeCaseDossier, exclusive: boolean): Promise<void> {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const locator = this.#locator(dossier.caseId);
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, nonce);
    cipher.setAAD(Buffer.from(locator));
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(persisted(dossier))),
      cipher.final(),
    ]);
    const serialized = JSON.stringify({
      version: 1,
      nonce: nonce.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64"),
    });
    const path = join(this.#directory, `${locator}.json`);
    const temporary = join(this.#directory, `.${randomBytes(12).toString("hex")}.tmp`);
    try {
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(serialized, "utf8");
        await file.sync();
      } finally {
        await file.close();
      }
      if (exclusive) {
        await link(temporary, path);
        await unlink(temporary);
      } else {
        await rename(temporary, path);
      }
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  #locator(caseId: string): string {
    if (caseId.length === 0) throw new TypeError("A case ID is required");
    return createHmac("sha256", this.#key)
      .update("haksulsomoim:runtime-case:v1\0")
      .update(caseId)
      .digest("hex");
  }
}
