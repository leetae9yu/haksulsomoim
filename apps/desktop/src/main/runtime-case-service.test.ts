import { describe, expect, test } from "bun:test";
import type { CodexAgentProvider } from "../integrations/agent-provider/agent-provider";
import type { KoreanLawMcpAdapter } from "../integrations/korean-law-mcp/korean-law-mcp";
import { Redactor } from "../security/redaction";
import {
  CaseRuntimeService,
  type RuntimeCaseDossier,
  type RuntimeCaseRepository,
} from "./runtime-case-service";

class MemoryRepository implements RuntimeCaseRepository {
  readonly dossiers = new Map<string, RuntimeCaseDossier>();
  async create(dossier: RuntimeCaseDossier): Promise<void> {
    this.dossiers.set(dossier.caseId, structuredClone(dossier));
  }
  async read(caseId: string): Promise<RuntimeCaseDossier> {
    const dossier = this.dossiers.get(caseId);
    if (dossier === undefined) throw new Error("unknown case");
    return structuredClone(dossier);
  }
  async save(dossier: RuntimeCaseDossier): Promise<void> {
    this.dossiers.set(dossier.caseId, structuredClone(dossier));
  }
}

function fixture() {
  const repository = new MemoryRepository();
  const lawCalls: unknown[] = [];
  const provider = {
    state: {
      status: "authenticated",
      account: { type: "chatgpt", email: "a@example.test", planType: "plus" },
    },
    startChatGptLogin: async () => ({
      loginId: "login-1",
      authorizationUrl: "https://auth.openai.com/authorize",
    }),
    async dispose() {},
  } as CodexAgentProvider;
  const law = {
    tools: () => ["search_law"],
    discover: async () => ["search_law" as const],
    execute: async (tool: unknown, arguments_: unknown) => {
      lawCalls.push({ tool, arguments: arguments_ });
      if (tool === "search_law") {
        return {
          ok: true as const,
          value: {
            content: [{ type: "text", text: "민법\nMST: 261817" }],
            citations: [],
          },
        };
      }
      return {
        ok: true as const,
        value: {
          content: "민법",
          citations: [
            {
              citationId: "c".repeat(64),
              sourceUrl: "https://www.law.go.kr/법령/민법",
              law: "민법",
              versionDate: "2026-01-01",
              retrievedAt: "2026-08-11T00:00:00.000Z",
              toolName: "search_law" as const,
              resultDigest: "d".repeat(64),
            },
          ],
        },
      };
    },
    close: async () => {},
  } as KoreanLawMcpAdapter;
  let evidenceNumber = 0;
  const service = new CaseRuntimeService({
    repository,
    nextCaseId: () => "case-1",
    storeEvidence: async () => ({ id: `evidence-${++evidenceNumber}`, sha256: "a".repeat(64) }),
    analyzeEvidence: async () => ({
      status: "readable",
      candidates: [
        {
          text: "홍길동 110-123-456789",
          confidence: 90,
          boundingBox: { x: 0, y: 0, width: 10, height: 10 },
          confirmation: "unconfirmed",
        },
      ],
      needsManualConfirmation: true,
    }),
    redactor: new Redactor(new Uint8Array(32).fill(1)),
    law,
    provider: async () => provider,
  });
  return { lawCalls, repository, service };
}

async function preparedFixture() {
  const result = fixture();
  await result.service.createCase({ amountKrw: 100_000 });
  await result.service.analyzeEvidence({
    caseId: "case-1",
    filename: "receipt.png",
    mimeType: "image/png",
    bytes: new Uint8Array([1, 2, 3]),
  });
  return result;
}

