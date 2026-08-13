import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { link, open, readFile, realpath, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { agentRunIdSchema, caseIdSchema } from "./agent-contracts-core";
import { AgentRepositoryKeyVerifier } from "./agent-run-repository-key";

const claimSchema = z
  .strictObject({
    caseId: caseIdSchema,
    runId: agentRunIdSchema,
  })
  .readonly();
const encryptedClaimSchema = z.strictObject({
  version: z.literal(1),
  nonce: z.string().min(1),
  ciphertext: z.string().min(1),
  authTag: z.string().min(1),
});
const claimTails = new Map<string, Promise<void>>();
const quarantinedClaims = new Set<string>();

type AgentCaseClaim = z.infer<typeof claimSchema>;

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export class AgentCaseAlreadyClaimedError extends Error {
  readonly code = "AGENT_CASE_ALREADY_CLAIMED";

  constructor(options?: ErrorOptions) {
    super("An active Agent run already exists for this case", options);
    this.name = "AgentCaseAlreadyClaimedError";
  }
}

export class AgentCaseClaimInvariantError extends Error {
  readonly code = "AGENT_CASE_CLAIM_INVARIANT";

  constructor(message: string) {
    super(message);
    this.name = "AgentCaseClaimInvariantError";
  }
}

export class EncryptedAgentCaseClaimStore {
  readonly #directory: string;
  readonly #key: Uint8Array;
  readonly #verifier: AgentRepositoryKeyVerifier;

  constructor(
    directory: string,
    key: Uint8Array,
    verifier = new AgentRepositoryKeyVerifier(directory, key),
  ) {
    this.#directory = directory;
    this.#key = Uint8Array.from(key);
    this.#verifier = verifier;
  }

  async acquire(caseId: string, runId: string): Promise<void> {
    const claim = claimSchema.parse({ caseId, runId });
    await this.#withCase(claim.caseId, (locator) => this.#publish(claim, locator));
  }

  async owner(caseId: string): Promise<string | undefined> {
    const parsedCaseId = caseIdSchema.parse(caseId);
    return this.#withCase(parsedCaseId, async (locator) => {
      const claim = await this.#read(parsedCaseId, locator);
      return claim?.runId;
    });
  }

  async quarantine(caseId: string, runId: string): Promise<void> {
    const expected = claimSchema.parse({ caseId, runId });
    await this.#withCase(expected.caseId, async (locator, lockKey) => {
      const claim = await this.#read(expected.caseId, locator);
      if (claim?.runId !== expected.runId) {
        throw new AgentCaseClaimInvariantError("Agent quarantine owner mismatch");
      }
      quarantinedClaims.add(lockKey);
    });
  }

  async isQuarantined(caseId: string): Promise<boolean> {
    const parsedCaseId = caseIdSchema.parse(caseId);
    return this.#withCase(parsedCaseId, (_locator, lockKey) =>
      Promise.resolve(quarantinedClaims.has(lockKey)),
    );
  }

  async release(caseId: string, runId: string): Promise<void> {
    const expected = claimSchema.parse({ caseId, runId });
    await this.#withCase(expected.caseId, async (locator, lockKey) => {
      if (quarantinedClaims.has(lockKey)) {
        throw new AgentCaseAlreadyClaimedError();
      }
      const claim = await this.#read(expected.caseId, locator);
      if (claim === undefined) return;
      if (claim.runId !== expected.runId) {
        throw new AgentCaseClaimInvariantError("Agent case claim belongs to another run");
      }
      await unlink(this.#path(locator));
      await this.#syncDirectory();
    });
  }

  #locator(caseId: string): string {
    return createHmac("sha256", this.#key)
      .update("haksulsomoim:agent-case-claim:v1\0")
      .update(caseId)
      .digest("hex");
  }

  #path(locator: string): string {
    return join(this.#directory, `${locator}.claim`);
  }

  async #withCase<T>(
    caseId: string,
    operation: (locator: string, lockKey: string) => Promise<T>,
  ): Promise<T> {
    await this.#verifier.verify();
    const locator = this.#locator(caseId);
    const lockKey = `${await realpath(this.#directory)}\0${locator}`;
    const previous = claimTails.get(lockKey) ?? Promise.resolve();
    let release = (): void => undefined;
    const turn = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => turn);
    claimTails.set(lockKey, tail);
    await previous;
    try {
      return await operation(locator, lockKey);
    } finally {
      release();
      if (claimTails.get(lockKey) === tail) claimTails.delete(lockKey);
    }
  }

  async #read(caseId: string, locator: string): Promise<AgentCaseClaim | undefined> {
    let serialized: string;
    try {
      serialized = await readFile(this.#path(locator), "utf8");
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return undefined;
      throw error;
    }
    const record = encryptedClaimSchema.parse(JSON.parse(serialized));
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
    const claim = claimSchema.parse(JSON.parse(plaintext));
    if (claim.caseId !== caseId) {
      throw new AgentCaseClaimInvariantError("Agent case claim locator mismatch");
    }
    return claim;
  }

  async #publish(claim: AgentCaseClaim, locator: string): Promise<void> {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, nonce);
    cipher.setAAD(Buffer.from(locator));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(claim)), cipher.final()]);
    const serialized = JSON.stringify({
      version: 1,
      nonce: nonce.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64"),
    });
    const temporaryPath = join(this.#directory, `.${randomBytes(12).toString("hex")}.tmp`);
    try {
      const file = await open(temporaryPath, "wx", 0o600);
      try {
        await file.writeFile(serialized, "utf8");
        await file.sync();
      } finally {
        await file.close();
      }
      await link(temporaryPath, this.#path(locator));
      await unlink(temporaryPath);
      await this.#syncDirectory();
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      if (isNodeError(error, "EEXIST")) {
        throw new AgentCaseAlreadyClaimedError({ cause: error });
      }
      throw error;
    }
  }

  async #syncDirectory(): Promise<void> {
    const directory = await open(this.#directory, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
}
