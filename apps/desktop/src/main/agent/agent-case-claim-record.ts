import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { agentToolLeaseSchema } from "./agent-case-tool-lease";
import { agentRunIdSchema, caseIdSchema } from "./agent-contracts-core";

const claimSchema = z
  .strictObject({
    caseId: caseIdSchema,
    runId: agentRunIdSchema,
    toolLease: agentToolLeaseSchema.nullable(),
  })
  .readonly();
const encryptedClaimSchema = z.strictObject({
  version: z.literal(1),
  nonce: z.string().min(1),
  ciphertext: z.string().min(1),
  authTag: z.string().min(1),
});

export type AgentCaseClaim = z.infer<typeof claimSchema>;
export const parseAgentCaseClaim = (value: unknown): AgentCaseClaim => claimSchema.parse(value);

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export async function readAgentCaseClaim(
  path: string,
  key: Uint8Array,
  locator: string,
): Promise<AgentCaseClaim | undefined> {
  let serialized: string;
  try {
    serialized = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  }
  const record = encryptedClaimSchema.parse(JSON.parse(serialized));
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(record.nonce, "base64"));
  decipher.setAAD(Buffer.from(locator));
  decipher.setAuthTag(Buffer.from(record.authTag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(record.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
  return claimSchema.parse(JSON.parse(plaintext));
}

export function serializeAgentCaseClaim(
  claim: AgentCaseClaim,
  key: Uint8Array,
  locator: string,
): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(locator));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(claim)), cipher.final()]);
  return JSON.stringify({
    version: 1,
    nonce: nonce.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
  });
}
