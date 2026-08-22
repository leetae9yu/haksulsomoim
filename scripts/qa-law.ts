import { createKoreanLawMcpClient } from "../servers/korean-law/korean-law-mcp";

const client = createKoreanLawMcpClient();
let exitCode = 0;

try {
  const tools = await client.discover({ timeout: 30_000 });
  if (!tools.includes("search_law")) throw new Error("search_law was not discovered");
  const result = await client.execute("search_law", { query: "민사소송법" }, { timeout: 30_000 });
  if (!result.ok) throw new Error(result.error.code);
  if (result.value.citations.length === 0) throw new Error("No official citation was returned");
  if (!result.value.citations.every((citation) => citation.sourceUrl.startsWith("https://www."))) {
    throw new Error("Citation origin was not normalized to an official HTTPS URL");
  }
  process.stdout.write(
    `${JSON.stringify({
      scenario: "korean-law-live",
      status: "PASS",
      toolCount: tools.length,
      citationCount: result.value.citations.length,
      citationHosts: [
        ...new Set(result.value.citations.map((citation) => new URL(citation.sourceUrl).host)),
      ],
    })}\n`,
  );
} catch (error) {
  exitCode = 1;
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(
    `${JSON.stringify({ scenario: "korean-law-live", status: "FAIL", message })}\n`,
  );
} finally {
  await client.close();
  process.exitCode = exitCode;
}
