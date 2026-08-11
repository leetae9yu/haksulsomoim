import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const RECORD_KEYS = [
  "algorithm",
  "authTag",
  "ciphertext",
  "id",
  "nonce",
  "sha256",
  "version",
] as const;

type LocalCaseStoreErrorCode =
  | "CORRUPT_EVIDENCE"
  | "EVIDENCE_ALREADY_EXISTS"
  | "EVIDENCE_NOT_FOUND"
  | "INVALID_EVIDENCE_ID"
  | "MALFORMED_EVIDENCE";

export class LocalCaseStoreError extends Error {
  readonly code: LocalCaseStoreErrorCode;

  constructor(code: LocalCaseStoreErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

export class EvidenceAlreadyExistsError extends LocalCaseStoreError {
  constructor(id: string, options?: ErrorOptions) {
    super("EVIDENCE_ALREADY_EXISTS", `Evidence object ${id} already exists`, options);
  }
}

export class EvidenceNotFoundError extends LocalCaseStoreError {
  constructor(id: string, options?: ErrorOptions) {
    super("EVIDENCE_NOT_FOUND", `Evidence object ${id} was not found`, options);
  }
}

export class InvalidEvidenceIdError extends LocalCaseStoreError {
  constructor(id: string) {
    super("INVALID_EVIDENCE_ID", `Invalid opaque evidence id: ${id}`);
  }
}

export class MalformedEvidenceError extends LocalCaseStoreError {
  constructor(id: string, options?: ErrorOptions) {
    super("MALFORMED_EVIDENCE", `Evidence object ${id} has a malformed record`, options);
  }
}

export class CorruptEvidenceError extends LocalCaseStoreError {
  constructor(id: string, options?: ErrorOptions) {
    super("CORRUPT_EVIDENCE", `Evidence object ${id} failed integrity verification`, options);
  }
}

interface EvidenceRecord {
  readonly version: 1;
  readonly id: string;
  readonly algorithm: "aes-256-gcm";
  readonly sha256: string;
  readonly nonce: string;
  readonly ciphertext: string;
  readonly authTag: string;
}

function decodeCanonicalBase64(value: string, expectedLength?: number): Buffer | undefined {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    return undefined;
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) {
    return undefined;
  }
  if (expectedLength !== undefined && decoded.byteLength !== expectedLength) {
    return undefined;
  }
  return decoded;
}

function parseRecord(serialized: string, expectedId: string): EvidenceRecord {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch (error) {
    throw new MalformedEvidenceError(expectedId, { cause: error });
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new MalformedEvidenceError(expectedId);
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expectedKeys = [...RECORD_KEYS].sort();
  if (
    keys.length !== expectedKeys.length ||
    !keys.every((key, index) => key === expectedKeys[index]) ||
    record.version !== 1 ||
    record.id !== expectedId ||
    record.algorithm !== "aes-256-gcm" ||
    typeof record.sha256 !== "string" ||
    !SHA256_PATTERN.test(record.sha256) ||
    typeof record.nonce !== "string" ||
    decodeCanonicalBase64(record.nonce, 12) === undefined ||
    typeof record.ciphertext !== "string" ||
    decodeCanonicalBase64(record.ciphertext) === undefined ||
    typeof record.authTag !== "string" ||
    decodeCanonicalBase64(record.authTag, 16) === undefined
  ) {
    throw new MalformedEvidenceError(expectedId);
  }
  return {
    version: 1,
    id: expectedId,
    algorithm: "aes-256-gcm",
    sha256: record.sha256,
    nonce: record.nonce,
    ciphertext: record.ciphertext,
    authTag: record.authTag,
  };
}

function aadFor(record: Pick<EvidenceRecord, "id" | "sha256">): Buffer {
  return Buffer.from(`haksulsomoim:evidence:v1\0${record.id}\0${record.sha256}`, "utf8");
}

export function encryptEvidence(
  id: string,
  encryptionKey: Uint8Array,
  originalBytes: Uint8Array,
): { readonly serialized: string; readonly sha256: string } {
  const plaintext = Buffer.from(originalBytes);
  const sha256 = createHash("sha256").update(plaintext).digest("hex");
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey, nonce);
  cipher.setAAD(aadFor({ id, sha256 }));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const record: EvidenceRecord = {
    version: 1,
    id,
    algorithm: "aes-256-gcm",
    sha256,
    nonce: nonce.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
  };
  return { serialized: `${JSON.stringify(record)}\n`, sha256 };
}

export function decryptEvidence(
  id: string,
  encryptionKey: Uint8Array,
  serialized: string,
): Uint8Array {
  const record = parseRecord(serialized, id);
  let plaintext: Buffer;
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      encryptionKey,
      Buffer.from(record.nonce, "base64"),
    );
    decipher.setAAD(aadFor(record));
    decipher.setAuthTag(Buffer.from(record.authTag, "base64"));
    plaintext = Buffer.concat([
      decipher.update(Buffer.from(record.ciphertext, "base64")),
      decipher.final(),
    ]);
  } catch (error) {
    throw new CorruptEvidenceError(id, { cause: error });
  }

  const actualHash = createHash("sha256").update(plaintext).digest();
  const expectedHash = Buffer.from(record.sha256, "hex");
  if (!timingSafeEqual(actualHash, expectedHash)) {
    throw new CorruptEvidenceError(id);
  }
  return Uint8Array.from(plaintext);
}
