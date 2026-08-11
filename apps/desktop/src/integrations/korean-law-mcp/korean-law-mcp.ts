import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
  type StdioServerParameters,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { parseKoreanLawCitations } from "./citation-parser";

export const ALLOWED_KOREAN_LAW_TOOLS = [
  "search_law",
  "get_law_text",
  "get_annexes",
  "search_decisions",
  "get_decision_text",
] as const;

export type KoreanLawToolName = (typeof ALLOWED_KOREAN_LAW_TOOLS)[number];

const ALLOWED_TOOL_NAMES: ReadonlySet<string> = new Set(ALLOWED_KOREAN_LAW_TOOLS);

export interface KoreanLawMcpLaunchOptions {
  command: string;
  args: string[];
  env: Record<string, string>;
  stderr: NonNullable<StdioServerParameters["stderr"]>;
}

export interface KoreanLawMcpClient {
  connect(transport: unknown): Promise<void>;
  callTool(request: { name: string; arguments?: Record<string, unknown> }): Promise<unknown>;
  close(): Promise<void>;
}

export interface KoreanLawCitation {
  sourceUrl: string;
  law: string;
  versionDate: string;
  retrievedAt: string;
  toolName: KoreanLawToolName;
  resultDigest: string;
}

export interface KoreanLawToolValue {
  content: unknown;
  structuredContent?: unknown;
  citations: KoreanLawCitation[];
}

export type KoreanLawMcpResult =
  | { ok: true; value: KoreanLawToolValue }
  | {
      ok: false;
      error:
        | { code: "needs_credentials"; credential: "LAW_OC" }
        | { code: "tool_not_allowed"; tool: string }
        | { code: "execution_failed"; tool: KoreanLawToolName; message: string };
    };

export interface KoreanLawMcpAdapter {
  tools(): readonly KoreanLawToolName[];
  execute(tool: string, arguments_: Record<string, unknown>): Promise<KoreanLawMcpResult>;
  close(): Promise<void>;
}

export interface CreateKoreanLawMcpAdapterOptions {
  /** Explicit LAW_OC. When omitted, the current process environment is read once. */
  lawOc?: string;
  clientFactory?: () => KoreanLawMcpClient;
  transportFactory?: (options: KoreanLawMcpLaunchOptions) => unknown;
  logger?: (message: string, details?: Record<string, unknown>) => void;
  now?: () => Date;
}

interface ObjectValue {
  [key: string]: unknown;
}

function isObject(value: unknown): value is ObjectValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function defaultClientFactory(): KoreanLawMcpClient {
  const client = new Client({ name: "haksulsomoim-korean-law", version: "1.0.0" });

  return {
    connect: (transport) => client.connect(transport as Transport),
    callTool: (request) => client.callTool(request),
    close: () => client.close(),
  };
}

function defaultTransportFactory(options: KoreanLawMcpLaunchOptions): Transport {
  return new StdioClientTransport(options);
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== "") return error.message;
  return "Korean law MCP tool execution failed";
}

export function createKoreanLawMcpAdapter(
  options: CreateKoreanLawMcpAdapterOptions = {},
): KoreanLawMcpAdapter {
  const credential = (options.lawOc === undefined ? process.env.LAW_OC : options.lawOc)?.trim();
  const clientFactory = options.clientFactory ?? defaultClientFactory;
  const transportFactory = options.transportFactory ?? defaultTransportFactory;
  const now = options.now ?? (() => new Date());
  const logger = options.logger;

  let client: KoreanLawMcpClient | undefined;
  let connection: Promise<void> | undefined;

  function connect(): Promise<void> {
    if (connection !== undefined) return connection;

    client = clientFactory();
    const launchOptions: KoreanLawMcpLaunchOptions = {
      command: "korean-law-mcp",
      args: [],
      env: { ...getDefaultEnvironment(), LAW_OC: credential as string },
      stderr: "pipe",
    };
    const transport = transportFactory(launchOptions);

    logger?.("Starting Korean law MCP", { command: launchOptions.command });
    connection = client.connect(transport);
    return connection;
  }

  return {
    tools: () => ALLOWED_KOREAN_LAW_TOOLS,

    async execute(tool, arguments_) {
      if (!ALLOWED_TOOL_NAMES.has(tool)) {
        return { ok: false, error: { code: "tool_not_allowed", tool } };
      }
      if (credential === undefined || credential === "") {
        return {
          ok: false,
          error: { code: "needs_credentials", credential: "LAW_OC" },
        };
      }

      const toolName = tool as KoreanLawToolName;
      try {
        await connect();
        logger?.("Calling Korean law MCP tool", { tool: toolName });
        const rawResult = await (client as KoreanLawMcpClient).callTool({
          name: toolName,
          arguments: arguments_,
        });
        const normalizedResult = isObject(rawResult) ? rawResult : { content: rawResult };
        const resultDigest = createHash("sha256").update(JSON.stringify(rawResult)).digest("hex");
        const value: KoreanLawToolValue = {
          content: normalizedResult.content,
          citations: parseKoreanLawCitations(
            normalizedResult,
            toolName,
            resultDigest,
            now().toISOString(),
          ),
        };
        if ("structuredContent" in normalizedResult) {
          value.structuredContent = normalizedResult.structuredContent;
        }

        return { ok: true, value };
      } catch (error) {
        return {
          ok: false,
          error: {
            code: "execution_failed",
            tool: toolName,
            message: safeErrorMessage(error),
          },
        };
      }
    },

    async close() {
      if (client !== undefined) await client.close();
    },
  };
}
