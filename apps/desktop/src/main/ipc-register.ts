import electron from "electron";
import { IPC_CHANNELS } from "../contracts/ipc-channels";
import {
  agentRunEventSchema,
  agentRunSubscriptionControlSchema,
} from "./agent/agent-ipc-contracts";
import {
  createOpenOfficialSourceHandler,
  createOpenTrustedAuthenticationHandler,
  type DesktopHandlers,
} from "./ipc-handlers";
import { isTrustedRendererUrl } from "./security";

type InvokeEvent = Readonly<{ senderFrame?: Readonly<{ url: string }> | null }>;
type Sender = Readonly<{
  send(channel: string, payload: unknown): void;
  once?(event: "destroyed", listener: () => void): void;
}>;
type Event = InvokeEvent & Readonly<{ sender: Sender }>;
type InvokeHandler = (event: InvokeEvent, request: unknown) => Promise<unknown>;
type EventHandler = (event: Event, request: unknown) => void;

interface IpcMainPort {
  handle(channel: string, handler: InvokeHandler): void;
  on(channel: string, handler: EventHandler): void;
  removeHandler(channel: string): void;
  removeListener(channel: string, handler: EventHandler): void;
}

function assertTrustedSender(event: InvokeEvent): void {
  const url = event.senderFrame?.url;
  if (url === undefined || !isTrustedRendererUrl(url)) {
    throw new Error("Rejected IPC invocation from an untrusted renderer");
  }
}

export interface IpcRegistrationDependencies {
  readonly ipcMain: IpcMainPort;
  readonly openExternal: (url: string) => Promise<unknown>;
}

function subscriptionControl(request: unknown) {
  if (typeof request !== "object" || request === null || "action" in request) {
    return agentRunSubscriptionControlSchema.parse(request);
  }
  return agentRunSubscriptionControlSchema.parse({ ...request, action: "subscribe" });
}

export function registerDesktopIpcWith(
  handlers: DesktopHandlers,
  dependencies: IpcRegistrationDependencies,
): () => void {
  const openOfficialSource = createOpenOfficialSourceHandler(async (url) => {
    await dependencies.openExternal(url);
  });
  const openTrustedAuthentication = createOpenTrustedAuthenticationHandler(async (url) => {
    await dependencies.openExternal(url);
  });
  const registrations: readonly (readonly [
    string,
    ((request: unknown) => Promise<unknown>) | undefined,
  ])[] = [
    [IPC_CHANNELS.createCase, handlers.createCase],
    [IPC_CHANNELS.analyzeEvidence, handlers.analyzeEvidence],
    [IPC_CHANNELS.confirmOcrFacts, handlers.confirmOcrFacts],
    [IPC_CHANNELS.advanceCriminal, handlers.advanceCriminal],
    [IPC_CHANNELS.advanceCivil, handlers.advanceCivil],
    [IPC_CHANNELS.enforcementChoices, handlers.enforcementChoices],
    [IPC_CHANNELS.guidance, handlers.guidance],
    [IPC_CHANNELS.openOfficialSource, openOfficialSource],
    [IPC_CHANNELS.openTrustedAuthentication, openTrustedAuthentication],
    [IPC_CHANNELS.codexStatus, handlers.codexStatus],
    [IPC_CHANNELS.codexLogin, handlers.codexLogin],
    [IPC_CHANNELS.codexSuggestion, handlers.codexSuggestion],
    [IPC_CHANNELS.agentRunStart, handlers.startAgentRun],
    [IPC_CHANNELS.agentRunGet, handlers.getAgentRun],
    [IPC_CHANNELS.agentRunList, handlers.listAgentRuns],
    [IPC_CHANNELS.agentRunPause, handlers.pauseAgentRun],
    [IPC_CHANNELS.agentRunResume, handlers.resumeAgentRun],
    [IPC_CHANNELS.agentRunCancel, handlers.cancelAgentRun],
    [IPC_CHANNELS.agentApprovalDecision, handlers.decideAgentApproval],
  ];
  const registered: string[] = [];
  try {
    for (const [channel, handler] of registrations) {
      if (handler === undefined) continue;
      dependencies.ipcMain.handle(channel, async (event, request) => {
        assertTrustedSender(event);
        return await handler(request);
      });
      registered.push(channel);
    }
  } catch (error) {
    for (const channel of registered) dependencies.ipcMain.removeHandler(channel);
    throw error;
  }

  const subscriptions = new Map<Sender, Map<string, () => void>>();
  const clear = (sender: Sender, key: string) => {
    const senderSubscriptions = subscriptions.get(sender);
    senderSubscriptions?.get(key)?.();
    senderSubscriptions?.delete(key);
    if (senderSubscriptions?.size === 0) subscriptions.delete(sender);
  };
  const subscribe: EventHandler = (event, request) => {
    assertTrustedSender(event);
    const control = subscriptionControl(request);
    const key = `${control.caseId}\0${control.runId}`;
    clear(event.sender, key);
    if (control.action === "unsubscribe") return;
    if (handlers.subscribeAgentRun === undefined) {
      throw new Error("Agent lifecycle is unavailable");
    }
    let active = true;
    const binding = {
      caseId: control.caseId,
      runId: control.runId,
      contextDigest: control.contextDigest,
    };
    const dispose = handlers.subscribeAgentRun(binding, (value) => {
      if (!active || value.caseId !== control.caseId || value.runId !== control.runId) return;
      const parsed = agentRunEventSchema.parse(value);
      event.sender.send(IPC_CHANNELS.agentRunEvent, parsed);
    });
    const cleanup = () => {
      if (!active) return;
      active = false;
      dispose();
    };
    const senderSubscriptions = subscriptions.get(event.sender) ?? new Map<string, () => void>();
    senderSubscriptions.set(key, cleanup);
    subscriptions.set(event.sender, senderSubscriptions);
    event.sender.once?.("destroyed", () => clear(event.sender, key));
  };
  dependencies.ipcMain.on(IPC_CHANNELS.agentRunSubscribe, subscribe);

  return () => {
    for (const channel of registered) dependencies.ipcMain.removeHandler(channel);
    dependencies.ipcMain.removeListener(IPC_CHANNELS.agentRunSubscribe, subscribe);
    for (const senderSubscriptions of subscriptions.values()) {
      for (const cleanup of senderSubscriptions.values()) cleanup();
    }
    subscriptions.clear();
  };
}

const electronApi = electron as unknown as {
  ipcMain: IpcMainPort;
  shell: Readonly<{ openExternal(url: string): Promise<unknown> }>;
};

export function registerDesktopIpc(handlers: DesktopHandlers): () => void {
  return registerDesktopIpcWith(handlers, {
    ipcMain: electronApi.ipcMain,
    openExternal: (url) => electronApi.shell.openExternal(url),
  });
}
