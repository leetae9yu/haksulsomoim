import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { safeStorage } from "electron";

const KEY_FILE = "master-key.bin";

export async function loadMasterKey(userDataPath: string): Promise<Uint8Array> {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("Windows encrypted credential storage is unavailable");
  }

  const path = join(userDataPath, KEY_FILE);
  try {
    const encrypted = await readFile(path);
    const hex = safeStorage.decryptString(encrypted);
    if (!/^[a-f0-9]{64}$/u.test(hex)) throw new Error("Stored master key is malformed");
    return Buffer.from(hex, "hex");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }

  const key = randomBytes(32);
  await writeFile(path, safeStorage.encryptString(key.toString("hex")), {
    flag: "wx",
    mode: 0o600,
  });
  return key;
}
