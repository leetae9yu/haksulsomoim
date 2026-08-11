import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
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
    expect(launches[0]?.env.LAW_OC).toBe(secret);
    expect(launches[0]?.args.join(" ")).not.toContain(secret);
    expect(JSON.stringify(logs)).not.toContain(secret);
    expect(process.env.LAW_OC).toBe(originalParentValue);
    expect(fake.connections).toBe(1);
  });

  test("exposes exactly the five approved tools and rejects arbitrary discovery or execution", async () => {
    expect(ALLOWED_KOREAN_LAW_TOOLS).toEqual([
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
    const discover = await adapter.execute("discover_tools", {});
    const arbitrary = await adapter.execute("read_file", { path: "/etc/passwd" });

    expect(discover).toEqual({
      ok: false,
      error: { code: "tool_not_allowed", tool: "discover_tools" },
    });
    expect(arbitrary).toEqual({
      ok: false,
      error: { code: "tool_not_allowed", tool: "read_file" },
    });
    expect(launches).toBe(0);
    expect(fake.calls).toHaveLength(0);
  });

  test("preserves citation provenance and adds a digest of the complete MCP result", async () => {
    const rawResult = {
      content: [{ type: "text", text: "민법 제1조: 법원" }],
      structuredContent: {
        citations: [
          {
            source_url: "https://www.law.go.kr/법령/민법/제1조",
            law: "민법",
            version_date: "2025-01-31",
            retrieval_time: "2026-08-11T09:30:00.000Z",
          },
        ],
      },
    };
    const expectedDigest = createHash("sha256").update(JSON.stringify(rawResult)).digest("hex");
    const fake = fakeClient(rawResult);
    const adapter = createKoreanLawMcpAdapter({
      lawOc: "configured",
      clientFactory: () => fake.client,
      transportFactory: () => ({}),
      now: () => new Date("2099-01-01T00:00:00.000Z"),
    });

    const result = await adapter.execute("get_law_text", { mst: "12345" });

    expect(result).toEqual({
      ok: true,
      value: {
        content: rawResult.content,
        structuredContent: rawResult.structuredContent,
        citations: [
          {
            sourceUrl: "https://www.law.go.kr/법령/민법/제1조",
            law: "민법",
            versionDate: "2025-01-31",
            retrievedAt: "2026-08-11T09:30:00.000Z",
            toolName: "get_law_text",
            resultDigest: expectedDigest,
          },
        ],
      },
    });
    expect(fake.calls).toEqual([{ name: "get_law_text", arguments: { mst: "12345" } }]);
  });

  test("derives an official citation from a text-only law response", async () => {
    const rawResult = {
      content: [
        {
          type: "text",
          text: "법령명: 민사소송법\nMST: 252393\n시행일: 20250712\n제1조 목적",
        },
      ],
    };
    const fake = fakeClient(rawResult);
    const adapter = createKoreanLawMcpAdapter({
      lawOc: "not-a-real-secret",
      clientFactory: () => fake.client,
      transportFactory: () => ({}) as never,
      now: () => new Date("2026-08-11T09:30:00.000Z"),
    });

    const result = await adapter.execute("get_law_text", { mst: "252393" });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected text-only law response to succeed");
    expect(result.value.citations).toEqual([
      {
        sourceUrl: "https://www.law.go.kr/법령/민사소송법",
        law: "민사소송법",
        versionDate: "2025-07-12",
        retrievedAt: "2026-08-11T09:30:00.000Z",
        toolName: "get_law_text",
        resultDigest: createHash("sha256").update(JSON.stringify(rawResult)).digest("hex"),
      },
    ]);
  });
});
