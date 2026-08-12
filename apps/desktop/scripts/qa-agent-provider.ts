import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  createCodexAgentProvider,
  createUserApprovedSuggestionInput,
} from "../src/integrations/agent-provider/agent-provider";
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

let suggestion: Readonly<{ text: string; citationIds: readonly string[] }> | undefined;
if (provider.state.status === "authenticated") {
  const redactor = new Redactor(new Uint8Array(32).fill(0x41));
  const input = createUserApprovedSuggestionInput(
    [
      {
        id: "fact-amount",
        text: redactor.redact(
          "qa-agent-provider",
          "피해금은 110-123-456789 계좌로 송금한 5,380,000원이다.",
        ),
      },
    ],
    ["law-civil-procedure"],
  );
  suggestion = await provider.suggest(input);
}

const state =
  provider.state.status === "authenticated"
    ? {
        status: provider.state.status,
        accountPresent: true,
        planType: provider.state.account.planType,
      }
    : provider.state;
const passed =
  (provider.state.status === "authenticated" &&
    suggestion !== undefined &&
    suggestion.text.length > 0) ||
  (provider.state.status === "sign-in-required" &&
    provider.state.action === "sign-in-with-chatgpt") ||
  (provider.state.status === "unavailable" && provider.state.mode === "manual");

provider.dispose();

const evidence = Object.freeze({
  scenario: "codex-oauth-agent-provider",
  status: passed ? "PASS" : "FAIL",
  state,
  suggestion,
  credentialStoredByApp: false,
  cleanup: "provider.dispose closed the app-server stdio process",
});
await mkdir(outputDirectory, { recursive: true });
const outputPath = resolve(outputDirectory, "agent-provider-proof.json");
const serializedEvidence = sanitizeSecret(JSON.stringify(evidence, null, 2), process.env.LAW_OC);
await writeFile(outputPath, `${serializedEvidence}\n`, {
  encoding: "utf8",
  mode: 0o600,
});
console.log(
  sanitizeSecret(JSON.stringify({ ...evidence, evidencePath: outputPath }), process.env.LAW_OC),
);

if (!passed) {
  process.exitCode = 1;
}
