import { describe, expect, mock, test } from "bun:test";
import { IPC_CHANNELS } from "../contracts/ipc-channels";
import { registerDesktopIpcWith } from "./ipc-register";

const trusted = { senderFrame: { url: "app://bundle/index.html" }, sender: {} };

function fixture() {
  const invokes = new Map<string, (event: unknown, request: unknown) => Promise<unknown>>();
  const listeners = new Map<string, (event: unknown, request: unknown) => void>();
  const ipc = {
    handle: mock(
      (channel: string, handler: typeof invokes extends Map<string, infer T> ? T : never) => {
        if (invokes.has(channel)) throw new Error("duplicate handler");
        invokes.set(channel, handler);
      },
    ),
    on: mock(
      (channel: string, listener: typeof listeners extends Map<string, infer T> ? T : never) => {
        if (listeners.has(channel)) throw new Error("duplicate listener");
        listeners.set(channel, listener);
      },
    ),
    removeHandler: mock((channel: string) => invokes.delete(channel)),
    removeListener: mock((channel: string) => listeners.delete(channel)),
  };
  const handlers = new Proxy(
    {
      subscribeAgentRun: mock(
        (_request: unknown, _listener: (event: unknown) => void) => () => undefined,
      ),
    },
    { get: (target, property) => Reflect.get(target, property) ?? mock(async () => ({})) },
  );
  return { ipc, invokes, listeners, handlers };
}

describe("desktop IPC registration", () => {
  test("rejects untrusted senders and duplicate handler registration", async () => {
    const { ipc, invokes, handlers } = fixture();
    const dispose = registerDesktopIpcWith(handlers as never, {
      ipcMain: ipc as never,
      openExternal: mock(async () => undefined),
    });
    const start = invokes.get(IPC_CHANNELS.agentRunStart);
    expect(invokes.get(IPC_CHANNELS.agentCaseOpen)).toBeDefined();
    expect(ipc.handle).toHaveBeenCalledTimes(20);
    expect(start).toBeDefined();
    await expect(start?.({ senderFrame: { url: "https://evil.example" } }, {})).rejects.toThrow(
      "untrusted renderer",
    );
    expect(() =>
      registerDesktopIpcWith(handlers as never, {
        ipcMain: ipc as never,
        openExternal: mock(async () => undefined),
      }),
    ).toThrow("duplicate");
    dispose();
  });

  test("cleans subscriptions and drops late or mismatched case-run events", () => {
    const { ipc, listeners, handlers } = fixture();
    const send = mock((_channel: string, _event: unknown) => undefined);
    const sender = { send, once: mock((_name: string, _listener: () => void) => undefined) };
    let publish: ((event: unknown) => void) | undefined;
    const unsubscribe = mock(() => undefined);
    handlers.subscribeAgentRun.mockImplementation((_request, listener) => {
      publish = listener;
      return unsubscribe;
    });
    const dispose = registerDesktopIpcWith(handlers as never, {
      ipcMain: ipc as never,
      openExternal: mock(async () => undefined),
    });
    const subscribe = listeners.get(IPC_CHANNELS.agentRunSubscribe);
    const request = { caseId: "case-1", runId: "run-1", contextDigest: "a".repeat(64) };
    subscribe?.({ ...trusted, sender }, request);
    publish?.({ caseId: "case-2", runId: "run-1", projection: {} });
    expect(send).not.toHaveBeenCalled();
    subscribe?.({ ...trusted, sender }, { ...request, action: "unsubscribe" });
    publish?.({ caseId: "case-1", runId: "run-1", projection: {} });
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
    dispose();
  });
});
