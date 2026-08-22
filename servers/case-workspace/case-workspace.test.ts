import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CaseWorkspace } from "./index.ts";

const roots: string[] = [];
const rawSummary = "홍길동이 123-456-789012 계좌로 송금한 사기 피해";

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "case-workspace-"));
  roots.push(root);
  return root;
}

function workspace(root: string): CaseWorkspace {
  let id = 0;
  return new CaseWorkspace({
    casesRoot: root,
    idFactory: () => (++id).toString(16).padStart(16, "0"),
    now: () => new Date("2026-08-22T00:00:00.000Z"),
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("CaseWorkspace", () => {
  test("creates a bounded domestic transfer-fraud workspace with strict JSON and Markdown views", async () => {
    const root = await temporaryRoot();
    const service = workspace(root);

    const summary = await service.create({
      amountKrw: 5_380_000,
      occurredAt: "2026-08-01",
      summary: rawSummary,
      counterpartyAlias: "사기 판매자",
    });

    expect(summary).toEqual({
      caseId: "case-0000000000000001",
      amountKrw: 5_380_000,
      occurredAt: "2026-08-01",
      summary: "[MASKED]",
      counterpartyAlias: "[MASKED]",
      evidenceCount: 0,
      criminalStage: "evidence-review",
      civilStage: "pre-filing",
      updatedAt: expect.any(String),
    });
    expect(await service.getMasked(summary.caseId)).toEqual(summary);
    const directory = join(root, summary.caseId);
    expect((await readdir(directory)).sort()).toEqual([
      "civil.md",
      "criminal.md",
      "evidence.md",
      "record.json",
      "timeline.md",
    ]);
    const record = JSON.parse(await readFile(join(directory, "record.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(record).toMatchObject({ amountKrw: 5_380_000, summary: rawSummary, evidence: [] });
    expect(Object.keys(record).sort()).toEqual([
      "amountKrw",
      "caseId",
      "civilStage",
      "counterpartyAlias",
      "createdAt",
      "criminalStage",
      "evidence",
      "occurredAt",
      "summary",
      "updatedAt",
      "version",
    ]);
    expect(await readFile(join(directory, "timeline.md"), "utf8")).toContain(
      "Domestic bank-transfer fraud",
    );
    await expect(
      service.create({ amountKrw: 30_000_001, occurredAt: "2026-08-01", summary: "too large" }),
    ).rejects.toThrow();
  });

  test("hashes a local regular evidence file without copying its raw content", async () => {
    const root = await temporaryRoot();
    const service = workspace(root);
    const created = await service.create({
      amountKrw: 1,
      occurredAt: "2026-08-01",
      summary: "receipt",
    });
    const sourceDirectory = join(root, "incoming");
    const source = join(sourceDirectory, "receipt.txt");
    const rawEvidence = "private transfer receipt bytes";
    await mkdir(sourceDirectory);
    await writeFile(source, rawEvidence);

    const summary = await service.addEvidence({
      caseId: created.caseId,
      path: source,
      kind: "transfer-receipt",
      description: "Transfer confirmation",
    });

    expect(summary.evidenceCount).toBe(1);
    expect(JSON.stringify(summary)).not.toContain(rawEvidence);
    const record = JSON.parse(
      await readFile(join(root, created.caseId, "record.json"), "utf8"),
    ) as {
      evidence: Array<{
        evidenceId: string;
        kind: string;
        path: string;
        description: string;
        sha256: string;
        addedAt: string;
      }>;
    };
    expect(record.evidence[0]).toEqual({
      evidenceId: "evidence-0000000000000002",
      kind: "transfer-receipt",
      path: source,
      description: "Transfer confirmation",
      sha256: createHash("sha256").update(rawEvidence).digest("hex"),
      addedAt: expect.any(String),
    });
    const caseFiles = await Promise.all(
      (await readdir(join(root, created.caseId))).map((name) =>
        readFile(join(root, created.caseId, name), "utf8"),
      ),
    );
    expect(caseFiles.join("\n")).not.toContain(rawEvidence);
    expect(await readFile(source, "utf8")).toBe(rawEvidence);
  });

  test("rejects traversal and symlink evidence escapes", async () => {
    const root = await temporaryRoot();
    const service = workspace(root);
    const created = await service.create({
      amountKrw: 1,
      occurredAt: "2026-08-01",
      summary: "receipt",
    });
    const outside = await mkdtemp(join(tmpdir(), "case-workspace-outside-"));
    roots.push(outside);
    await writeFile(join(outside, "receipt.txt"), "outside");
    await symlink(join(outside, "receipt.txt"), join(root, "outside-link.txt"));

    await expect(
      service.addEvidence({
        caseId: created.caseId,
        path: "../outside/receipt.txt",
        kind: "other",
        description: "x",
      }),
    ).rejects.toThrow("outside the cases root");
    await expect(
      service.addEvidence({
        caseId: created.caseId,
        path: join(root, "outside-link.txt"),
        kind: "other",
        description: "x",
      }),
    ).rejects.toThrow("symlink");
  });

  test("keeps criminal and civil stages independent and strictly forward", async () => {
    const root = await temporaryRoot();
    const service = workspace(root);
    const created = await service.create({
      amountKrw: 1,
      occurredAt: "2026-08-01",
      summary: "stages",
    });

    const criminal = await service.updateTrack({
      caseId: created.caseId,
      track: "criminal",
      stage: "complaint-filed",
    });
    expect(criminal.criminalStage).toBe("complaint-filed");
    expect(criminal.civilStage).toBe("pre-filing");
    const civil = await service.updateTrack({
      caseId: created.caseId,
      track: "civil",
      stage: "service-attested",
    });
    expect(civil.civilStage).toBe("service-attested");
    await expect(
      service.updateTrack({ caseId: created.caseId, track: "criminal", stage: "complaint-ready" }),
    ).rejects.toThrow("Invalid criminal stage transition");
    await expect(
      service.updateTrack({ caseId: created.caseId, track: "civil", stage: "service-attested" }),
    ).rejects.toThrow("Invalid civil stage transition");
  });
});
