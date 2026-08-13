import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ApprovedAgentDecisionContext } from "../src/integrations/agent-provider/agent-provider";
import { createCodexAgentProvider } from "../src/integrations/agent-provider/agent-provider";
import { launchCodexAppServer } from "../src/integrations/agent-provider/codex-app-server-launcher";
import { Redactor, sanitizeSecret } from "../src/security/redaction";

function evidenceDirectory(arguments_: readonly string[]): string {
  const optionIndex = arguments_.indexOf("--evidence-dir");
  const value = optionIndex >= 0 ? arguments_[optionIndex + 1] : undefined;
  if (value === undefined || value.length === 0) {
    throw new TypeError("Usage: qa:agent-provider -- --evidence-dir <directory>");
  }
  return resolve(value);
}

const outputDirectory = evidenceDirectory(process.argv.slice(2));
const started = await launchCodexAppServer();
const provider = await createCodexAgentProvider(async () => started);
let structuredDecision: Readonly<{ kind: string; approvedTool?: string; valid: true }> | undefined;
let decisionFailure: "structured-decision-failed" | undefined;

try {
  if (provider.state.status === "authenticated") {
    const redactor = new Redactor(new Uint8Array(32).fill(0x41));
    const context = Object.freeze({
      approval: "user-approved",
      contextDigest: "a".repeat(64),
      goal: {
        kind: "civil-recovery",
        caseId: "qa-agent-provider",
        objective: "prepare-civil-demand",
      },
      maskedFacts: Object.freeze([
        {
          id: "fact-amount",
          text: redactor.redact(
            "qa-agent-provider",
            "sender: 홍길동, claimant@example.com, 110-123-456789 계좌로 5,380,000원 송금",
          ),
        },
      ]),
      citationIds: Object.freeze([]),
      observations: Object.freeze([]),
    }) as unknown as ApprovedAgentDecisionContext;
    try {
      const decision = await provider.nextDecision(context);
      structuredDecision = Object.freeze({
        kind: decision.kind,
        ...(decision.kind === "tool" ? { approvedTool: decision.toolCall.toolName } : {}),
        valid: true as const,
      });
    } catch {
      decisionFailure = "structured-decision-failed";
    }
  }
} finally {
  await provider.dispose();
}

const state =
  provider.state.status === "authenticated"
    ? {
        status: provider.state.status,
        accountPresent: true,
        planType: provider.state.account.planType,
      }
    : provider.state;
const recoverable =
  (provider.state.status === "sign-in-required" &&
    provider.state.action === "sign-in-with-chatgpt") ||
  (provider.state.status === "unavailable" && provider.state.mode === "manual");
const passed =
  (provider.state.status === "authenticated" && structuredDecision?.valid === true) || recoverable;
const evidence = Object.freeze({
  scenario: "codex-oauth-structured-agent-decision",
  status: passed ? "PASS" : "FAIL",
  state,
  structuredDecision,
  decisionFailure,
  recoverable,
  credentialStoredByApp: false,
  cleanup: "provider-disposed",
});
await mkdir(outputDirectory, { recursive: true });
const outputPath = resolve(outputDirectory, "agent-provider-proof.json");
const serializedEvidence = sanitizeSecret(JSON.stringify(evidence, null, 2), process.env.LAW_OC);
await writeFile(outputPath, `${serializedEvidence}\n`, { encoding: "utf8", mode: 0o600 });
console.log(
  sanitizeSecret(JSON.stringify({ ...evidence, evidencePath: outputPath }), process.env.LAW_OC),
);
if (!passed) process.exitCode = 1;
