import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CaseDossier,
  CorruptCaseDossierError,
  LocalCaseStore,
  MalformedCaseDossierError,
  UnknownCaseError,
} from "./local-case-store";

const roots: string[] = [];
const encryptionKey = new Uint8Array(32).fill(0xa5);
const caseId = "victim-case-2026-08-11";

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "haksulsomoim-dossier-"));
  roots.push(root);
  return root;
}

async function soleCasePath(root: string): Promise<string> {
  const names = await readdir(join(root, "cases"));
  expect(names).toHaveLength(1);
  return join(root, "cases", names[0] as string);
}

const dossier: CaseDossier = {
  caseId,
  amountKrw: 5_380_000,
  scope: {
    caseType: "domestic-bank-transfer-fraud",
    jurisdiction: "KR-domestic",
    paymentMethod: "bank-transfer",
    currency: "KRW",
  },
  evidence: [],
  confirmedOcrFacts: [{ field: "recipient-account", value: "110-123-456789" }],
  workflow: { criminalState: "complaint-ready", civilState: "payment-order-pending" },
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("persistent case dossiers", () => {
  test("survives a new store instance with evidence membership and workflow snapshot", async () => {
    const root = await temporaryRoot();
    const first = new LocalCaseStore({ rootPath: root, encryptionKey });
    await first.createCase(dossier);
    const stored = await first.writeEvidence(new TextEncoder().encode("private receipt body"));
    await first.attachEvidence(caseId, {
      evidenceId: stored.id,
      filename: "피해자-송금확인증.png",
      mimeType: "image/png",
      sha256: stored.sha256,
    });

    const reopened = new LocalCaseStore({ rootPath: root, encryptionKey });
    expect(await reopened.readCase(caseId)).toEqual({
      ...dossier,
      evidence: [
        {
          evidenceId: stored.id,
          filename: "피해자-송금확인증.png",
          mimeType: "image/png",
          sha256: stored.sha256,
        },
      ],
    });
  });

  test("keeps case IDs, filenames, OCR values, and evidence plaintext out of disk metadata", async () => {
    const root = await temporaryRoot();
    const store = new LocalCaseStore({ rootPath: root, encryptionKey });
    await store.createCase(dossier);
    const plaintext = "uniquely-private-evidence-body";
    const stored = await store.writeEvidence(new TextEncoder().encode(plaintext));
    const filename = "victim-name-original-receipt.png";
    await store.attachEvidence(caseId, {
      evidenceId: stored.id,
      filename,
      mimeType: "image/png",
      sha256: stored.sha256,
    });

    const files = [
      ...(await readdir(join(root, "cases"))).map((name) => join(root, "cases", name)),
      ...(await readdir(join(root, "objects"))).map((name) => join(root, "objects", name)),
    ];
    const diskText = (await Promise.all(files.map((path) => readFile(path)))).join("\n");
    expect(files.join("\n")).not.toContain(caseId);
    for (const secret of [caseId, filename, "110-123-456789", plaintext]) {
      expect(diskText).not.toContain(secret);
    }
  });

  test.each([
    "pre-filing",
    "payment-order-pending",
    "service-attested",
    "judgment-recorded",
    "enforceable-title-confirmed",
  ] as const)("round-trips the civil workflow state %s", async (civilState) => {
    const root = await temporaryRoot();
    const store = new LocalCaseStore({ rootPath: root, encryptionKey });

    await store.createCase({ ...dossier, workflow: { ...dossier.workflow, civilState } });

    expect((await store.readCase(caseId)).workflow.civilState).toBe(civilState);
  });

  test("rejects malformed and authenticated metadata tampering", async () => {
    const root = await temporaryRoot();
    const store = new LocalCaseStore({ rootPath: root, encryptionKey });
    await store.createCase(dossier);
    const path = await soleCasePath(root);
    const original = await readFile(path, "utf8");

    await writeFile(path, "{not-json");
    expect(store.readCase(caseId)).rejects.toBeInstanceOf(MalformedCaseDossierError);

    const record = JSON.parse(original) as { ciphertext: string };
    const ciphertext = Buffer.from(record.ciphertext, "base64");
    ciphertext[0] = (ciphertext[0] ?? 0) ^ 1;
    record.ciphertext = ciphertext.toString("base64");
    await writeFile(path, JSON.stringify(record));
    expect(store.readCase(caseId)).rejects.toBeInstanceOf(CorruptCaseDossierError);
  });

  test("cannot attach evidence to an unknown case", async () => {
    const root = await temporaryRoot();
    const store = new LocalCaseStore({ rootPath: root, encryptionKey });
    const stored = await store.writeEvidence(new Uint8Array([1, 2, 3]));

    expect(
      store.attachEvidence("unknown-case", {
        evidenceId: stored.id,
        filename: "receipt.png",
        mimeType: "image/png",
        sha256: stored.sha256,
      }),
    ).rejects.toBeInstanceOf(UnknownCaseError);
    expect(await readdir(join(root, "cases"))).toEqual([]);
  });
});
