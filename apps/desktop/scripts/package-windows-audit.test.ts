import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPackageWithOptions } from "@electron/asar";
import {
  assertAsarIntegrity,
  assertNoRetiredSuggestionCapability,
  auditWindowsPackage,
  fsSafeNativeInventory,
  pruneWindowsNativePayload,
} from "./package-windows-audit.ts";
import { pruneDependencyMetadata } from "./package-windows-prune.ts";

const fsSafeNative = "node_modules/@openclaw/fs-safe/dist/native";
const fsSafeWindowsNative = `${fsSafeNative}/win32-x64-msvc/fs-safe-native.node`;

function write(path: string, contents: Buffer | string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, contents);
}

function pe(machine = 0x8664): Buffer {
  const contents = Buffer.alloc(128);
  contents.write("MZ");
  contents.writeUInt32LE(0x40, 0x3c);
  contents.write("PE\0\0", 0x40);
  contents.writeUInt16LE(machine, 0x44);
  return contents;
}

function withTemporaryRoot(action: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "haksul-package-audit-"));
  try {
    action(root);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

function writeFsSafeRuntime(root: string): void {
  write(join(root, "node_modules/@openclaw/fs-safe/package.json"), "{}");
  write(join(root, "node_modules/@openclaw/fs-safe/dist/native.js"), "export {};");
  write(join(root, fsSafeWindowsNative), pe());
}

describe("Windows package payload audit", () => {
  test("rejects the retired outbound capability from staged runtime files", () => {
    withTemporaryRoot((root) => {
      const preload = join(root, "out/preload/index.js");
      for (const token of ["codex" + "Suggestion", "codex:" + "suggestion"]) {
        write(preload, `window.api[${JSON.stringify(token)}] = true`);
        expect(() => assertNoRetiredSuggestionCapability(root)).toThrow("Retired outbound");
      }
      write(preload, "window.api.startAgentRun = true");
      expect(() => assertNoRetiredSuggestionCapability(root)).not.toThrow();
    });
  });

  test("prunes the disposable stage to Windows x64 native directories", () => {
    withTemporaryRoot((root) => {
      writeFsSafeRuntime(root);
      write(
        join(root, `${fsSafeNative}/linux-x64-gnu/fs-safe-native.node`),
        Buffer.from("\u007fELF"),
      );
      write(
        join(root, "node_modules/onnxruntime-node/bin/napi-v6/linux/x64/binding.node"),
        Buffer.from("\u007fELF"),
      );
      write(
        join(root, "node_modules/onnxruntime-node/bin/napi-v6/win32/arm64/binding.node"),
        pe(0xaa64),
      );
      write(join(root, "node_modules/onnxruntime-node/bin/napi-v6/win32/x64/binding.node"), pe());

      pruneWindowsNativePayload(root);

      expect(fsSafeNativeInventory(root)).toEqual(["win32-x64-msvc/fs-safe-native.node"]);
      expect(existsSync(join(root, "node_modules/onnxruntime-node/bin/napi-v6/linux"))).toBe(false);
      expect(existsSync(join(root, "node_modules/onnxruntime-node/bin/napi-v6/win32/arm64"))).toBe(
        false,
      );
    });
  });

  test("removes non-runtime dependency metadata before archive creation", () => {
    withTemporaryRoot((root) => {
      write(join(root, "node_modules/zod/runtime.js"), "export {};");
      write(join(root, "node_modules/zod/example.d.ts"), "010-1234-5678");
      write(join(root, "node_modules/zod/runtime.js.map"), "source map");
      write(join(root, "node_modules/kordoc/dist/index.js"), "export {};");
      write(join(root, "node_modules/kordoc/dist/cli.js"), "010-1234-5678");
      write(join(root, "node_modules/kordoc/dist/mcp.js"), "010-1234-5678");
      write(join(root, "node_modules/kordoc/src/parser.ts"), "source");
      write(join(root, "node_modules/kordoc/README.md"), "documentation");
      write(
        join(root, "node_modules/kordoc/package.json"),
        JSON.stringify({
          name: "kordoc",
          version: "1.0.0",
          type: "module",
          main: "dist/index.js",
          bin: { kordoc: "dist/cli.js" },
          scripts: { test: "test" },
          dependencies: { "markdown-it": "1.0.0" },
        }),
      );

      pruneDependencyMetadata(root);

      expect(existsSync(join(root, "node_modules/zod/runtime.js"))).toBe(true);
      expect(existsSync(join(root, "node_modules/zod/example.d.ts"))).toBe(false);
      expect(existsSync(join(root, "node_modules/zod/runtime.js.map"))).toBe(false);
      expect(existsSync(join(root, "node_modules/kordoc/dist/index.js"))).toBe(true);
      expect(existsSync(join(root, "node_modules/kordoc/dist/cli.js"))).toBe(false);
      expect(existsSync(join(root, "node_modules/kordoc/dist/mcp.js"))).toBe(false);
      expect(existsSync(join(root, "node_modules/kordoc/src"))).toBe(false);
      expect(existsSync(join(root, "node_modules/kordoc/README.md"))).toBe(false);
      const manifest = JSON.parse(
        readFileSync(join(root, "node_modules/kordoc/package.json"), "utf8"),
      );
      expect(manifest.bin).toBeUndefined();
      expect(manifest.scripts).toBeUndefined();
      expect(manifest.main).toBe("dist/index.js");
      expect(manifest.dependencies).toEqual({ "markdown-it": "1.0.0" });
    });
  });

  test("rejects stale unpacked ASAR references and forbidden indexed metadata", async () => {
    const root = mkdtempSync(join(tmpdir(), "haksul-asar-integrity-"));
    try {
      const source = join(root, "source");
      write(join(source, "node_modules/kordoc/dist/index.js"), "export {};");
      write(join(source, "node_modules/kordoc/dist/index.d.ts"), "export {};");
      const asar = join(root, "app.asar");
      await createPackageWithOptions(source, asar, { unpack: "**/*" });
      rmSync(join(`${asar}.unpacked`, "node_modules/kordoc/dist/index.d.ts"));

      expect(() => assertAsarIntegrity(asar)).toThrow("stale unpacked ASAR reference");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("fails staging when the required Windows fs-safe native binding is absent", () => {
    withTemporaryRoot((root) => {
      write(
        join(root, `${fsSafeNative}/linux-x64-gnu/fs-safe-native.node`),
        Buffer.from("\u007fELF"),
      );
      expect(() => pruneWindowsNativePayload(root)).toThrow(
        "Missing Windows fs-safe native binding",
      );
    });
  });

  test("rejects foreign binary magic and unsupported PE architectures", () => {
    withTemporaryRoot((root) => {
      const unpackedRoot = join(root, "win-unpacked");
      writeFsSafeRuntime(join(unpackedRoot, "resources/app.asar.unpacked"));
      write(join(unpackedRoot, "foreign.elf"), Buffer.from("\u007fELF"));
      write(join(unpackedRoot, "foreign.macho"), Buffer.from([0xfe, 0xed, 0xfa, 0xcf]));
      write(join(unpackedRoot, "foreign-arm64.dll"), pe(0xaa64));

      expect(() => auditWindowsPackage(unpackedRoot, [])).toThrow("ELF");
      expect(() => auditWindowsPackage(unpackedRoot, [])).toThrow("Mach-O");
      expect(() => auditWindowsPackage(unpackedRoot, [])).toThrow("unsupported PE machine");
    });
  });

  test("requires a clean Windows payload and the fs-safe runtime closure", () => {
    withTemporaryRoot((root) => {
      const unpackedRoot = join(root, "win-unpacked");
      writeFsSafeRuntime(join(unpackedRoot, "resources/app.asar.unpacked"));

      expect(auditWindowsPackage(unpackedRoot, [])).toEqual({
        fsSafeNative: ["win32-x64-msvc/fs-safe-native.node"],
        peX64: [
          "resources/app.asar.unpacked/node_modules/@openclaw/fs-safe/dist/native/win32-x64-msvc/fs-safe-native.node",
        ],
      });
      expect(() => auditWindowsPackage(unpackedRoot, ["out/.env"])).toThrow(
        "Forbidden release paths",
      );
    });
  });
});
