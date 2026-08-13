import { describe, expect, mock, test } from "bun:test";
import {
  createAgentLifecycleHandlers,
  createDesktopHandlers,
  createOpenOfficialSourceHandler,
  createOpenTrustedAuthenticationHandler,
} from "./ipc-handlers";
import type { CaseRuntimeService } from "./runtime-case-service";

function serviceFixture() {
  const service = {
    createCase: mock(async () => ({
      status: "accepted" as const,
      caseId: "case-1",
      amountKrw: 100_000,
      criminalState: "evidence-review" as const,
      civilState: "pre-filing" as const,
    })),
    analyzeEvidence: mock(async () => ({
      status: "unreadable" as const,
      evidenceId: "evidence-1",
      sha256: "a".repeat(64),
      reason: "no-text-detected",
      needsManualConfirmation: true as const,
    })),
    confirmOcrFacts: mock(async () => ({ status: "not-allowed" as const, reason: "test" })),
    advanceCriminal: mock(async () => ({ status: "not-allowed" as const, reason: "test" })),
    advanceCivil: mock(async () => ({ status: "not-allowed" as const, reason: "test" })),
    enforcementChoices: mock(async () => ({ status: "not-allowed" as const, reason: "test" })),
    guidance: mock(async () => ({
      status: "needs-credentials" as const,
      credential: "LAW_OC" as const,
    })),
    codexStatus: mock(async () => ({
      status: "sign-in-required" as const,
      action: "sign-in-with-chatgpt" as const,
    })),
    codexLogin: mock(async () => ({
      loginId: "login",
      authorizationUrl: "https://auth.openai.com/",
    })),
    suggest: mock(async () => ({ text: "suggestion", citationIds: [] })),
  };
  return { handlers: createDesktopHandlers(service as unknown as CaseRuntimeService), service };
}

const digest = "a".repeat(64);
const projection = {
  caseId: "case-1",
  runId: "run-1",
  goal: {
    kind: "civil-recovery" as const,
    caseId: "case-1",
    objective: "prepare-civil-demand" as const,
  },
  budget: { decisionsRemaining: 10, toolsRemaining: 7, durationMsRemaining: 200_000 },
  state: { kind: "paused" as const, reason: "approval-required" as const },
  lastStepId: "step-1",
  pendingApproval: {
    approvalId: "approval-1",
    approvalDigest: digest,
    contextDigest: digest,
    action: "review-draft" as const,
  },
  steps: [
    { kind: "approval-requested" as const, stepId: "step-1", action: "review-draft" as const },
  ],
  citations: [],
};

function agentServiceFixture() {
  const service = {
    start: mock(async () => projection),
    get: mock(async () => projection),
    list: mock(async () => [projection]),
    pause: mock(async () => projection),
    resume: mock(async () => projection),
    cancel: mock(async () => projection),
    decideApproval: mock(
      async (): Promise<Readonly<{ status: "recorded" | "stale"; run: unknown }>> => ({
        status: "recorded",
        run: projection,
      }),
    ),
    subscribe: mock((_request: unknown, _listener: (event: unknown) => void) => () => undefined),
  };
  return { handlers: createAgentLifecycleHandlers(service), service };
}

