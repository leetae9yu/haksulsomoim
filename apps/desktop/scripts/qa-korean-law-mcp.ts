import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createKoreanLawMcpAdapter } from "../src/integrations/korean-law-mcp/korean-law-mcp";
import { sanitizeSecret } from "../src/security/redaction";

function evidenceDirectory(arguments_: readonly string[]): string {
  const optionIndex = arguments_.indexOf("--evidence-dir");
  const value = optionIndex >= 0 ? arguments_[optionIndex + 1] : undefined;
  if (value === undefined || value.length === 0) {
    throw new TypeError("Usage: qa:korean-law-mcp -- --evidence-dir <directory>");
  }
  return resolve(value);
}

const outputDirectory = evidenceDirectory(process.argv.slice(2));
const credentialPresent = (process.env.LAW_OC?.trim().length ?? 0) > 0;
const adapter = createKoreanLawMcpAdapter();
const discoveredTools = await adapter.discover();
const discoveryAuthenticated =
  credentialPresent &&
  discoveredTools.length === 5 &&
  discoveredTools.includes("search_law") &&
  discoveredTools.includes("get_law_text");
const result = await adapter.execute("search_law", { query: "민사소송법" });
const detailResult = result.ok
  ? await adapter.execute("get_law_text", { mst: "252393" })
  : undefined;
await adapter.close();

const missingCredentialAdapter = createKoreanLawMcpAdapter({ lawOc: "" });
const missingCredentialResult = await missingCredentialAdapter.execute("search_law", {
  query: "민사소송법",
});
await missingCredentialAdapter.close();

const citations = [
  ...(result.ok ? result.value.citations : []),
  ...(detailResult?.ok ? detailResult.value.citations : []),
];
const citationCount = citations.length;
const externalFailure = result.ok ? undefined : result.error;
const credentialFallbackReady =
  !missingCredentialResult.ok && missingCredentialResult.error.code === "needs_credentials";
const authenticated = discoveryAuthenticated && result.ok && citationCount > 0;
const capturedExternalFailure =
  credentialPresent && externalFailure?.code === "execution_failed" && credentialFallbackReady;
const passed = authenticated || capturedExternalFailure;

const evidence = Object.freeze({
  scenario: "korean-law-mcp-live-search",
  status: passed ? "PASS" : "FAIL",
  credentialPresent,
  authenticated,
  discovery: {
    authenticated: discoveryAuthenticated,
    tools: discoveredTools,
  },
  tool: "search_law",
  citationCount,
  citationUrls: citations.map((citation) => citation.sourceUrl),
  resultShape: result.ok ? Object.keys(result.value).sort() : [],
  externalFailure,
  credentialFallbackReady,
});

await mkdir(outputDirectory, { recursive: true });
const outputPath = resolve(outputDirectory, "korean-law-mcp-proof.json");
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
