import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { app } from "electron";
import { UnavailableCodexAgentProvider } from "../integrations/agent-provider/unavailable-provider";
import type { KoreanLawMcpAdapter } from "../integrations/korean-law-mcp/korean-law-mcp";
import type { LocalOcrPort } from "../ocr/local-ocr";
import { bootstrapDesktop, reportBootstrapFailure } from "./bootstrap";
import { createDesktopRuntime } from "./runtime";

const QA_ONLY_DETERMINISTIC_MARKER = "HAKSUL_QA_ONLY_DETERMINISTIC_KEY_V1";
const HAPPY_FIXTURE_MARKER = "HAKSUL_QA_FIXTURE_HAPPY";

function requiredArgument(name: string): string {
  const prefix = `${name}=`;
  const value = process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
  if (value === undefined || value.length === 0) throw new TypeError(`Missing ${name}`);
  return value;
}

function createQaOcr(): Promise<LocalOcrPort> {
  return Promise.resolve({
    async recognize(bytes) {
      if (!new TextDecoder().decode(bytes).includes(HAPPY_FIXTURE_MARKER)) {
        return {
          status: "unreadable",
          reason: "no-text-detected",
          candidates: [],
          needsManualConfirmation: true,
        };
      }
      return {
        status: "readable",
        candidates: [
          {
            text: "5,380,000원 송금 완료 2026-08-11",
            confidence: 99,
            boundingBox: { x: 1, y: 1, width: 100, height: 20 },
            confirmation: "unconfirmed",
          },
        ],
        needsManualConfirmation: true,
      };
    },
    async terminate() {},
  });
}

function createQaLaw(): KoreanLawMcpAdapter {
  return {
    tools: () => ["search_law"],
    async discover() {
      return ["search_law"];
    },
    async execute() {
      return {
        ok: true,
        value: {
          content: { qa: true },
          citations: [
            {
              citationId: "230af24aa64ea4819039b5a7664367ba865262a9324d8636f427f4c3f21681bf",
              sourceUrl: "https://www.law.go.kr/법령/민사집행법",
              law: "민사집행법",
              versionDate: "2026-01-01",
              retrievedAt: "2026-08-11T00:00:00.000Z",
              toolName: "search_law",
              resultDigest: "230af24aa64ea4819039b5a7664367ba865262a9324d8636f427f4c3f21681bf",
            },
          ],
        },
      };
    },
    async close() {},
  };
}

const qaUserDataRoot = resolve(requiredArgument("--qa-user-data-root"));
app.setPath("userData", qaUserDataRoot);

void bootstrapDesktop((userDataPath) =>
  createDesktopRuntime(userDataPath, {
    loadKey: async () => createHash("sha256").update(QA_ONLY_DETERMINISTIC_MARKER).digest(),
    createLaw: createQaLaw,
    createOcr: createQaOcr,
    createProvider: async () => new UnavailableCodexAgentProvider("QA manual mode"),
  }),
).catch(reportBootstrapFailure);
