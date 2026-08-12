import { dirname, join, normalize, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { app, BrowserWindow, net, protocol } from "electron";
import { registerDesktopIpc } from "./ipc-register";
import { createBeforeQuitHandler } from "./lifecycle";
import { createDesktopRuntime, type DesktopRuntime } from "./runtime";
import { createMainWindow } from "./window";

export type DesktopRuntimeFactory = (userDataPath: string) => Promise<DesktopRuntime>;

protocol.registerSchemesAsPrivileged([
  {
    scheme: "app",
    privileges: {
      secure: true,
      standard: true,
      supportFetchAPI: true,
      corsEnabled: false,
    },
  },
]);

const rendererRoot = join(dirname(fileURLToPath(import.meta.url)), "../renderer");

export async function bootstrapDesktop(
  createRuntime: DesktopRuntimeFactory = createDesktopRuntime,
): Promise<void> {
  await app.whenReady();
  protocol.handle("app", (request) => {
    const url = new URL(request.url);
    if (url.hostname !== "bundle") return new Response("Not found", { status: 404 });
    const relativePath = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
    const filePath = normalize(join(rendererRoot, relativePath));
    if (!filePath.startsWith(`${rendererRoot}${sep}`)) {
      return new Response("Not found", { status: 404 });
    }
    return net.fetch(pathToFileURL(filePath).href);
  });

  const runtime = await createRuntime(app.getPath("userData"));
  const unregisterIpc = registerDesktopIpc(runtime.handlers);
  createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
  app.on("window-all-closed", () => app.quit());
  app.on(
    "before-quit",
    createBeforeQuitHandler({
      dispose: () => runtime.dispose(),
      unregisterIpc,
      quit: () => app.quit(),
      reportError: (error) => console.error("Failed to dispose desktop runtime", error),
    }),
  );
}

export function reportBootstrapFailure(error: unknown): void {
  console.error(error);
  app.exit(1);
}
