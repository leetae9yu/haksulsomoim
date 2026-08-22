import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
  type StdioServerParameters,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { parseKoreanLawCitations } from "./citation-parser";

export const ALLOWED_KOREAN_LAW_TOOLS = [
  "legal_research",
  "legal_analysis",
  "search_law",
  "get_law_text",
  "get_annexes",
  "search_decisions",
  "get_decision_text",
] as const;

export type KoreanLawToolName = (typeof ALLOWED_KOREAN_LAW_TOOLS)[number];

type ObjectValue = Record<string, unknown>;

const ALLOWED_TOOL_NAMES: ReadonlySet<string> = new Set(ALLOWED_KOREAN_LAW_TOOLS);

export interface KoreanLawMcpLaunchOptions {
  command: string;
  args: string[];
  env: Record<string, string>;
  stderr: NonNullable<StdioServerParameters["stderr"]>;
}

export interface KoreanLawMcpClient {
  connect(transport: unknown): Promise<void>;
  listTools(): Promise<unknown>;
  callTool(
    request: { name: KoreanLawToolName; arguments: Record<string, unknown> },
    options?: RequestOptions,
  ): Promise<unknown>;
  close(): Promise<void>;
}

export interface KoreanLawCitation {
  citationId: string;
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
        | { code: "tool_not_allowed"; tool: "[REJECTED]" }
        | { code: "execution_failed"; tool: KoreanLawToolName; message: string };
    };

export interface KoreanLawExecutionOptions {
  signal?: AbortSignal;
  timeout?: number;
}

export interface KoreanLawMcpIntegration {
  tools(): readonly KoreanLawToolName[];
  discover(options?: KoreanLawExecutionOptions): Promise<readonly KoreanLawToolName[]>;
  execute(
    tool: string,
    arguments_: Record<string, unknown>,
    options?: KoreanLawExecutionOptions,
  ): Promise<KoreanLawMcpResult>;
  close(): Promise<void>;
}

export interface CreateKoreanLawMcpClientOptions {
  lawOc?: string;
  clientFactory?: () => KoreanLawMcpClient;
  transportFactory?: (options: KoreanLawMcpLaunchOptions) => unknown;
  now?: () => Date;
}

function isObject(value: unknown): value is ObjectValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function defaultClientFactory(): KoreanLawMcpClient {
  const client = new Client({ name: "haksulsomoim-korean-law", version: "1.0.0" });
  return {
    connect: (transport) => client.connect(transport as Transport),
    listTools: () => client.listTools(),
    callTool: (request, options) => client.callTool(request, undefined, options),
    close: () => client.close(),
  };
}

function defaultTransportFactory(options: KoreanLawMcpLaunchOptions): Transport {
  return new StdioClientTransport(options);
}

function entrypoint(): string {
  return fileURLToPath(import.meta.resolve("korean-law-mcp"));
}

function discoveredToolNames(value: unknown): readonly KoreanLawToolName[] {
  if (!isObject(value) || !Array.isArray(value.tools)) return [];
  const names = new Set(
    value.tools
      .filter(isObject)
      .map((tool) => tool.name)
      .filter((name): name is string => typeof name === "string"),
  );
  return ALLOWED_KOREAN_LAW_TOOLS.filter((name) => names.has(name));
}

function requestOptions(
  options: KoreanLawExecutionOptions | undefined,
): RequestOptions | undefined {
  if (options === undefined) return undefined;
  const timeout = options.timeout;
  return {
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(timeout === undefined ? {} : { timeout, maxTotalTimeout: timeout }),
  };
}

export function createKoreanLawMcpClient(
  options: CreateKoreanLawMcpClientOptions = {},
): KoreanLawMcpIntegration {
  const credential = (options.lawOc ?? process.env.LAW_OC)?.trim();
  const clientFactory = options.clientFactory ?? defaultClientFactory;
  const transportFactory = options.transportFactory ?? defaultTransportFactory;
  const now = options.now ?? (() => new Date());
  let client: KoreanLawMcpClient | undefined;
  let connection: Promise<void> | undefined;

  function connect(): Promise<void> {
    if (connection !== undefined) return connection;
    client = clientFactory();
    const launchOptions: KoreanLawMcpLaunchOptions = {
      command: process.execPath,
      args: [entrypoint()],
      env: { ...getDefaultEnvironment(), LAW_OC: credential as string },
      stderr: "pipe",
    };
    connection = client.connect(transportFactory(launchOptions));
    return connection;
  }

  return {
    tools: () => ALLOWED_KOREAN_LAW_TOOLS,

    async discover(executionOptions) {
      executionOptions?.signal?.throwIfAborted();
      if (credential === undefined || credential === "") return [];
      try {
        await connect();
        executionOptions?.signal?.throwIfAborted();
        return discoveredToolNames(await (client as KoreanLawMcpClient).listTools());
      } catch (error) {
        if (executionOptions?.signal?.aborted) throw error;
        return [];
      }
    },

    async execute(tool, arguments_, executionOptions) {
      executionOptions?.signal?.throwIfAborted();
      if (!ALLOWED_TOOL_NAMES.has(tool)) {
        return { ok: false, error: { code: "tool_not_allowed", tool: "[REJECTED]" } };
      }
      if (credential === undefined || credential === "") {
        return { ok: false, error: { code: "needs_credentials", credential: "LAW_OC" } };
      }

      const toolName = tool as KoreanLawToolName;
      try {
        await connect();
        const rawResult = await (client as KoreanLawMcpClient).callTool(
          { name: toolName, arguments: arguments_ },
          requestOptions(executionOptions),
        );
        const normalizedResult = isObject(rawResult) ? rawResult : { content: rawResult };
        const value: KoreanLawToolValue = {
          content: normalizedResult.content,
          citations: parseKoreanLawCitations(
            normalizedResult,
            toolName,
            createHash("sha256").update(JSON.stringify(rawResult)).digest("hex"),
            now().toISOString(),
          ),
        };
        if ("structuredContent" in normalizedResult) {
          value.structuredContent = normalizedResult.structuredContent;
        }
        return { ok: true, value };
      } catch (error) {
        if (executionOptions?.signal?.aborted) throw error;
        return {
          ok: false,
          error: {
            code: "execution_failed",
            tool: toolName,
            message: "Korean law MCP tool execution failed",
          },
        };
      }
    },

    async close() {
      if (client !== undefined) await client.close();
    },
  };
}
