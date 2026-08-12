import { describe, expect, test } from "bun:test";
import { isTrustedRendererUrl, secureWebPreferences } from "./security";

describe("Electron security boundary", () => {
  test("enables isolation and disables renderer privileges", () => {
    expect(secureWebPreferences("/app/preload.mjs")).toEqual({
      contextIsolation: true,
      nodeIntegration: false,
      preload: "/app/preload.mjs",
      sandbox: true,
      webSecurity: true,
    });
  });

  test.each([
    ["app://bundle/index.html", true],
    ["app://bundle/assets/index.js", true],
    ["https://bundle.evil.example/index.html", false],
    ["file:///tmp/index.html", false],
    ["app://attacker/index.html", false],
  ])("validates the exact renderer origin for %s", (url, expected) => {
    expect(isTrustedRendererUrl(url)).toBe(expected);
  });
});
