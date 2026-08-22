import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";

const pluginRoot = resolve(process.argv[2] ?? "plugin");
const casesRoot = await mkdtemp(join(tmpdir(), "haksul-installed-mcp-"));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(pluginRoot, "servers", "index.js")],
  env: {
    ...getDefaultEnvironment(),
    HAKSUL_CASES_DIR: casesRoot,
    HAKSUL_BROWSER_HEADLESS: "true",
  },
  stderr: "pipe",
});
const client = new Client({ name: "haksulsomoim-installed-qa", version: "1.0.0" });

try {
  await client.connect(transport);
  const tools = (await client.listTools()).tools.map((tool) => tool.name).sort();
  if (!tools.includes("case_create") || !tools.includes("secure_computer_observe")) {
    throw new Error("Installed MCP tool surface is incomplete");
  }
  process.stdout.write(
    `${JSON.stringify({
      scenario: "installed-plugin-mcp",
      status: "PASS",
      pluginRoot,
      toolCount: tools.length,
    })}\n`,
  );
} finally {
  await client.close();
  await rm(casesRoot, { recursive: true, force: true });
}
