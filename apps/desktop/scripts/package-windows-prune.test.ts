import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pruneDependencyMetadata } from "./package-windows-prune";

describe("Windows dependency metadata pruning", () => {
  test("removes Playwright command and skill payload while preserving browser runtime", () => {
    const root = mkdtempSync(join(tmpdir(), "haksul-playwright-prune-"));
    const playwright = join(root, "node_modules", "playwright-core");
    try {
      for (const path of ["lib/entry", "lib/server", "lib/tools/skills/playwright-cli"]) {
        mkdirSync(join(playwright, path), { recursive: true });
      }
      writeFileSync(
        join(playwright, "package.json"),
        JSON.stringify({ name: "playwright-core", version: "1.62.1", main: "index.js" }),
      );
      writeFileSync(join(playwright, "cli.js"), "command");
      writeFileSync(join(playwright, "lib/entry/mcp.js"), "mcp");
      writeFileSync(join(playwright, "lib/tools/skills/playwright-cli/SKILL.md"), "skill");
      writeFileSync(join(playwright, "lib/server/chromium.js"), "runtime");

      pruneDependencyMetadata(root);

      expect(existsSync(join(playwright, "cli.js"))).toBe(false);
      expect(existsSync(join(playwright, "lib/entry/mcp.js"))).toBe(false);
      expect(existsSync(join(playwright, "lib/tools/skills"))).toBe(false);
      expect(existsSync(join(playwright, "lib/server/chromium.js"))).toBe(true);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
