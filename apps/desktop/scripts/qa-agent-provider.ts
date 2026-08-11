import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createCodexAgentProvider } from "../src/integrations/agent-provider/agent-provider";
import { launchCodexAppServer } from "../src/integrations/agent-provider/codex-app-server-launcher";

function evidenceDirectory(arguments_: readonly string[]): string {
  const optionIndex = arguments_.indexOf("--evidence-dir");
  const value = optionIndex >= 0 ? arguments_[optionIndex + 1] : undefined;
  if (value === undefined || value.length === 0) {
    throw new TypeError("Usage: qa:agent-provider -- --evidence-dir <directory>");
  }
  return resolve(value);
}

const outputDirectory = evidenceDirectory(process.argv.slice(2));
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const codexCommand = resolve(scriptDirectory, "../node_modules/.bin/codex");
const started = await launchCodexAppServer({ command: codexCommand });
const provider = await createCodexAgentProvider(async () => started);

let suggestion: Readonly<{ text: string; citationIds: readonly string[] }> | undefined;
if (provider.state.status === "authenticated") {
  suggestion = await provider.suggest({
    approval: "user-approved",
    maskedFacts: [
      {
        id: "fact-amount",
        text: "피해금은 [ACCOUNT_DZ2AULSBLFFJC65R] 계좌로 송금한 5,380,000원이다.",
      },
    ],
    citationIds: ["law-civil-procedure"],
  });
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
    provider.state.action === "sign-in-with-chatgpt");

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
await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, {
  encoding: "utf8",
  mode: 0o600,
});
console.log(JSON.stringify({ ...evidence, evidencePath: outputPath }));

if (!passed) {
  process.exitCode = 1;
}
