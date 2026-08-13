import { randomBytes } from "node:crypto";
import { link, open, unlink } from "node:fs/promises";
import { join } from "node:path";

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export class AgentClaimTransactionBusyError extends Error {
  readonly code = "AGENT_CLAIM_TRANSACTION_BUSY";
}

export async function withClaimTransaction<T>(
  directory: string,
  locator: string,
  operation: () => Promise<T>,
): Promise<T> {
  const nonce = randomBytes(12).toString("hex");
  const temporary = join(directory, `.${nonce}.claim-lock`);
  const lock = join(directory, `${locator}.claim-lock`);
  const file = await open(temporary, "wx", 0o600);
  await file.close();
  try {
    await link(temporary, lock);
    await unlink(temporary);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    if (isNodeError(error, "EEXIST")) throw new AgentClaimTransactionBusyError();
    throw error;
  }
  try {
    return await operation();
  } finally {
    await unlink(lock);
    const handle = await open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}
