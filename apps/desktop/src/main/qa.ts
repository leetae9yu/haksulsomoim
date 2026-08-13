import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { app } from "electron";
import type { KoreanLawMcpAdapter } from "../integrations/korean-law-mcp/korean-law-mcp";
import type { LocalOcrPort } from "../ocr/local-ocr";
import { bootstrapDesktop, reportBootstrapFailure } from "./bootstrap";
import { createQaAgentProvider, type QaAgentScenario } from "./qa-agent-provider";
import { createDesktopRuntime } from "./runtime";

const QA_ONLY_DETERMINISTIC_MARKER = "HAKSUL_QA_ONLY_DETERMINISTIC_KEY_V1";
const HAPPY_FIXTURE_MARKER = "HAKSUL_QA_FIXTURE_HAPPY";

function requiredArgument(name: string): string {
  const prefix = `${name}=`;
  const value = process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
  if (value === undefined || value.length === 0) throw new TypeError(`Missing ${name}`);
  return value;
}

function qaScenario(): QaAgentScenario {
  const scenario = requiredArgument("--qa-scenario");
  if (
    scenario !== "happy" &&
    scenario !== "malformed" &&
    scenario !== "agent-happy" &&
    scenario !== "agent-approval" &&
    scenario !== "agent-live-controls" &&
    scenario !== "agent-resume" &&
    scenario !== "agent-provider-failure"
  ) {
    throw new TypeError("Unsupported QA scenario");
  }
  return scenario;
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
  let call = 0;
  const unresolvedTool = process.argv.includes("--qa-unresolved-tool");
  const unresolvedMarker = process.argv
    .find((argument) => argument.startsWith("--qa-unresolved-marker="))
    ?.slice("--qa-unresolved-marker=".length);
  return {
    tools: () => ["search_law"],
    async discover() {
      return ["search_law"];
    },
    async execute() {
      call += 1;
      if (unresolvedTool && call > 1) {
        if (unresolvedMarker !== undefined)
          await writeFile(unresolvedMarker, "entered", { mode: 0o600 });
        return new Promise<never>(() => undefined);
      }
      const ids = [
        "230af24aa64ea4819039b5a7664367ba865262a9324d8636f427f4c3f21681bf",
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      ] as const;
      const citationId = ids[Math.min(call - 1, 2)] ?? ids[2];
      const law = call === 1 ? "수동 민사집행법" : call === 2 ? "Agent 민법" : "Agent 민사소송법";
      return {
        ok: true,
        value: {
          content: { qa: true, law },
          citations: [
            {
              citationId,
              sourceUrl: `https://www.law.go.kr/법령/${encodeURIComponent(law)}`,
              law,
              versionDate: "2026-01-01",
              retrievedAt: "2026-08-11T00:00:00.000Z",
              toolName: "search_law",
              resultDigest: citationId,
            },
          ],
        },
      };
    },
    async close() {},
  };
}

const qaUserDataRoot = resolve(requiredArgument("--qa-user-data-root"));
const scenario = qaScenario();
app.setPath("userData", qaUserDataRoot);

void bootstrapDesktop((userDataPath) =>
  createDesktopRuntime(userDataPath, {
    loadKey: async () => createHash("sha256").update(QA_ONLY_DETERMINISTIC_MARKER).digest(),
    createLaw: createQaLaw,
    createOcr: createQaOcr,
    createProvider: async () =>
      createQaAgentProvider(scenario, {
        afterRestart: process.argv.includes("--qa-after-restart"),
        crashRestart: process.argv.includes("--qa-crash-restart"),
      }),
  }),
).catch(reportBootstrapFailure);
