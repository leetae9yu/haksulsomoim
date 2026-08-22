import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CaseWorkspace, type CaseWorkspaceOptions } from "./case-workspace/index.ts";
import { registerCaseWorkspaceTools } from "./case-workspace/mcp-server.ts";
import type { SecureComputerPort } from "./secure-computer/mcp-server.ts";
import { registerSecureComputerTools } from "./secure-computer/mcp-server.ts";

export interface PluginServerOptions extends CaseWorkspaceOptions {
  readonly computer: SecureComputerPort;
}

export function createPluginMcpServer(options: PluginServerOptions): McpServer {
  const server = new McpServer({ name: "haksulsomoim-local", version: "0.1.0" });
  const workspace = new CaseWorkspace({
    casesRoot: options.casesRoot,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.idFactory === undefined ? {} : { idFactory: options.idFactory }),
  });
  registerCaseWorkspaceTools(server, workspace);
  registerSecureComputerTools(server, options.computer);
  return server;
}