describe("desktop IPC handlers", () => {
  test("routes the complete agent lifecycle through typed case-bound requests", async () => {
    const { handlers, service } = agentServiceFixture();
    const binding = { caseId: "case-1", runId: "run-1", contextDigest: digest };
    await handlers.startAgentRun({
      caseId: "case-1",
      goal: projection.goal,
      contextDigest: digest,
    });
    expect(service.start).toHaveBeenCalledWith({
      caseId: "case-1",
      goal: projection.goal,
      approvedContextDigest: digest,
    });
    await handlers.getAgentRun(binding);
    await handlers.listAgentRuns({ caseId: "case-1" });
    await handlers.pauseAgentRun(binding);
    await handlers.resumeAgentRun({ ...binding, userInput: "confirmed fact" });
    await handlers.cancelAgentRun(binding);
    await handlers.decideAgentApproval({
      ...binding,
      approvalId: "approval-1",
      approvalDigest: digest,
      outcome: "approved",
    });
    expect(service.get).toHaveBeenCalledWith(binding);
    expect(service.resume).toHaveBeenCalledWith({ ...binding, userInput: "confirmed fact" });
    expect(service.decideApproval).toHaveBeenCalledWith({
      ...binding,
      approvalId: "approval-1",
      approvalDigest: digest,
      outcome: "approved",
    });
    const listener = mock(() => undefined);
    handlers.subscribeAgentRun(binding, listener);
    const publish = service.subscribe.mock.calls[0]?.[1];
    publish?.({ caseId: "case-1", runId: "run-1", projection });
    expect(listener).toHaveBeenCalledWith({ caseId: "case-1", runId: "run-1", projection });
  });

  test("rejects duplicate Agent list identities before returning a renderer result", async () => {
    const { handlers, service } = agentServiceFixture();
    service.list.mockImplementation(async () => [projection, projection]);
    const duplicate = handlers.listAgentRuns({ caseId: "case-1" });
    await expect(duplicate).rejects.toThrow("Duplicate Agent run identity");
    const error = await duplicate.catch((reason: unknown) => reason);
    const message = String(error);
    expect(message.length).toBeLessThan(500);
    expect(message).not.toContain("case-1");
    expect(message).not.toContain("run-1");
    service.list.mockImplementation(async () => [projection, { ...projection, runId: "run-2" }]);
    await expect(handlers.listAgentRuns({ caseId: "case-1" })).resolves.toHaveLength(2);
  });

  test("rejects stale approvals and renderer-supplied tool execution", async () => {
    const { handlers, service } = agentServiceFixture();
    service.decideApproval.mockImplementation(async () => ({
      status: "stale" as const,
      run: projection,
    }));
    const approval = {
      caseId: "case-1",
      runId: "run-1",
      contextDigest: digest,
      approvalId: "approval-1",
      approvalDigest: digest,
      outcome: "approved",
    } as const;
    await expect(handlers.decideAgentApproval(approval)).rejects.toThrow("stale");
    await expect(
      handlers.decideAgentApproval({
        ...approval,
        toolResult: { toolName: "write-local-draft", outcome: "completed" },
      }),
    ).rejects.toThrow();
    await expect(
      handlers.startAgentRun({
        caseId: "case-1",
        goal: projection.goal,
        contextDigest: digest,
        maskedFacts: [{ id: "forged", text: "renderer supplied" }],
      }),
    ).rejects.toThrow();
    expect(service.start).not.toHaveBeenCalled();
  });
  test("requires a case ID and strips byte arrays into the main runtime type", async () => {
    const { handlers, service } = serviceFixture();
    await expect(
      handlers.analyzeEvidence({ filename: "x.png", mimeType: "image/png", bytes: [1] }),
    ).rejects.toThrow();
    await handlers.analyzeEvidence({
      caseId: "case-1",
      filename: "x.png",
      mimeType: "image/png",
      bytes: [1, 2],
    });
    expect(service.analyzeEvidence).toHaveBeenCalledWith({
      caseId: "case-1",
      filename: "x.png",
      mimeType: "image/png",
      bytes: Uint8Array.from([1, 2]),
    });
  });

  test("rejects renderer-supplied masked facts and unknown fields on every boundary", async () => {
    const { handlers, service } = serviceFixture();
    await expect(
      handlers.codexSuggestion({
        caseId: "case-1",
        approval: "user-approved",
        citationIds: ["cite-1"],
        maskedFacts: [{ id: "forged", text: "renderer supplied" }],
      }),
    ).rejects.toThrow();
    expect(service.suggest).not.toHaveBeenCalled();
    await expect(handlers.codexStatus({ unexpected: true })).rejects.toThrow();
  });

  test("opens only validated official sources through the main process", async () => {
    const openExternal = mock(async (_url: string) => undefined);
    const openOfficialSource = createOpenOfficialSourceHandler(openExternal);

    await openOfficialSource({ url: "https://law.go.kr/법령/민법" });
    await openOfficialSource({ url: "https://www.law.go.kr/법령/민법" });
    expect(openExternal).toHaveBeenNthCalledWith(1, "https://law.go.kr/법령/민법");
    expect(openExternal).toHaveBeenNthCalledWith(2, "https://www.law.go.kr/법령/민법");

    await expect(openOfficialSource({ url: "https://law.go.kr.evil.example/" })).rejects.toThrow();
    expect(openExternal).toHaveBeenCalledTimes(2);
  });

  test("opens authentication separately and only on the exact trusted origin", async () => {
    const openExternal = mock(async (_url: string) => undefined);
    const openAuthentication = createOpenTrustedAuthenticationHandler(openExternal);

    await openAuthentication({ url: "https://auth.openai.com/oauth/authorize?state=opaque" });
    expect(openExternal).toHaveBeenCalledWith(
      "https://auth.openai.com/oauth/authorize?state=opaque",
    );

    await expect(
      openAuthentication({ url: "https://auth.openai.com.evil.example/oauth/authorize" }),
    ).rejects.toThrow();
    expect(openExternal).toHaveBeenCalledTimes(1);
  });

  test("routes typed workflow and provider requests", async () => {
    const { handlers, service } = serviceFixture();
    await handlers.advanceCivil({
      caseId: "case-1",
      command: "attest-finality",
      userAttested: true,
    });
    expect(service.advanceCivil).toHaveBeenCalledWith("case-1", "attest-finality", true);
    expect(await handlers.guidance({ caseId: "case-1", query: "민법" })).toEqual({
      status: "needs-credentials",
      credential: "LAW_OC",
    });
    expect(service.guidance).toHaveBeenCalledWith("case-1", "민법");
    expect(await handlers.codexStatus({})).toEqual({
      status: "sign-in-required",
      action: "sign-in-with-chatgpt",
    });
  });
});
