import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CorruptEvidenceError,
  EvidenceAlreadyExistsError,
  LocalCaseStore,
  MalformedEvidenceError,
} from "./local-case-store";

const roots: string[] = [];
const encryptionKey = new Uint8Array(32).fill(0xa5);

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "haksulsomoim-store-"));
  roots.push(root);
  return root;
}

function objectPath(root: string, id: string): string {
  return join(root, "objects", `${id}.json`);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("LocalCaseStore", () => {
  test("round-trips immutable original bytes under an opaque id", async () => {
    const root = await temporaryRoot();
    const store = new LocalCaseStore({ rootPath: root, encryptionKey });
    const original = new Uint8Array([0, 255, 16, 32, 13, 10, 128]);

    const stored = await store.writeEvidence(original);

    expect(stored.id).toMatch(/^[a-f0-9]{32}$/);
    expect(stored.sha256).toBe(createHash("sha256").update(original).digest("hex"));
    expect(await store.readEvidence(stored.id)).toEqual(original);
    const serializedRecord = await readFile(objectPath(root, stored.id));
    expect(serializedRecord.includes(Buffer.from(original))).toBe(false);
  });

  test("encrypts with AES-256-GCM, fresh nonces, and authenticated metadata", async () => {
    const root = await temporaryRoot();
    const store = new LocalCaseStore({ rootPath: root, encryptionKey });
    const original = new TextEncoder().encode("원본 증거 바이트");

    const first = await store.writeEvidence(original);
    const second = await store.writeEvidence(original);
    const firstRecord = JSON.parse(await readFile(objectPath(root, first.id), "utf8")) as {
      algorithm: string;
      nonce: string;
      sha256: string;
    };
    const secondRecord = JSON.parse(await readFile(objectPath(root, second.id), "utf8")) as {
      nonce: string;
    };

    expect(firstRecord.algorithm).toBe("aes-256-gcm");
    expect(firstRecord.sha256).toBe(first.sha256);
    expect(firstRecord.nonce).not.toBe(secondRecord.nonce);

    firstRecord.sha256 = "0".repeat(64);
    await writeFile(objectPath(root, first.id), JSON.stringify(firstRecord));
    expect(store.readEvidence(first.id)).rejects.toBeInstanceOf(CorruptEvidenceError);
  });

  test("never overwrites an existing evidence object", async () => {
    const root = await temporaryRoot();
    const fixedId = "1".repeat(32);
    const store = new LocalCaseStore({
      rootPath: root,
      encryptionKey,
      idGenerator: () => fixedId,
    });
    const original = new TextEncoder().encode("first and immutable");
    await store.writeEvidence(original);

    expect(store.writeEvidence(new TextEncoder().encode("replacement"))).rejects.toBeInstanceOf(
      EvidenceAlreadyExistsError,
    );
    expect(await store.readEvidence(fixedId)).toEqual(original);
    expect((await readdir(join(root, "objects"))).filter((name) => name.includes(".tmp-"))).toEqual(
      [],
    );
  });

  test("rejects malformed records with a typed error", async () => {
    const root = await temporaryRoot();
    const id = "2".repeat(32);
    const store = new LocalCaseStore({ rootPath: root, encryptionKey });
    await store.initialize();
    await writeFile(objectPath(root, id), "{not-json", { flag: "wx" });

    expect(store.readEvidence(id)).rejects.toBeInstanceOf(MalformedEvidenceError);
  });

  test("rejects authenticated ciphertext corruption with a typed error", async () => {
    const root = await temporaryRoot();
    const store = new LocalCaseStore({ rootPath: root, encryptionKey });
    const stored = await store.writeEvidence(new TextEncoder().encode("unaltered evidence"));
    const path = objectPath(root, stored.id);
    const record = JSON.parse(await readFile(path, "utf8")) as { ciphertext: string };
    const ciphertext = Buffer.from(record.ciphertext, "base64");
    ciphertext[0] = (ciphertext[0] ?? 0) ^ 1;
    record.ciphertext = ciphertext.toString("base64");
    await writeFile(path, JSON.stringify(record));

    expect(store.readEvidence(stored.id)).rejects.toBeInstanceOf(CorruptEvidenceError);
  });
});
