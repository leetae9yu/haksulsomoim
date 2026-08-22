import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type {
  SecureComputerAction,
  SecureComputerActionResult,
  SecureComputerObservation,
} from "../servers/contracts/secure-computer";
import { createPluginMcpServer } from "../servers/plugin-server";
import type { SecureComputerPort } from "../servers/secure-computer/mcp-server";

class QaComputer implements SecureComputerPort {
  async start(): Promise<void> {}
  async observe(): Promise<SecureComputerObservation> {
    return {
      url: "https://ecfs.scourt.go.kr",
      width: 800,
      height: 600,
      imagePng: new TextEncoder().encode("masked"),
      maskedText: "[PHONE_ABCDEFGHIJKLMNOP]",
      observationDigest: "a".repeat(64),
    };
  }
  async act(_action: SecureComputerAction): Promise<SecureComputerActionResult> {
    return { outcome: "executed", actionCount: 1 };
  }
  async close(): Promise<void> {}
}

const root = await mkdtemp(join(tmpdir(), "haksul-mcp-qa-"));
const casesRoot = join(root, "cases");
const evidenceRoot = join(casesRoot, "incoming");
await mkdir(evidenceRoot, { recursive: true });
const evidencePath = join(evidenceRoot, "receipt.txt");
await writeFile(evidencePath, "synthetic transfer receipt");

const server = createPluginMcpServer({
  casesRoot,
  computer: new QaComputer(),
  now: () => new Date("2026-08-22T10:00:00.000Z"),
  idFactory: () => "0123456789abcdef",
});
const client = new Client({ name: "haksulsomoim-qa", version: "1.0.0" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

try {
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const tools = (await client.listTools()).tools.map((tool) => tool.name).sort();
  const created = await client.callTool({
    name: "case_create",
    arguments: {
      amountKrw: 5_380_000,
      occurredAt: "2026-08-01",
      summary: "synthetic private summary",
      counterpartyAlias: "synthetic alias",
    },
  });
  const serialized = JSON.stringify(created);
  if (created.isError === true) throw new Error("case_create failed");
  if (serialized.includes("synthetic private summary") || serialized.includes("synthetic alias")) {
    throw new Error("Raw case facts escaped through MCP");
  }
  const evidence = await client.callTool({
    name: "case_add_evidence",
    arguments: {
      caseId: "case-0123456789abcdef",
      path: evidencePath,
      kind: "transfer-receipt",
      description: "Synthetic receipt",
    },
  });
  if (evidence.isError === true) throw new Error("case_add_evidence failed");
  const criminal = await client.callTool({
    name: "case_set_criminal_stage",
    arguments: { caseId: "case-0123456789abcdef", stage: "complaint-ready" },
  });
  if (criminal.isError === true) throw new Error("criminal stage update failed");
  process.stdout.write(
    `${JSON.stringify({
      scenario: "plugin-mcp",
      status: "PASS",
      toolCount: tools.length,
      tools,
      caseId: "case-0123456789abcdef",
      rawFactsExposed: false,
    })}\n`,
  );
} finally {
  await Promise.all([client.close(), server.close()]);
  await rm(root, { recursive: true, force: true });
}
