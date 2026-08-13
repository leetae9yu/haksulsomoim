import { describe, expect, test } from "bun:test";
import { AGENT_DECISION_OUTPUT_SCHEMA } from "./agent-decision-contracts";
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

describe("Codex provider privacy boundary", () => {
  test("uses the provider-supported closed decision schema", () => {
    const serialized = JSON.stringify(AGENT_DECISION_OUTPUT_SCHEMA);
    expect(serialized).not.toContain('"oneOf"');
    expect(serialized).toContain('"anyOf"');
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
