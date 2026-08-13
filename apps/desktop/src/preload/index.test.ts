import { describe, expect, mock, test } from "bun:test";
import { IPC_CHANNELS } from "../contracts/ipc-channels";
import { createDesktopPreloadApi } from "./index";

const digest = "a".repeat(64);

describe("desktop preload bridge", () => {
  test("opens only the strict masked-case digest projection", async () => {
    const invoke = mock(async () => ({ caseId: "case-1", contextDigest: digest }));
    const ipc = {
      invoke,
      send: mock(() => undefined),
      on: mock(() => undefined),
      removeListener: mock(() => undefined),
    };
    const api = createDesktopPreloadApi(ipc);

    await expect(api.openAgentCase({ caseId: "case-1" })).resolves.toEqual({
      caseId: "case-1",
      contextDigest: digest,
    });
    expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.agentCaseOpen, { caseId: "case-1" });
    invoke.mockImplementation(async () => ({
      caseId: "case-1",
      contextDigest: digest,
      rawEvidence: "forbidden",
    }));
    await expect(api.openAgentCase({ caseId: "case-1" })).rejects.toThrow();
  });

  test("exposes narrow lifecycle invokes without exposing raw ipcRenderer", async () => {
    const invoke = mock(async (_channel: string, _request: unknown) => ({
      caseId: "case-1",
      runId: "run-1",
      goal: {
        kind: "civil-recovery",
        caseId: "case-1",
        objective: "prepare-civil-demand",
      },
      budget: { decisionsRemaining: 12, toolsRemaining: 8, durationMsRemaining: 300_000 },
      state: { kind: "active" },
      lastStepId: null,
      pendingApproval: null,
      steps: [],
      citations: [],
    }));
    const ipc = {
      invoke,
      send: mock(() => undefined),
      on: mock(() => undefined),
      removeListener: mock(() => undefined),
    };
    const api = createDesktopPreloadApi(ipc);
    const request = {
      caseId: "case-1",
      goal: { kind: "civil-recovery", caseId: "case-1", objective: "prepare-civil-demand" },
      contextDigest: digest,
    } as const;
    await api.startAgentRun(request);
    expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.agentRunStart, request);
    expect("ipcRenderer" in api).toBe(false);
    expect(Object.isFrozen(api)).toBe(true);
  });

  test("subscribes with cleanup and ignores late or mismatched events", () => {
    let receive: ((_event: unknown, payload: unknown) => void) | undefined;
    const ipc = {
      invoke: mock(async () => ({})),
      send: mock(() => undefined),
      on: mock((_channel: string, listener: typeof receive) => {
        receive = listener;
      }),
      removeListener: mock(() => undefined),
    };
    const api = createDesktopPreloadApi(ipc);
    const listener = mock((_event: unknown) => undefined);
    const request = { caseId: "case-1", runId: "run-1", contextDigest: digest } as const;
    const cleanup = api.subscribeAgentRun(request, listener);
    receive?.({}, { caseId: "case-2", runId: "run-1", projection: {} });
    expect(listener).not.toHaveBeenCalled();
    cleanup();
    receive?.({}, { caseId: "case-1", runId: "run-1", projection: {} });
    expect(listener).not.toHaveBeenCalled();
    expect(ipc.removeListener).toHaveBeenCalledWith(IPC_CHANNELS.agentRunEvent, receive);
    expect(ipc.send).toHaveBeenLastCalledWith(IPC_CHANNELS.agentRunSubscribe, {
      ...request,
      action: "unsubscribe",
    });
  });
});
