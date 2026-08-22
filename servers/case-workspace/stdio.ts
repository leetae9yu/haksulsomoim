import { resolve } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CaseWorkspace } from "./index";
import { createCaseWorkspaceMcpServer } from "./mcp-server";

const casesRoot = resolve(process.env.HAKSUL_CASES_DIR ?? ".haksulsomoim/cases");
const server = createCaseWorkspaceMcpServer(new CaseWorkspace({ casesRoot }));
await server.connect(new StdioServerTransport());
