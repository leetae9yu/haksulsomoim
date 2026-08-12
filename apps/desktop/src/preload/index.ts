import { contextBridge, ipcRenderer } from "electron";
import type { DesktopApi } from "../contracts/desktop-api";
import { IPC_CHANNELS } from "../contracts/ipc-channels";

const invoke = <T>(channel: string, request: unknown): Promise<T> =>
  ipcRenderer.invoke(channel, request) as Promise<T>;

let activeCaseId: string | undefined;

const api: Required<DesktopApi> = Object.freeze({
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
    if (caseId === undefined)
      return Promise.reject(new Error("Create a case before adding evidence"));
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
  codexSuggestion: (request) => invoke(IPC_CHANNELS.codexSuggestion, request),
});

contextBridge.exposeInMainWorld("haksul", api);
