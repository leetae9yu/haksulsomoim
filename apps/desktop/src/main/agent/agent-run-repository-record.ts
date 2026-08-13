import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { link, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { agentRunSchema } from "./agent-contracts";

const snapshotSchema = z
  .strictObject({
    run: agentRunSchema,
    cursor: z.number().int().min(0).max(41),
  })
  .superRefine((snapshot, context) => {
    if (snapshot.cursor > snapshot.run.steps.length) {
      context.addIssue({
        code: "custom",
        message: "Agent run cursor exceeds its history",
        path: ["cursor"],
      });
    }
  })
  .readonly();

const encryptedRecordSchema = z.strictObject({
  version: z.literal(1),
  nonce: z.string().min(1),
  ciphertext: z.string().min(1),
  authTag: z.string().min(1),
});

export type AgentRunSnapshot = z.infer<typeof snapshotSchema>;

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export class AgentRunAlreadyExistsError extends Error {
  readonly code = "AGENT_RUN_ALREADY_EXISTS";

  constructor(options?: ErrorOptions) {
    super("Agent run already exists", options);
    this.name = "AgentRunAlreadyExistsError";
  }
}

export class AgentRunNotFoundError extends Error {
  readonly code = "AGENT_RUN_NOT_FOUND";

  constructor(options?: ErrorOptions) {
    super("Agent run was not found", options);
    this.name = "AgentRunNotFoundError";
  }
}

export class EncryptedAgentRunRecordStore {
  readonly #directory: string;
  readonly #key: Uint8Array;

  constructor(directory: string, key: Uint8Array) {
    this.#directory = directory;
    this.#key = Uint8Array.from(key);
  }

  locator(runId: string): string {
    return createHmac("sha256", this.#key)
      .update("haksulsomoim:agent-run:v1\0")
      .update(runId)
      .digest("hex");
  }

  async read(runId: string): Promise<AgentRunSnapshot> {
    const locator = this.locator(runId);
    let serialized: string;
    try {
      serialized = await readFile(join(this.#directory, `${locator}.json`), "utf8");
    } catch (error) {
      if (isNodeError(error, "ENOENT")) throw new AgentRunNotFoundError({ cause: error });
      throw error;
    }
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
    const snapshot = snapshotSchema.parse(JSON.parse(plaintext));
    if (snapshot.run.runId !== runId) throw new Error("Agent run locator mismatch");
    return snapshot;
  }

  async write(snapshot: AgentRunSnapshot, exclusive: boolean): Promise<void> {
    const parsed = snapshotSchema.parse(snapshot);
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const locator = this.locator(parsed.run.runId);
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, nonce);
    cipher.setAAD(Buffer.from(locator));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(parsed)), cipher.final()]);
    const serialized = JSON.stringify({
      version: 1,
      nonce: nonce.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64"),
    });
    const finalPath = join(this.#directory, `${locator}.json`);
    const temporaryPath = join(this.#directory, `.${randomBytes(12).toString("hex")}.tmp`);
    try {
      const file = await open(temporaryPath, "wx", 0o600);
      try {
        await file.writeFile(serialized, "utf8");
        await file.sync();
      } finally {
        await file.close();
      }
      if (exclusive) {
        await link(temporaryPath, finalPath);
        await unlink(temporaryPath);
      } else {
        await rename(temporaryPath, finalPath);
      }
      const directory = await open(this.#directory, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      if (exclusive && isNodeError(error, "EEXIST")) {
        throw new AgentRunAlreadyExistsError({ cause: error });
      }
      throw error;
    }
  }
}
