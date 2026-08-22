import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type {
  SecureComputerAction,
  SecureComputerActionResult,
  SecureComputerObservation,
} from "./contracts/secure-computer";
import { createPluginMcpServer } from "./plugin-server.ts";
import type { SecureComputerPort } from "./secure-computer/mcp-server";

const roots: string[] = [];

class FakeComputer implements SecureComputerPort {
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

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("combined plugin MCP server", () => {
  test("publishes case and secure-computer tools through one server", async () => {
    const casesRoot = await mkdtemp(join(tmpdir(), "haksul-plugin-mcp-"));
    roots.push(casesRoot);
    const server = createPluginMcpServer({
      casesRoot,
      computer: new FakeComputer(),
      now: () => new Date("2026-08-22T10:00:00.000Z"),
      idFactory: () => "0123456789abcdef",
    });
    const client = new Client({ name: "plugin-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain("case_create");
    expect(names).toContain("secure_computer_observe");
    await Promise.all([client.close(), server.close()]);
  });
});
