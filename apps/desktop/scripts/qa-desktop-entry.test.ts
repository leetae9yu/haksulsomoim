import { describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const desktopRoot = resolve(import.meta.dirname, "..");

describe("desktop QA Electron entry", () => {
  test("builds a syntactically loadable real main entry", async () => {
    await execFileAsync(
      resolve(desktopRoot, "node_modules/.bin/electron-vite"),
      ["build", "--mode", "qa", "--entry", "src/main/qa.ts"],
      { cwd: desktopRoot },
    );

    const checked = await execFileAsync("node", ["--check", "out/main/qa.js"], {
      cwd: desktopRoot,
    });
    expect(checked.stderr).toBe("");
  }, 120_000);
});
