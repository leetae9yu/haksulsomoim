import { randomBytes } from "node:crypto";
import { link, mkdir, open, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  decryptEvidence,
  EvidenceAlreadyExistsError,
  EvidenceNotFoundError,
  encryptEvidence,
  InvalidEvidenceIdError,
  LocalCaseStoreError,
} from "./evidence-record";

const OBJECT_ID_PATTERN = /^[a-f0-9]{32}$/;

export {
  CorruptEvidenceError,
  EvidenceAlreadyExistsError,
  EvidenceNotFoundError,
  InvalidEvidenceIdError,
  LocalCaseStoreError,
  MalformedEvidenceError,
} from "./evidence-record";

export interface LocalCaseStoreOptions {
  readonly rootPath: string;
  readonly encryptionKey: Uint8Array;
  readonly idGenerator?: () => string;
}

export interface StoredEvidence {
  readonly id: string;
  readonly sha256: string;
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

async function removeTemporaryFile(path: string, operationError: unknown): Promise<never> {
  try {
    await unlink(path);
  } catch (cleanupError) {
    if (!isNodeErrorWithCode(cleanupError, "ENOENT")) {
      throw new AggregateError(
        [operationError, cleanupError],
        "Evidence write failed and its temporary file could not be removed",
      );
    }
  }
  throw operationError;
}

export class LocalCaseStore {
  readonly #rootPath: string;
  readonly #objectsPath: string;
  readonly #encryptionKey: Uint8Array;
  readonly #idGenerator: () => string;

  constructor(options: LocalCaseStoreOptions) {
    if (options.rootPath.length === 0) {
      throw new TypeError("A local store root path is required");
    }
    if (options.encryptionKey.byteLength !== 32) {
      throw new RangeError("AES-256-GCM requires a 32-byte encryption key");
    }

    this.#rootPath = options.rootPath;
    this.#objectsPath = join(options.rootPath, "objects");
    this.#encryptionKey = Uint8Array.from(options.encryptionKey);
    this.#idGenerator = options.idGenerator ?? (() => randomBytes(16).toString("hex"));
  }

  async initialize(): Promise<void> {
    await mkdir(this.#rootPath, { recursive: true, mode: 0o700 });
    await mkdir(this.#objectsPath, { recursive: true, mode: 0o700 });
  }

  async writeEvidence(originalBytes: Uint8Array): Promise<StoredEvidence> {
    await this.initialize();
    const id = this.#idGenerator();
    this.#assertValidId(id);

    const encrypted = encryptEvidence(id, this.#encryptionKey, originalBytes);

    const finalPath = this.#pathFor(id);
    const temporaryPath = join(this.#objectsPath, `.${id}.tmp-${randomBytes(8).toString("hex")}`);
    const file = await open(temporaryPath, "wx", 0o600);
    try {
      await file.writeFile(encrypted.serialized, "utf8");
      await file.sync();
    } catch (error) {
      try {
        await file.close();
      } catch (closeError) {
        throw new AggregateError([error, closeError], "Could not finalize temporary evidence file");
      }
      return removeTemporaryFile(temporaryPath, error);
    }
    await file.close();

    try {
      await link(temporaryPath, finalPath);
    } catch (error) {
      if (isNodeErrorWithCode(error, "EEXIST")) {
        return removeTemporaryFile(
          temporaryPath,
          new EvidenceAlreadyExistsError(id, { cause: error }),
        );
      }
      return removeTemporaryFile(temporaryPath, error);
    }

    try {
      await unlink(temporaryPath);
      const directory = await open(this.#objectsPath, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch (error) {
      throw new LocalCaseStoreError(
        "CORRUPT_EVIDENCE",
        `Evidence object ${id} was published but directory synchronization failed`,
        { cause: error },
      );
    }

    return { id, sha256: encrypted.sha256 };
  }

  async readEvidence(id: string): Promise<Uint8Array> {
    this.#assertValidId(id);
    let serialized: string;
    try {
      serialized = await readFile(this.#pathFor(id), "utf8");
    } catch (error) {
      if (isNodeErrorWithCode(error, "ENOENT")) {
        throw new EvidenceNotFoundError(id, { cause: error });
      }
      throw error;
    }

    return decryptEvidence(id, this.#encryptionKey, serialized);
  }

  #pathFor(id: string): string {
    return join(this.#objectsPath, `${id}.json`);
  }

  #assertValidId(id: string): void {
    if (!OBJECT_ID_PATTERN.test(id)) {
      throw new InvalidEvidenceIdError(id);
    }
  }
}
