import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { confirmOcrFacts, parseCaseInput } from "../domain/case-workflow";
import { EncryptedRuntimeCaseRepository } from "./runtime-case-repository";
import type { RuntimeCaseDossier } from "./runtime-case-types";

const roots: string[] = [];
const key = new Uint8Array(32).fill(3);

function dossier(caseId: string): RuntimeCaseDossier {
  const parsed = parseCaseInput({
    jurisdiction: "KR-domestic",
    paymentMethod: "bank-transfer",
    currency: "KRW",
    amount: 100_000,
    ocrFacts: [{ field: "account", value: "110-123-456789" }],
  });
  if (parsed.status !== "accepted") throw new Error("fixture failed");
  const confirmed = confirmOcrFacts(parsed.value);
  if (confirmed.status !== "ok") throw new Error("fixture failed");
  return {
    caseId,
    amountKrw: 100_000,
    evidence: [
      {
        evidenceId: "evidence-1",
        filename: "victim-receipt.png",
        mimeType: "image/png",
        sha256: "a".repeat(64),
      },
    ],
    confirmedOcrFacts: [{ field: "account", value: "110-123-456789" }],
    retrievedCitations: [],
    workflow: { ...confirmed.value, civilState: "service-attested" },
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("encrypted runtime case repository", () => {
  test("persists full intermediate workflow snapshots without plaintext dossier facts", async () => {
    const root = await mkdtemp(join(tmpdir(), "haksul-runtime-case-"));
    roots.push(root);
    const repository = new EncryptedRuntimeCaseRepository(root, key);

    await repository.create(dossier("case-private-1"));

    const reopened = new EncryptedRuntimeCaseRepository(root, key);
    expect(await reopened.read("case-private-1")).toMatchObject({
      confirmedOcrFacts: [{ field: "account", value: "110-123-456789" }],
      workflow: { civilState: "service-attested" },
    });
    const disk = await readFile(join(root, (await readdir(root))[0] as string), "utf8");
    expect(disk).not.toContain("case-private-1");
    expect(disk).not.toContain("110-123-456789");
    expect(disk).not.toContain("victim-receipt.png");
  });

  test.each([
    "pre-filing",
    "payment-order-pending",
    "service-attested",
    "judgment-recorded",
    "enforceable-title-confirmed",
  ] as const)("round-trips the civil workflow state %s", async (civilState) => {
    const root = await mkdtemp(join(tmpdir(), "haksul-runtime-case-"));
    roots.push(root);
    const repository = new EncryptedRuntimeCaseRepository(root, key);
    const input = dossier(`case-${civilState}`);

    await repository.create({ ...input, workflow: { ...input.workflow, civilState } });

    expect((await repository.read(input.caseId)).workflow.civilState).toBe(civilState);
  });

  test("publishes exactly one opaque final record without temporary artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "haksul-runtime-case-"));
    roots.push(root);
    const repository = new EncryptedRuntimeCaseRepository(root, key);

    await repository.create(dossier("atomic-case"));

    expect(await readdir(root)).toEqual([expect.stringMatching(/^[a-f0-9]{64}\.json$/u)]);
    expect(await repository.read("atomic-case")).toMatchObject({ caseId: "atomic-case" });
  });

  test("rejects duplicate creation and removes its unpublished temporary file", async () => {
    const root = await mkdtemp(join(tmpdir(), "haksul-runtime-case-"));
    roots.push(root);
    const repository = new EncryptedRuntimeCaseRepository(root, key);
    await repository.create(dossier("duplicate-case"));

    let duplicateError: unknown;
    try {
      await repository.create(dossier("duplicate-case"));
    } catch (error) {
      duplicateError = error;
    }
    expect(duplicateError).toMatchObject({ code: "EEXIST" });
    expect(await readdir(root)).toHaveLength(1);
    expect(await repository.read("duplicate-case")).toMatchObject({ caseId: "duplicate-case" });
  });
});
