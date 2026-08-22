import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  caseCreateInputSchema,
  caseIdSchema,
  civilStageSchema,
  criminalStageSchema,
  evidenceAddInputSchema,
  type MaskedCaseSummary,
} from "../contracts/case-record.ts";
import type { CaseWorkspace } from "./index.ts";

function result(summary: MaskedCaseSummary) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(summary) }],
    structuredContent: summary,
  };
}

export function registerCaseWorkspaceTools(server: McpServer, workspace: CaseWorkspace): void {
  server.registerTool(
    "case_create",
    {
      description: "Create a local case workspace and return only a masked summary.",
      inputSchema: caseCreateInputSchema.shape,
      annotations: { destructiveHint: false, openWorldHint: false },
    },
    async (input) => result(await workspace.create(input)),
  );
  server.registerTool(
    "case_get_masked",
    {
      description: "Read the current case stages and counts without returning raw case facts.",
      inputSchema: { caseId: caseIdSchema },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ caseId }) => result(await workspace.getMasked(caseId)),
  );
  server.registerTool(
    "case_add_evidence",
    {
      description: "Hash and index an existing local evidence file without copying its contents.",
      inputSchema: evidenceAddInputSchema.shape,
      annotations: { destructiveHint: false, openWorldHint: false },
    },
    async (input) => result(await workspace.addEvidence(input)),
  );
  server.registerTool(
    "case_set_criminal_stage",
    {
      description: "Advance only the criminal track to a valid later stage.",
      inputSchema: { caseId: caseIdSchema, stage: criminalStageSchema },
      annotations: { destructiveHint: false, openWorldHint: false },
    },
    async ({ caseId, stage }) =>
      result(await workspace.updateTrack({ caseId, track: "criminal", stage })),
  );
  server.registerTool(
    "case_set_civil_stage",
    {
      description: "Advance only the civil track to a valid later stage.",
      inputSchema: { caseId: caseIdSchema, stage: civilStageSchema },
      annotations: { destructiveHint: false, openWorldHint: false },
    },
    async ({ caseId, stage }) =>
      result(await workspace.updateTrack({ caseId, track: "civil", stage })),
  );
}

export function createCaseWorkspaceMcpServer(workspace: CaseWorkspace): McpServer {
  const server = new McpServer({ name: "haksulsomoim-case-workspace", version: "0.1.0" });
  registerCaseWorkspaceTools(server, workspace);
  return server;
}

export const caseWorkspaceToolNames = [
  "case_create",
  "case_get_masked",
  "case_add_evidence",
  "case_set_criminal_stage",
  "case_set_civil_stage",
] as const;
