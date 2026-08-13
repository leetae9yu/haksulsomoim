import electron from "electron";
import {
  type AgentRunEvent,
  type AgentRunProjection,
  agentArtifactViewSchema,
  agentCaseContextSchema,
  agentRunEventSchema,
  agentRunListResponseSchema,
  agentRunProjectionSchema,
  type DesktopApi,
} from "../contracts/desktop-api";
import { IPC_CHANNELS } from "../contracts/ipc-channels";

export interface PreloadIpcPort {
  invoke(channel: string, request: unknown): Promise<unknown>;
  send(channel: string, request: unknown): void;
  on(channel: string, listener: (event: unknown, payload: unknown) => void): void;
  removeListener(channel: string, listener: (event: unknown, payload: unknown) => void): void;
}

const projection = (value: unknown): AgentRunProjection => agentRunProjectionSchema.parse(value);

export function createDesktopPreloadApi(ipc: PreloadIpcPort): Required<DesktopApi> {
  const invoke = <T>(channel: string, request: unknown): Promise<T> =>
    ipc.invoke(channel, request) as Promise<T>;
  let activeCaseId: string | undefined;
  return Object.freeze({
    async createCase(request) {
      const response = await invoke<Awaited<ReturnType<DesktopApi["createCase"]>>>(
        IPC_CHANNELS.createCase,
        request,
      );
      if (response.status === "accepted") activeCaseId = response.caseId;
      return response;
    },
    analyzeEvidence(request) {
      const caseId = request.caseId ?? activeCaseId;
      if (caseId === undefined) {
        return Promise.reject(new Error("Create a case before adding evidence"));
      }
      return invoke(IPC_CHANNELS.analyzeEvidence, { ...request, caseId });
    },
    confirmOcrFacts: (request) => invoke(IPC_CHANNELS.confirmOcrFacts, request),
    advanceCriminal: (request) => invoke(IPC_CHANNELS.advanceCriminal, request),
    advanceCivil: (request) => invoke(IPC_CHANNELS.advanceCivil, request),
    enforcementChoices: (request) => invoke(IPC_CHANNELS.enforcementChoices, request),
    guidance: (request) => invoke(IPC_CHANNELS.guidance, request),
    openOfficialSource: (request) => invoke(IPC_CHANNELS.openOfficialSource, request),
    openTrustedAuthentication: (request) => invoke(IPC_CHANNELS.openTrustedAuthentication, request),
    codexStatus: (request) => invoke(IPC_CHANNELS.codexStatus, request),
    codexLogin: (request) => invoke(IPC_CHANNELS.codexLogin, request),
    async openAgentCase(request) {
      return agentCaseContextSchema.parse(await ipc.invoke(IPC_CHANNELS.agentCaseOpen, request));
    },
    async openAgentArtifact(request) {
      return agentArtifactViewSchema.parse(
        await ipc.invoke(IPC_CHANNELS.agentArtifactOpen, request),
      );
    },
    async startAgentRun(request) {
      return projection(await ipc.invoke(IPC_CHANNELS.agentRunStart, request));
    },
    async getAgentRun(request) {
      return projection(await ipc.invoke(IPC_CHANNELS.agentRunGet, request));
    },
    async listAgentRuns(request) {
      return agentRunListResponseSchema.parse(await ipc.invoke(IPC_CHANNELS.agentRunList, request));
    },
    async pauseAgentRun(request) {
      return projection(await ipc.invoke(IPC_CHANNELS.agentRunPause, request));
    },
    async resumeAgentRun(request) {
      return projection(await ipc.invoke(IPC_CHANNELS.agentRunResume, request));
    },
    async cancelAgentRun(request) {
      return projection(await ipc.invoke(IPC_CHANNELS.agentRunCancel, request));
    },
    async decideAgentApproval(request) {
      return projection(await ipc.invoke(IPC_CHANNELS.agentApprovalDecision, request));
    },
    subscribeAgentRun(request, listener) {
      let active = true;
      const receive = (_event: unknown, payload: unknown) => {
        if (!active || typeof payload !== "object" || payload === null) return;
        const candidate = payload as Readonly<{ caseId?: unknown; runId?: unknown }>;
        if (candidate.caseId !== request.caseId || candidate.runId !== request.runId) return;
        const event: AgentRunEvent = agentRunEventSchema.parse(payload);
        listener(event);
      };
      ipc.on(IPC_CHANNELS.agentRunEvent, receive);
      ipc.send(IPC_CHANNELS.agentRunSubscribe, { ...request, action: "subscribe" });
      return () => {
        if (!active) return;
        active = false;
        ipc.removeListener(IPC_CHANNELS.agentRunEvent, receive);
        ipc.send(IPC_CHANNELS.agentRunSubscribe, { ...request, action: "unsubscribe" });
      };
    },
  });
}

const electronApi = electron as unknown as Readonly<{
  contextBridge?: Readonly<{ exposeInMainWorld(name: string, api: unknown): void }>;
  ipcRenderer?: PreloadIpcPort;
}>;

if (electronApi.contextBridge !== undefined && electronApi.ipcRenderer !== undefined) {
  electronApi.contextBridge.exposeInMainWorld(
    "haksul",
    createDesktopPreloadApi(electronApi.ipcRenderer),
  );
}
