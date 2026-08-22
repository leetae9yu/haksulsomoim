import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const runtimePackage = {
  name: "haksulsomoim-small-fraud-plugin",
  version: "0.1.0",
  description: "Runtime dependencies for the haksulsomoim small-fraud plugin",
  private: true,
  type: "module",
  engines: { node: ">=22.18.0" },
  dependencies: {
    "@modelcontextprotocol/sdk": "1.30.0",
    "@tesseract.js-data/eng": "1.0.0",
    "@tesseract.js-data/kor": "1.0.0",
    "playwright-core": "1.62.1",
    "tesseract.js": "7.0.0",
    zod: "4.4.3",
  },
} as const;

export async function buildPlugin(sourceRootInput: string, outputRootInput: string): Promise<void> {
  const sourceRoot = resolve(sourceRootInput);
  const outputRoot = resolve(outputRootInput);
  if (outputRoot === sourceRoot) throw new TypeError("Plugin output must differ from source root");
  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(join(outputRoot, "servers"), { recursive: true });
  await Promise.all(
    [".claude-plugin", ".codex-plugin", "config", "hooks", "skills"].map((path) =>
      cp(join(sourceRoot, path), join(outputRoot, path), { recursive: true }),
    ),
  );
  await writeFile(join(outputRoot, "package.json"), `${JSON.stringify(runtimePackage, null, 2)}\n`);
  const result = await Bun.build({
    entrypoints: [join(sourceRoot, "servers", "index.ts")],
    outdir: join(outputRoot, "servers"),
    target: "node",
    packages: "external",
    naming: "index.js",
  });
  if (!result.success) {
    throw new Error(result.logs.map((log) => log.message).join("\n"));
  }
}

if (import.meta.main) {
  const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  await buildPlugin(sourceRoot, join(sourceRoot, "plugin"));
  process.stdout.write(
    `${JSON.stringify({ status: "PASS", output: join(sourceRoot, "plugin") })}\n`,
  );
}
