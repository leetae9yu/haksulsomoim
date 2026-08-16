import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  type SecureComputerAction,
  type SecureComputerActionResult,
  type SecureComputerObservation,
  secureComputerActionSchema,
} from "./contracts";

export interface SecureComputerPort {
  start(url: string): Promise<void>;
  observe(): Promise<SecureComputerObservation>;
  act(action: SecureComputerAction): Promise<SecureComputerActionResult>;
  close(): Promise<void>;
}

const actionResult = (result: SecureComputerActionResult) => ({
  content: [{ type: "text" as const, text: JSON.stringify(result) }],
  isError: result.outcome === "rejected",
});

export const createSecureComputerMcpServer = (computer: SecureComputerPort): McpServer => {
  const server = new McpServer({ name: "haksulsomoim-secure-computer", version: "0.1.0" });

  server.registerTool(
    "secure_computer_start",
    {
      description: "Open an allowlisted URL in an isolated local browser.",
      inputSchema: { url: z.url().max(2_048) },
      annotations: { destructiveHint: false, openWorldHint: true },
    },
    async ({ url }) => {
      await computer.start(url);
      return { content: [{ type: "text", text: JSON.stringify({ outcome: "started" }) }] };
    },
  );

  server.registerTool(
    "secure_computer_observe",
    {
      description: "Return only a locally redacted PNG and masked screen text.",
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async () => {
      const observation = await computer.observe();
      const metadata = {
        url: observation.url,
        width: observation.width,
        height: observation.height,
        maskedText: observation.maskedText,
        observationDigest: observation.observationDigest,
      };
      return {
        content: [
          {
            type: "image",
            data: Buffer.from(observation.imagePng).toString("base64"),
            mimeType: "image/png",
          },
          { type: "text", text: JSON.stringify(metadata) },
        ],
        structuredContent: metadata,
      };
    },
  );

  server.registerTool(
    "secure_computer_click",
    {
      description:
        "Click a coordinate only if the current observation digest and local policy permit it.",
      inputSchema: secureComputerActionSchema.options[0].omit({ kind: true }).shape,
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    async (input) =>
      actionResult(
        await computer.act(secureComputerActionSchema.parse({ kind: "click", ...input })),
      ),
  );
  server.registerTool(
    "secure_computer_type_text",
    {
      description: "Type non-sensitive text; raw direct identifiers are rejected locally.",
      inputSchema: secureComputerActionSchema.options[1].omit({ kind: true }).shape,
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    async (input) =>
      actionResult(
        await computer.act(secureComputerActionSchema.parse({ kind: "type-text", ...input })),
      ),
  );
  server.registerTool(
    "secure_computer_type_token",
    {
      description:
        "Type a redaction token whose raw value is rehydrated only inside the local browser.",
      inputSchema: secureComputerActionSchema.options[2].omit({ kind: true }).shape,
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    async (input) =>
      actionResult(
        await computer.act(secureComputerActionSchema.parse({ kind: "type-token", ...input })),
      ),
  );
  server.registerTool(
    "secure_computer_scroll",
    {
      description: "Scroll only after binding to the latest redacted observation digest.",
      inputSchema: secureComputerActionSchema.options[3].omit({ kind: true }).shape,
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    async (input) =>
      actionResult(
        await computer.act(secureComputerActionSchema.parse({ kind: "scroll", ...input })),
      ),
  );

  server.registerTool(
    "secure_computer_close",
    {
      description: "Close the isolated browser and erase the in-memory token vault.",
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      await computer.close();
      return { content: [{ type: "text", text: JSON.stringify({ outcome: "closed" }) }] };
    },
  );

  return server;
};
