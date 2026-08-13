import { describe, expect, test } from "bun:test";
import { AGENT_DECISION_OUTPUT_SCHEMA, parseAgentDecision } from "./agent-decision-contracts";
import type {
  ApprovedAgentDecisionContext,
  CodexAppServerConnection,
  CodexAppServerRequest,
} from "./agent-provider";
import { createCodexAgentProvider } from "./agent-provider";

class RecordingConnection implements CodexAppServerConnection {
  readonly requests: CodexAppServerRequest[] = [];

  async request(request: CodexAppServerRequest): Promise<unknown> {
    this.requests.push(request);
    if (request.method === "account/read") {
      return { account: { type: "chatgpt", email: null, planType: "plus" } };
    }
    return {};
  }

  notify(): void {}
  onNotification(): () => void {
    return () => undefined;
  }
  async close(): Promise<void> {}
}

const context = (text: string) =>
  ({
    approval: "user-approved",
    contextDigest: "a".repeat(64),
    goal: { kind: "civil-recovery", caseId: "case-1", objective: "prepare-civil-demand" },
    maskedFacts: [{ id: "fact-raw", text }],
    citationIds: [],
    observations: [],
  }) as unknown as ApprovedAgentDecisionContext;

function requiresEveryProperty(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(requiresEveryProperty);
  if (typeof value !== "object" || value === null) return true;
  const record = value as Record<string, unknown>;
  const properties = record.properties;
  if (typeof properties === "object" && properties !== null && !Array.isArray(properties)) {
    const required = record.required;
    if (
      !Array.isArray(required) ||
      JSON.stringify([...required].sort()) !== JSON.stringify(Object.keys(properties).sort())
    ) {
      return false;
    }
  }
  return Object.values(record).every(requiresEveryProperty);
}

describe("Codex provider privacy boundary", () => {
  test("uses the provider-supported closed decision schema", () => {
    const serialized = JSON.stringify(AGENT_DECISION_OUTPUT_SCHEMA);
    expect(serialized).not.toContain('"oneOf"');
    expect(serialized).toContain('"anyOf"');
    expect(requiresEveryProperty(AGENT_DECISION_OUTPUT_SCHEMA)).toBe(true);
  });

  test("accepts nullable provider optional fields after local normalization", () => {
    expect(
      parseAgentDecision(
        JSON.stringify({
          kind: "tool",
          decisionId: "decision-1",
          toolCall: {
            toolName: "search-official-law",
            toolCallId: "tool-1",
            query: "지급명령",
            basisObservationDigest: null,
          },
          approval: null,
          outcome: null,
        }),
        context("마스킹된 사실"),
      ),
    ).toMatchObject({ kind: "tool", toolCall: { toolName: "search-official-law" } });
  });

  test.each([
    "900101-1234567",
    "010-1234-5678",
    "서울특별시 종로구 세종대로 209",
    "110-123-456789",
    "2024가단123456",
    "claimant@example.com",
    "sender: 홍길동",
  ])("rejects raw identifier %p before creating an outbound thread", async (identifier) => {
    const connection = new RecordingConnection();
    const provider = await createCodexAgentProvider(async () => ({
      status: "ready",
      connection,
    }));

    await expect(provider.nextDecision(context(identifier))).rejects.toThrow("masked");
    expect(connection.requests.some((request) => request.method === "thread/start")).toBe(false);
    await provider.dispose();
  });
});
