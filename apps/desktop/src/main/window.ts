import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserWindow, session } from "electron";
import { secureWebPreferences } from "./security";

export function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: "#f5f5f7",
    title: "소액사기 사건 코파일럿",
    webPreferences: secureWebPreferences(
      join(dirname(fileURLToPath(import.meta.url)), "../preload/index.cjs"),
    ),
  });

  window.removeMenu();
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.on("will-redirect", (event) => event.preventDefault());
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  session.defaultSession.setPermissionCheckHandler(() => false);
  window.once("ready-to-show", () => window.show());
  void window.loadURL("app://bundle/index.html");
  return window;
}