describe("runtime case service", () => {
  test("persists a dossier and associates evidence metadata with its case", async () => {
    const { repository, service } = fixture();
    await service.createCase({ amountKrw: 100_000 });
    await service.analyzeEvidence({
      caseId: "case-1",
      filename: "receipt.png",
      mimeType: "image/png",
      bytes: new Uint8Array([1, 2, 3]),
    });

    expect(repository.dossiers.get("case-1")?.evidence).toEqual([
      {
        evidenceId: "evidence-1",
        filename: "receipt.png",
        mimeType: "image/png",
        sha256: "a".repeat(64),
      },
    ]);
  });

  test("confirms OCR through the domain and persists each typed workflow transition", async () => {
    const { repository, service } = await preparedFixture();
    expect(
      await service.confirmOcrFacts({
        caseId: "case-1",
        evidenceId: "evidence-1",
        facts: [{ field: "recipient-account", value: "110-123-456789" }],
      }),
    ).toMatchObject({ status: "ok", snapshot: { criminalState: "evidence-review" } });
    expect(await service.advanceCriminal("case-1", "prepare-complaint")).toMatchObject({
      status: "ok",
      snapshot: { criminalState: "complaint-ready" },
    });
    expect(await service.advanceCivil("case-1", "apply-payment-order", false)).toMatchObject({
      status: "ok",
      snapshot: { civilState: "payment-order-pending" },
    });
    expect(await service.advanceCivil("case-1", "attest-service", true)).toMatchObject({
      status: "ok",
      snapshot: { civilState: "service-attested" },
    });
    expect(await service.advanceCivil("case-1", "record-judgment", false)).toMatchObject({
      status: "ok",
      snapshot: { civilState: "judgment-recorded" },
    });
    expect((await service.enforcementChoices("case-1")).status).toBe("not-allowed");
    expect(await service.advanceCivil("case-1", "attest-finality", true)).toMatchObject({
      status: "ok",
      snapshot: { civilState: "enforceable-title-confirmed" },
    });
    expect((await service.enforcementChoices("case-1")).status).toBe("ok");
    expect(repository.dossiers.get("case-1")?.confirmedOcrFacts).toEqual([
      { field: "recipient-account", value: "110-123-456789" },
    ]);
  });

  test("returns official law citations from redacted stored facts", async () => {
    const { lawCalls, repository, service } = await preparedFixture();
    await service.confirmOcrFacts({
      caseId: "case-1",
      evidenceId: "evidence-1",
      facts: [{ field: "account", value: "110-123-456789" }],
    });
    const guidance = await service.guidance(
      "case-1",
      "홍길동 victim@example.com 계좌 110-123-456789 사건 2026가단123456 민법상 부당이득",
    );
    expect(guidance).toMatchObject({
      status: "ok",
      citations: [{ sourceUrl: "https://www.law.go.kr/법령/민법" }],
    });
    expect(repository.dossiers.get("case-1")?.retrievedCitations).toHaveLength(1);
    const lawPayload = JSON.stringify(lawCalls);
    expect(lawPayload).not.toContain("110-123-456789");
    expect(lawPayload).not.toContain("2026가단123456");
    expect(lawPayload).not.toContain("홍길동");
    expect(lawPayload).not.toContain("victim@example.com");
    expect(lawPayload).not.toContain("[ACCOUNT_");
    expect(lawPayload).not.toContain("[CASE_");
    expect(lawPayload).toContain('"query":"민법"');
    expect(lawPayload).toContain('"mst":"261817"');
  });

  test("serializes concurrent read-modify-save transitions for one case", async () => {
    const { repository, service } = await preparedFixture();
    await service.confirmOcrFacts({
      caseId: "case-1",
      evidenceId: "evidence-1",
      facts: [{ field: "amount", value: "100000" }],
    });
    await Promise.all([
      service.advanceCriminal("case-1", "prepare-complaint"),
      service.advanceCivil("case-1", "apply-payment-order", false),
    ]);

    expect(repository.dossiers.get("case-1")?.workflow).toMatchObject({
      criminalState: "complaint-ready",
      civilState: "payment-order-pending",
    });
  });
});
