import { existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { metadataPrunedPackages } from "./package-windows-allowlist.ts";

const packageRemovals: Readonly<Record<string, readonly string[]>> = {
  "@modelcontextprotocol/sdk": [
    "dist/cjs/examples",
    "dist/esm/examples",
    "dist/cjs/server/mcp.js",
    "dist/esm/server/mcp.js",
    "dist/cjs/experimental/tasks/mcp-server.js",
    "dist/esm/experimental/tasks/mcp-server.js",
  ],
  "@openai/codex": ["README.md", "bin"],
  "@openai/codex-sdk": [
    "README.md",
    "docs",
    "examples",
    "spec",
    "test",
    "tests",
    "source",
    "src",
    "setup.js",
    "bin",
  ],
  "@openclaw/fs-safe": ["docs"],
  "@tesseract.js-data/eng": ["README.md"],
  "@tesseract.js-data/kor": ["README.md"],
  "@kordoc/core": [
    "README.md",
    "docs",
    "examples",
    "spec",
    "test",
    "tests",
    "source",
    "src",
    "dist/commands",
    "dist/mcp/server.js",
  ],
  "ajv-formats": ["src"],
  dotenv: ["skills"],
  eventsource: ["src"],
  "eventsource-parser": ["src"],
  "json-schema-traverse": ["spec"],
  jszip: ["README.markdown"],
  kordoc: ["README.md", "NOTICE", "THIRD_PARTY", "src", "source", "docs", "examples"],
  "korean-law-mcp": [
    "README.md",
    "NOTICE",
    "build/cli.js",
    "build/setup.js",
    "build/server",
    "build/lib/cli-executor.js",
    "build/lib/cli-format.js",
  ],
  openai: [
    "README.md",
    "docs",
    "examples",
    "tests",
    "src",
    "bin/cli.js",
    "client/websocket.js",
    "internal/qs",
    "server/http.js",
    "server/sse.js",
  ],
  pako: ["lib/zlib/README"],
  "readable-stream": ["doc"],
  "tesseract.js": ["docs", "examples", "scripts"],
  "wasm-feature-detect": ["README.md.ejs"],
  zlibjs: ["README.en.md"],
  zod: ["src"],
};

const relocatedRuntime: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  debug: { src: "runtime" },
  "tesseract.js": { src: "runtime" },
};

const runtimeManifestFields = new Set([
  "browser",
  "cpu",
  "dependencies",
  "engines",
  "exports",
  "imports",
  "main",
  "module",
  "name",
  "optionalDependencies",
  "os",
  "peerDependencies",
  "peerDependenciesMeta",
  "type",
  "version",
]);

function packageRoot(root: string, name: string): string {
  return join(root, ...name.split("/"));
}

function retarget(value: unknown, replacements: Readonly<Record<string, string>>): unknown {
  if (typeof value === "string") {
    let result = value;
    for (const [from, to] of Object.entries(replacements)) {
      if (result.startsWith(`./${from}/`)) result = `./${to}/${result.slice(from.length + 3)}`;
      else if (result.startsWith(`${from}/`)) result = `${to}/${result.slice(from.length + 1)}`;
    }
    return result;
  }
  if (Array.isArray(value)) return value.map((entry) => retarget(entry, replacements));
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !["types", "typings", "source", "development"].includes(key))
      .map(([key, entry]) => [key, retarget(entry, replacements)]),
  );
}

function replaceFile(path: string, contents: string): void {
  const staged = `${path}.runtime-stage`;
  writeFileSync(staged, contents);
  renameSync(staged, path);
}

function trimManifest(path: string, replacements: Readonly<Record<string, string>> = {}): void {
  const source: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof source !== "object" || source === null) throw new Error(`Invalid manifest: ${path}`);
  const runtime = Object.fromEntries(
    Object.entries(source as Record<string, unknown>)
      .filter(([key]) => runtimeManifestFields.has(key))
      .map(([key, value]) => [key, retarget(value, replacements)]),
  );
  replaceFile(path, `${JSON.stringify(runtime, null, 2)}\n`);
}

function restrictKoreanLawToStdio(root: string): void {
  const entry = join(packageRoot(root, "korean-law-mcp"), "build/index.js");
  if (!existsSync(entry)) return;
  const source = readFileSync(entry, "utf8");
  if (
    !source.includes("startHTTPServer") &&
    !source.includes("process.argv.slice") &&
    source.includes("new StdioServerTransport()") &&
    source.includes("server.connect(transport)")
  )
    return;
  const withoutHttp = source.replace(
    'import { startHTTPServer } from "./server/http-server.js";\n',
    "",
  );
  const start = withoutHttp.indexOf("    const args = process.argv.slice(2);");
  const end = withoutHttp.indexOf("        await server.connect(transport);", start);
  if (start < 0 || end < 0) {
    throw new Error("Unsupported Korean-law entrypoint; refusing unsafe package transform");
  }
  const afterConnect = end + "        await server.connect(transport);".length;
  const close = withoutHttp.indexOf("\n    }", afterConnect);
  if (close < 0) throw new Error("Unsupported Korean-law entrypoint closure");
  const stdio = [
    '    const stderrWrite = (...args) => process.stderr.write(args.map(String).join(" ") + "\\n");',
    "    console.log = console.warn = console.info = console.debug = stderrWrite;",
    "    const server = createServer();",
    "    const transport = new StdioServerTransport();",
    "    await server.connect(transport);",
  ].join("\n");
  const transformed = `${withoutHttp.slice(0, start)}${stdio}${withoutHttp.slice(close + 6)}`;
  if (transformed.includes("startHTTPServer") || transformed.includes("./setup.js")) {
    throw new Error("Korean-law command or server surface survived package transform");
  }
  replaceFile(entry, transformed);
}

function owningPackage(root: string, path: string): string {
  const segments = relative(root, path).replaceAll("\\", "/").split("/");
  return segments[0]?.startsWith("@") ? segments.slice(0, 2).join("/") : (segments[0] ?? "");
}

function visitManifests(root: string, directory = root): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) visitManifests(root, absolute);
    else if (entry.name === "package.json") {
      const packagePath = relative(root, dirname(absolute)).replaceAll("\\", "/");
      trimManifest(absolute, relocatedRuntime[packagePath] ?? {});
    } else if (
      metadataPrunedPackages.has(owningPackage(root, absolute)) &&
      /\.(?:map|d\.[cm]?ts)$/u.test(entry.name)
    )
      rmSync(absolute, { force: true });
  }
}

export function pruneDependencyMetadata(root: string): void {
  const dependencies = existsSync(join(root, "node_modules")) ? join(root, "node_modules") : root;
  restrictKoreanLawToStdio(dependencies);
  for (const [name, moves] of Object.entries(relocatedRuntime)) {
    const base = packageRoot(dependencies, name);
    for (const [from, to] of Object.entries(moves)) {
      const source = join(base, from);
      if (existsSync(source)) renameSync(source, join(base, to));
    }
  }
  for (const [name, paths] of Object.entries(packageRemovals)) {
    const base = packageRoot(dependencies, name);
    for (const path of paths) rmSync(join(base, path), { force: true, recursive: true });
  }
  for (const path of ["kordoc/dist/cli.js", "kordoc/dist/mcp.js", "kordoc/dist/commands"]) {
    rmSync(join(dependencies, path), { force: true, recursive: true });
  }
  visitManifests(dependencies);
}
