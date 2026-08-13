import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { link, mkdir, open, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { type AgentArtifactView, agentArtifactViewSchema } from "./agent-artifact-ipc-contracts";
import {
  agentArtifactIdSchema,
  caseIdSchema,
  observationDigestSchema,
} from "./agent-contracts-core";

const artifactKindSchema = z.enum(["civil-demand", "criminal-complaint"]);
const recordSchema = z.strictObject({
  version: z.literal(1),
  caseId: caseIdSchema,
  artifactId: agentArtifactIdSchema,
  sourceObservationDigest: observationDigestSchema,
  view: agentArtifactViewSchema,
});
const envelopeSchema = z.strictObject({
  version: z.literal(1),
  nonce: z.string().regex(/^[A-Za-z0-9+/]{16}$/),
  ciphertext: z.string().min(1).max(64_000),
  authTag: z.string().regex(/^[A-Za-z0-9+/]{22}==$/),
});

type ArtifactRecord = z.infer<typeof recordSchema>;
export type AgentArtifactWriteInput = Readonly<{
  caseId: string;
  artifactKind: z.infer<typeof artifactKindSchema>;
  contentDigest: string;
  idempotencyKey: string;
  maskedFacts: readonly Readonly<{ id: string; text: string }>[];
  citationIds: readonly string[];
}>;
export type AgentArtifactAccess = Readonly<{
  view: AgentArtifactView;
  sourceObservationDigest: string;
}>;

function nodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export class EncryptedAgentArtifactStore {
  readonly #directory: string;
  readonly #key: Uint8Array;

  constructor(directory: string, encryptionKey: Uint8Array) {
    if (directory.length === 0) throw new TypeError("An Agent artifact directory is required");
    if (encryptionKey.byteLength !== 32) throw new RangeError("AES-256-GCM requires a 32-byte key");
    this.#directory = directory;
    this.#key = Uint8Array.from(encryptionKey);
  }

  async write(input: AgentArtifactWriteInput) {
    const artifactKind = artifactKindSchema.parse(input.artifactKind);
    const caseId = caseIdSchema.parse(input.caseId);
    const sourceObservationDigest = observationDigestSchema.parse(input.contentDigest);
    if (input.citationIds.length === 0) throw new Error("A cited Agent artifact is required");
    const artifactId = agentArtifactIdSchema.parse(
      createHmac("sha256", this.#key)
        .update(JSON.stringify(["agent-artifact-v1", caseId, input.idempotencyKey]))
        .digest("hex")
        .slice(0, 32),
    );
    const title =
      artifactKind === "civil-demand" ? "민사 지급명령 검토 초안" : "형사 고소 자료 검토 초안";
    const facts = input.maskedFacts
      .slice(0, 100)
      .map((fact) => `${fact.id}: ${fact.text}`)
      .join("\n")
      .slice(0, 4_000);
    const view = agentArtifactViewSchema.parse({
      artifactId,
      artifactKind,
      title,
      sections: [
        {
          heading: "마스킹된 사건 사실",
          text: facts.length === 0 ? "확인된 마스킹 사실이 없습니다." : facts,
        },
        {
          heading: "공식 근거 연결",
          text: `${input.citationIds.length}건의 공식 법령 인용과 연결된 앱 내부 초안입니다.`,
        },
      ],
      citationIds: input.citationIds,
    });
    const record = recordSchema.parse({
      version: 1,
      caseId,
      artifactId,
      sourceObservationDigest,
      view,
    });
    await this.#publish(record);
    return { status: "ok" as const, artifactId };
  }

  async open(caseId: string, artifactId: string): Promise<AgentArtifactAccess> {
    const expectedCaseId = caseIdSchema.parse(caseId);
    const expectedArtifactId = agentArtifactIdSchema.parse(artifactId);
    const record = await this.#read(expectedArtifactId);
    if (record.caseId !== expectedCaseId || record.artifactId !== expectedArtifactId) {
      throw new Error("Agent artifact does not belong to the requested case");
    }
    return { view: record.view, sourceObservationDigest: record.sourceObservationDigest };
  }

  async #publish(record: ArtifactRecord): Promise<void> {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const finalPath = this.#path(record.artifactId);
    const temporaryPath = join(this.#directory, `.artifact-${randomBytes(12).toString("hex")}`);
    const file = await open(temporaryPath, "wx", 0o600);
    try {
      await file.writeFile(this.#encrypt(record), "utf8");
      await file.sync();
      await file.close();
      try {
        await link(temporaryPath, finalPath);
      } catch (error) {
        if (!nodeError(error, "EEXIST")) throw error;
        const existing = await this.#read(record.artifactId);
        if (JSON.stringify(existing) !== JSON.stringify(record)) {
          throw new Error("Agent artifact idempotency identity changed");
        }
      }
      await unlink(temporaryPath);
      const directory = await open(this.#directory, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch (error) {
      await file.close().catch(() => undefined);
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  async #read(artifactId: string): Promise<ArtifactRecord> {
    const serialized = await readFile(this.#path(artifactId), "utf8");
    const envelope = envelopeSchema.parse(JSON.parse(serialized));
    const nonce = Buffer.from(envelope.nonce, "base64");
    const decipher = createDecipheriv("aes-256-gcm", this.#key, nonce);
    decipher.setAAD(Buffer.from(`agent-artifact-v1:${artifactId}`));
    decipher.setAuthTag(Buffer.from(envelope.authTag, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
    return recordSchema.parse(JSON.parse(plaintext));
  }

  #encrypt(record: ArtifactRecord): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, nonce);
    cipher.setAAD(Buffer.from(`agent-artifact-v1:${record.artifactId}`));
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(record), "utf8"),
      cipher.final(),
    ]);
    return JSON.stringify({
      version: 1,
      nonce: nonce.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64"),
    });
  }

  #path(artifactId: string): string {
    return join(this.#directory, `${artifactId}.json`);
  }
}
