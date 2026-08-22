import { describe, expect, test } from "bun:test";
import {
  ALLOWED_KOREAN_LAW_TOOLS,
  createKoreanLawMcpClient,
  type KoreanLawMcpClient,
  type KoreanLawMcpLaunchOptions,
} from "./korean-law-mcp";

function fakeClient(result: unknown): KoreanLawMcpClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async connect() {},
    async listTools() {
      return { tools: ALLOWED_KOREAN_LAW_TOOLS.map((name) => ({ name })) };
    },
    async callTool(request) {
      calls.push(request.name);
      return result;
    },
    async close() {},
  };
}

describe("standalone Korean law MCP client", () => {
  test("does not launch without LAW_OC", async () => {
    const client = createKoreanLawMcpClient({
      lawOc: " ",
      clientFactory: () => {
        throw new Error("must not create a client");
      },
    });

    expect(await client.discover()).toEqual([]);
    expect(await client.execute("search_law", { query: "민법" })).toEqual({
      ok: false,
      error: { code: "needs_credentials", credential: "LAW_OC" },
    });
  });

  test("discovers only approved tools and executes them with an isolated credential", async () => {
    const secret = "law-secret-that-must-not-leak";
    const launches: KoreanLawMcpLaunchOptions[] = [];
    const mcp = fakeClient({
      content: [{ type: "text", text: "법령명: 민법\n시행일: 20250131" }],
    });
    const client = createKoreanLawMcpClient({
      lawOc: ` ${secret} `,
      clientFactory: () => mcp,
      transportFactory: (options) => {
        launches.push(options);
        return {};
      },
      now: () => new Date("2026-08-11T09:30:00.000Z"),
    });

    expect(await client.discover()).toEqual(ALLOWED_KOREAN_LAW_TOOLS);
    const result = await client.execute("get_law_text", { law: "민법" });

    expect(result).toMatchObject({
      ok: true,
      value: {
        citations: [{ law: "민법", versionDate: "2025-01-31" }],
      },
    });
    expect(mcp.calls).toEqual(["get_law_text"]);
    expect(launches).toHaveLength(1);
    expect(launches[0]?.env.LAW_OC).toBe(secret);
    expect(launches[0]?.args.join(" ")).not.toContain(secret);
  });

  test("rejects unapproved execution without exposing its name", async () => {
    const client = createKoreanLawMcpClient({ lawOc: "configured" });

    expect(await client.execute("read_file", { path: "/etc/passwd" })).toEqual({
      ok: false,
      error: { code: "tool_not_allowed", tool: "[REJECTED]" },
    });
  });
});
