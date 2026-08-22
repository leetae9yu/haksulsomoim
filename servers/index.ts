import { randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createPluginMcpServer } from "./plugin-server.ts";
import { createSecureComputerRuntime } from "./secure-computer/index.ts";

function allowedHosts(): readonly string[] {
  const hosts = (process.env.HAKSUL_SECURE_COMPUTER_HOSTS ?? "ecfs.scourt.go.kr,law.go.kr")
    .split(",")
    .map((host) => host.trim())
    .filter((host) => host.length > 0);
  if (hosts.length === 0) throw new TypeError("At least one secure-computer host is required");
  return hosts;
}

const computer = await createSecureComputerRuntime({
  allowedHosts: allowedHosts(),
  caseId: process.env.HAKSUL_CASE_ID ?? `session-${randomUUID()}`,
  redactionKey: randomBytes(32),
  ...(process.env.HAKSUL_BROWSER_EXECUTABLE === undefined
    ? {}
    : { executablePath: process.env.HAKSUL_BROWSER_EXECUTABLE }),
});

const server = createPluginMcpServer({
  casesRoot: resolve(process.env.HAKSUL_CASES_DIR ?? ".haksulsomoim/cases"),
  computer,
});
await server.connect(new StdioServerTransport());
