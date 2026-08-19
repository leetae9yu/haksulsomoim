import { describe, expect, test } from "bun:test";
import {
  ALLOWED_KOREAN_LAW_TOOLS,
  createKoreanLawMcpAdapter,
  type KoreanLawMcpClient,
  type KoreanLawMcpLaunchOptions,
} from "./korean-law-mcp";

function fakeClient(result: unknown) {
  const calls: Array<{ name: string; arguments?: Record<string, unknown> }> = [];
  let connections = 0;

  const client: KoreanLawMcpClient = {
    async connect() {
      connections += 1;
    },
    async listTools() {
      return { tools: ALLOWED_KOREAN_LAW_TOOLS.map((name) => ({ name })) };
    },
    async callTool(request) {
      calls.push(request);
      return result;
    },
    async close() {},
  };

  return {
    client,
    calls,
    get connections() {
      return connections;
    },
  };
}

describe("Korean law MCP adapter", () => {
  test.each([undefined, "", "   "])(
    "returns typed needs_credentials before launching for LAW_OC=%p",
    async (lawOc: string | undefined) => {
      let launches = 0;
      const adapter = createKoreanLawMcpAdapter({
        ...(lawOc === undefined ? {} : { lawOc }),
        clientFactory: () => {
          throw new Error("client must not be created");
        },
        transportFactory: () => {
          launches += 1;
          return {};
        },
      });

      const result = await adapter.execute("search_law", { query: "민법" });

      expect(result).toEqual({
        ok: false,
        error: {
          code: "needs_credentials",
          credential: "LAW_OC",
        },
      });
      expect(launches).toBe(0);
    },
  );

  test("injects LAW_OC only into the child environment and never args or logs", async () => {
    const secret = "law-secret-that-must-not-leak";
    const originalParentValue = process.env.LAW_OC;
    const launches: KoreanLawMcpLaunchOptions[] = [];
    const logs: unknown[][] = [];
    const fake = fakeClient({ content: [{ type: "text", text: "result" }] });
    const adapter = createKoreanLawMcpAdapter({
      lawOc: `  ${secret}  `,
      clientFactory: () => fake.client,
      transportFactory: (options) => {
        launches.push(options);
        return { kind: "fake-transport" };
      },
      logger: (message, details) => logs.push([message, details]),
    });

    const result = await adapter.execute("search_law", { query: "민법" });

    expect(result.ok).toBe(true);
    expect(launches).toHaveLength(1);
    expect(launches[0]?.command).toBe("node");
    expect(launches[0]?.args).toHaveLength(1);
    expect(launches[0]?.args[0]?.replaceAll("\\", "/")).toEndWith("korean-law-mcp/build/index.js");
    expect(launches[0]?.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(launches[0]?.env.LAW_OC).toBe(secret);
    expect(launches[0]?.args.join(" ")).not.toContain(secret);
    expect(JSON.stringify(logs)).not.toContain(secret);
    expect(process.env.LAW_OC).toBe(originalParentValue);
    expect(fake.connections).toBe(1);
  });

  test("returns an opaque error without raw provider IDs, secrets, paths, or URLs", async () => {
    const secret = "law-secret-that-must-not-leak";
    const client: KoreanLawMcpClient = {
      async connect() {},
      async listTools() {
        return { tools: [] };
      },
      async callTool() {
        throw new Error(
          `provider-id=raw-tool-42 LAW_OC=${secret} /home/user/private https://evil.example/leak`,
        );
      },
      async close() {},
    };
    const adapter = createKoreanLawMcpAdapter({
      lawOc: secret,
      clientFactory: () => client,
      transportFactory: () => ({}),
    });

    const result = await adapter.execute("search_law", { query: "민법" });

    expect(result).toEqual({
      ok: false,
      error: {
        code: "execution_failed",
        tool: "search_law",
        message: "Korean law MCP tool execution failed",
      },
    });
    const serialized = JSON.stringify(result);
    for (const raw of [secret, "raw-tool-42", "/home/user/private", "evil.example"]) {
      expect(serialized).not.toContain(raw);
    }
  });

  test("exposes the approved direct-routing tools and rejects arbitrary discovery or execution", async () => {
    expect(ALLOWED_KOREAN_LAW_TOOLS).toEqual([
      "legal_research",
      "legal_analysis",
      "search_law",
      "get_law_text",
      "get_annexes",
      "search_decisions",
      "get_decision_text",
    ]);

    const fake = fakeClient({ content: [] });
    let launches = 0;
    const adapter = createKoreanLawMcpAdapter({
      lawOc: "configured",
      clientFactory: () => fake.client,
      transportFactory: () => {
        launches += 1;
        return {};
      },
    });

    expect(adapter.tools()).toEqual(ALLOWED_KOREAN_LAW_TOOLS);
    expect(await adapter.discover()).toEqual(ALLOWED_KOREAN_LAW_TOOLS);
    const discover = await adapter.execute("discover_tools", {});
    const arbitrary = await adapter.execute("read_file", { path: "/etc/passwd" });

    expect(discover).toEqual({
      ok: false,
      error: { code: "tool_not_allowed", tool: "[REJECTED]" },
    });
    expect(arbitrary).toEqual({
      ok: false,
      error: { code: "tool_not_allowed", tool: "[REJECTED]" },
    });
    expect(JSON.stringify([discover, arbitrary])).not.toMatch(/discover_tools|read_file|passwd/u);
    expect(launches).toBe(1);
    expect(fake.calls).toHaveLength(0);
  });
});
