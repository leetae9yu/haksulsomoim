import { type IpcMainInvokeEvent, ipcMain, shell } from "electron";
import { IPC_CHANNELS } from "../contracts/ipc-channels";
import {
  createOpenOfficialSourceHandler,
  createOpenTrustedAuthenticationHandler,
  type DesktopHandlers,
} from "./ipc-handlers";
import { isTrustedRendererUrl } from "./security";

function assertTrustedSender(event: IpcMainInvokeEvent): void {
  const url = event.senderFrame?.url;
  if (url === undefined || !isTrustedRendererUrl(url)) {
    throw new Error("Rejected IPC invocation from an untrusted renderer");
  }
}

export function registerDesktopIpc(handlers: DesktopHandlers): () => void {
  const openExternal = (url: string) => shell.openExternal(url);
  const openOfficialSource = createOpenOfficialSourceHandler(openExternal);
  const openTrustedAuthentication = createOpenTrustedAuthenticationHandler(openExternal);
  const registrations = [
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
  ] as const;

  for (const [channel, handler] of registrations) {
    ipcMain.handle(channel, async (event, request: unknown) => {
      assertTrustedSender(event);
      return await handler(request);
    });
  }

  return () => {
    for (const [channel] of registrations) ipcMain.removeHandler(channel);
  };
}
