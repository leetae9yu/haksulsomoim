import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import type {
  SecureComputerAction,
  SecureComputerActionResult,
  SecureComputerObservation,
} from "./contracts";
import { createSecureComputerMcpServer } from "./mcp-server";

const digest = "a".repeat(64);

class FakeSecureComputer {
  readonly actions: SecureComputerAction[] = [];

  async start(): Promise<void> {}

  async observe(): Promise<SecureComputerObservation> {
    return {
      url: "https://ecfs.scourt.go.kr/ecf/form.jsp",
      width: 1280,
      height: 900,
      imagePng: new TextEncoder().encode("masked-image"),
      maskedText: "전화: [PHONE_AAAAAAAAAAAAAAAA]",
      observationDigest: digest,
    };
  }

  async act(action: SecureComputerAction): Promise<SecureComputerActionResult> {
    this.actions.push(action);
    return { outcome: "executed", actionCount: this.actions.length };
  }

  async close(): Promise<void> {}
}

describe("secure-computer MCP server", () => {
  test("exposes only narrow tools and returns masked image observations", async () => {
    const computer = new FakeSecureComputer();
    const server = createSecureComputerMcpServer(computer);
    const client = new Client({ name: "secure-computer-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
      "secure_computer_click",
      "secure_computer_close",
      "secure_computer_observe",
      "secure_computer_scroll",
      "secure_computer_start",
      "secure_computer_type_text",
      "secure_computer_type_token",
    ]);

    const observation = await client.callTool({ name: "secure_computer_observe", arguments: {} });
    expect(JSON.stringify(observation)).not.toContain("010-1234-5678");
    expect(observation.content).toContainEqual({
      type: "image",
      data: Buffer.from("masked-image").toString("base64"),
      mimeType: "image/png",
    });

    const click = await client.callTool({
      name: "secure_computer_click",
      arguments: { x: 10, y: 20, observationDigest: digest },
    });
    expect(click.isError).toBe(false);
    expect(computer.actions).toEqual([{ kind: "click", x: 10, y: 20, observationDigest: digest }]);

    await client.close();
    await server.close();
  });
});
