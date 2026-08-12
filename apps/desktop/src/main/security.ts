import type { WebPreferences } from "electron";

export function secureWebPreferences(preload: string): WebPreferences {
  return {
    contextIsolation: true,
    nodeIntegration: false,
    preload,
    sandbox: true,
    webSecurity: true,
  };
}

export function isTrustedRendererUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "app:" &&
      url.hostname === "bundle" &&
      url.username === "" &&
      url.password === "" &&
      url.port === ""
    );
  } catch {
    return false;
  }
}
