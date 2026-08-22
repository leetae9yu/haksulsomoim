import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CaseWorkspace } from "./index";
import { createCaseWorkspaceMcpServer } from "./mcp-server.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("case workspace MCP", () => {
  test("creates and reads only a masked case summary through MCP", async () => {
    const root = await mkdtemp(join(tmpdir(), "haksul-case-mcp-"));
    roots.push(root);
    const workspace = new CaseWorkspace({
      casesRoot: root,
      now: () => new Date("2026-08-22T10:00:00.000Z"),
      idFactory: () => "0123456789abcdef",
    });
    const server = createCaseWorkspaceMcpServer(workspace);
    const client = new Client({ name: "case-workspace-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const created = await client.callTool({
      name: "case_create",
      arguments: {
        amountKrw: 5_380_000,
        occurredAt: "2026-08-01",
        summary: "홍길동에게 물품대금을 송금함",
        counterpartyAlias: "홍길동",
      },
    });
    expect(created.isError).not.toBe(true);
    expect(JSON.stringify(created)).not.toContain("홍길동");

    const read = await client.callTool({
      name: "case_get_masked",
      arguments: { caseId: "case-0123456789abcdef" },
    });
    expect(JSON.stringify(read)).toContain('"summary":"[MASKED]"');
    await Promise.all([client.close(), server.close()]);
  });
});
