import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pruneDependencyMetadata } from "./package-windows-prune.ts";
import { assertReleaseSurface } from "./package-windows-surface.ts";

function write(root: string, path: string, contents = "export {};"): void {
  const absolute = join(root, path);
  mkdirSync(join(absolute, ".."), { recursive: true });
  writeFileSync(absolute, contents);
}

function fixtureManifest(root: string, name: string, extra: Record<string, unknown> = {}): void {
  write(
    root,
    `${name}/package.json`,
    JSON.stringify({
      name,
      version: "1.0.0",
      type: "module",
      scripts: { test: "test" },
      bin: { command: "bin/cli.js" },
      devDependencies: { typescript: "latest" },
      ...extra,
    }),
  );
}

describe("F4 dependency-specific package closure", () => {
  test("prunes forbidden package surfaces and retargets proven runtime source closures", () => {
    const root = mkdtempSync(join(tmpdir(), "haksul-f4-prune-"));
    try {
      const modules = join(root, "node_modules");
      for (const name of ["@openai/codex-sdk", "@kordoc/core", "openai", "debug", "tesseract.js", "dotenv"]) {
        fixtureManifest(modules, name, {
          main:
            name === "debug"
              ? "./src/index.js"
              : name === "tesseract.js"
                ? "src/index.js"
                : "dist/index.js",
        });
      }
      for (const path of [
        "@openai/codex-sdk/docs/guide.md",
        "@openai/codex-sdk/bin/cli.js",
        "@kordoc/core/dist/commands/init.js",
        "@kordoc/core/dist/mcp/server.js",
        "openai/client/websocket.js",
        "openai/internal/qs/index.js",
      ])
        write(modules, path);
      write(modules, "debug/src/index.js", "export const debugRuntime = true;");
      fixtureManifest(modules, "dotenv", { main: "lib/main.js", types: "lib/main.d.ts" });
      for (const path of [
        "README.md",
        "README-es.md",
        "CHANGELOG.md",
        "LICENSE",
        "SECURITY.md",
        "config.js",
        "lib/main.js",
        "lib/main.d.ts",
        "tests/example.test.js",
        "examples/basic.js",
      ]) write(modules, `dotenv/${path}`);
      write(modules, "tesseract.js/src/index.js", "export const ocrRuntime = true;");
      fixtureManifest(modules, "unlisted-runtime");
      write(modules, "unlisted-runtime/runtime.js.map", "runtime-owned metadata");

      pruneDependencyMetadata(modules);

      expect(existsSync(join(modules, "debug/runtime/index.js"))).toBe(true);
      expect(existsSync(join(modules, "tesseract.js/runtime/index.js"))).toBe(true);
      expect(existsSync(join(modules, "@openai/codex-sdk/docs"))).toBe(false);
      for (const path of [
        "README.md",
        "README-es.md",
        "CHANGELOG.md",
        "LICENSE",
        "SECURITY.md",
        "lib/main.d.ts",
        "tests",
        "examples",
      ]) expect(existsSync(join(modules, `dotenv/${path}`))).toBe(false);
      expect(existsSync(join(modules, "dotenv/lib/main.js"))).toBe(true);
      expect(existsSync(join(modules, "dotenv/config.js"))).toBe(true);
      expect(existsSync(join(modules, "@kordoc/core/dist/commands"))).toBe(false);
      expect(existsSync(join(modules, "openai/internal/qs"))).toBe(false);
      expect(existsSync(join(modules, "unlisted-runtime/runtime.js.map"))).toBe(true);
      for (const name of ["debug", "tesseract.js"]) {
        const manifest = JSON.parse(readFileSync(join(modules, name, "package.json"), "utf8"));
        expect(manifest.main).toBe(name === "debug" ? "./runtime/index.js" : "runtime/index.js");
        expect(manifest.bin).toBeUndefined();
        expect(manifest.scripts).toBeUndefined();
        expect(manifest.devDependencies).toBeUndefined();
      }
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("reduces the installed Korean-law entrypoint in place to stdio only", () => {
    const root = mkdtempSync(join(tmpdir(), "haksul-f4-law-"));
    try {
      const modules = join(root, "node_modules");
      fixtureManifest(modules, "korean-law-mcp", { main: "build/index.js" });
      write(
        modules,
        "korean-law-mcp/build/index.js",
        [
          'import { StdioServerTransport } from "sdk";',
          'import { startHTTPServer } from "./server/http-server.js";',
          "async function main() {",
          "    const args = process.argv.slice(2);",
          '    if (args[0] === "setup") await import("./setup.js");',
          '    if (args.includes("--mode")) await startHTTPServer();',
          "    else {",
          "        const server = createServer();",
          "        const transport = new StdioServerTransport();",
          "        await server.connect(transport);",
          "    }",
          "}",
        ].join("\n"),
      );
      write(modules, "korean-law-mcp/build/server/http-server.js");
      write(modules, "korean-law-mcp/build/setup.js");

      pruneDependencyMetadata(modules);

      const entry = readFileSync(join(modules, "korean-law-mcp/build/index.js"), "utf8");
      expect(entry).toContain("new StdioServerTransport()");
      expect(entry).not.toContain("startHTTPServer");
      expect(entry).not.toContain('args[0] === "setup"');
      expect(existsSync(join(modules, "korean-law-mcp/build/server"))).toBe(false);
      expect(existsSync(join(modules, "korean-law-mcp/build/setup.js"))).toBe(false);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("rejects every forbidden path, manifest field, and advertised command", () => {
    const root = mkdtempSync(join(tmpdir(), "haksul-f4-surface-"));
    try {
      const forbidden = [
        "node_modules/@openai/codex-sdk/examples/demo.js",
        "node_modules/dotenv/README-es.md",
        "node_modules/dotenv/CHANGELOG.md",
        "node_modules/dotenv/LICENSE",
        "node_modules/@kordoc/core/dist/mcp/server.js",
        "node_modules/openai/client/websocket.js",
      ];
      expect(() => assertReleaseSurface(root, forbidden)).toThrow("Forbidden release paths");
      write(root, "node_modules/runtime/package.json", JSON.stringify({ bin: "cli.js" }));
      expect(() => assertReleaseSurface(root, ["node_modules/runtime/package.json"])).toThrow(
        "Non-runtime manifest field bin",
      );
      write(root, "node_modules/runtime/index.js", 'console.log("kordoc validate")');
      expect(() => assertReleaseSurface(root, ["node_modules/runtime/index.js"])).toThrow(
        "Advertised command remains",
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
