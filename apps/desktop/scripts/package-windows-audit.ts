import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, relative } from "node:path";

const fsSafeNativePath = "node_modules/@openclaw/fs-safe/dist/native";
const fsSafeWindowsTarget = "win32-x64-msvc/fs-safe-native.node";
const fsSafeRuntimeFiles = [
  "node_modules/@openclaw/fs-safe/package.json",
  "node_modules/@openclaw/fs-safe/dist/native.js",
  `${fsSafeNativePath}/${fsSafeWindowsTarget}`,
] as const;
const onnxRuntimeRoots = [
  "node_modules/onnxruntime-node/bin/napi-v6",
  "node_modules/kordoc/node_modules/onnxruntime-node/bin/napi-v6",
] as const;

export type WindowsPayloadAudit = Readonly<{
  fsSafeNative: readonly string[];
  peX64: readonly string[];
}>;

function filesBelow(root: string): string[] {
  const paths: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) paths.push(relative(root, absolute).replaceAll("\\", "/"));
    }
  };
  visit(root);
  return paths.sort();
}

function isForbiddenPath(path: string): boolean {
  return (
    /(^|\/)(?:\.omo|evidence|secrets?|test|tests|__tests__)(?:\/|$)/iu.test(path) ||
    /(^|\/)(?:qa(?:[-_.]|$)|[^/]+\.(?:test|spec)\.[cm]?[jt]sx?|\.env(?:\.[^/]+)?)(?:$|\/)/iu.test(
      path,
    )
  );
}

function isMachO(header: Buffer): boolean {
  if (header.length < 4) return false;
  const magic = header.readUInt32BE(0);
  return [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca].includes(magic);
}

function peMachine(path: string, header: Buffer): number | undefined {
  if (header.subarray(0, 2).toString("ascii") !== "MZ" || header.length < 0x40) return undefined;
  const offset = header.readUInt32LE(0x3c);
  const contents = readFileSync(path);
  if (
    offset + 6 > contents.length ||
    contents.subarray(offset, offset + 4).toString("ascii") !== "PE\0\0"
  ) {
    throw new Error(`${path} has an invalid PE header`);
  }
  return contents.readUInt16LE(offset + 4);
}

function assertFsSafeWindowsNative(unpackedDependencies: string): readonly string[] {
  const nativeRoot = join(unpackedDependencies, fsSafeNativePath);
  const expected = join(nativeRoot, fsSafeWindowsTarget);
  if (!existsSync(expected)) throw new Error(`Missing Windows fs-safe native binding: ${expected}`);
  const natives = filesBelow(nativeRoot);
  if (natives.length !== 1 || natives[0] !== fsSafeWindowsTarget) {
    throw new Error(`Unexpected fs-safe native payload: ${natives.join(", ")}`);
  }
  return natives;
}

function keepWindowsX64(root: string): void {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name !== "win32") rmSync(join(root, entry.name), { force: true, recursive: true });
  }
  const windowsRoot = join(root, "win32");
  for (const entry of readdirSync(windowsRoot, { withFileTypes: true })) {
    if (entry.name !== "x64")
      rmSync(join(windowsRoot, entry.name), { force: true, recursive: true });
  }
}

export function pruneWindowsNativePayload(stageRoot: string): void {
  const fsSafeRoot = join(stageRoot, fsSafeNativePath);
  const fsSafeTarget = join(fsSafeRoot, fsSafeWindowsTarget);
  if (!existsSync(fsSafeTarget))
    throw new Error(`Missing Windows fs-safe native binding: ${fsSafeTarget}`);
  for (const entry of readdirSync(fsSafeRoot, { withFileTypes: true })) {
    if (entry.name !== "win32-x64-msvc")
      rmSync(join(fsSafeRoot, entry.name), { force: true, recursive: true });
  }
  assertFsSafeWindowsNative(stageRoot);
  for (const path of onnxRuntimeRoots) {
    const nativeRoot = join(stageRoot, path);
    if (existsSync(nativeRoot)) keepWindowsX64(nativeRoot);
  }
}

export function auditWindowsPackage(
  unpackedRoot: string,
  asarPaths: readonly string[],
): WindowsPayloadAudit {
  const unpackedDependencies = join(unpackedRoot, "resources", "app.asar.unpacked");
  const payloadPaths = filesBelow(unpackedRoot);
  const forbidden = [...asarPaths, ...payloadPaths].filter(isForbiddenPath).sort();
  if (forbidden.length > 0)
    throw new Error(`Forbidden Windows package payload: ${forbidden.join(", ")}`);
  for (const runtimeFile of fsSafeRuntimeFiles) {
    const path = join(unpackedDependencies, runtimeFile);
    if (!existsSync(path)) throw new Error(`Missing fs-safe runtime closure: ${path}`);
  }
  const violations: string[] = [];
  const peX64: string[] = [];
  for (const path of payloadPaths) {
    const absolute = join(unpackedRoot, path);
    const header = readFileSync(absolute).subarray(0, 64);
    if (header.subarray(0, 4).toString("ascii") === "\u007fELF") violations.push(`ELF: ${path}`);
    else if (isMachO(header)) violations.push(`Mach-O: ${path}`);
    else {
      const machine = peMachine(absolute, header);
      if (machine !== undefined) {
        if (machine !== 0x8664) violations.push(`unsupported PE machine ${machine}: ${path}`);
        else peX64.push(path);
      }
    }
  }
  if (violations.length > 0)
    throw new Error(`Invalid Windows binary payload: ${violations.join(", ")}`);
  const fsSafeNative = assertFsSafeWindowsNative(unpackedDependencies);
  return { fsSafeNative, peX64: peX64.sort() };
}

export function fsSafeNativeInventory(root: string): readonly string[] {
  return filesBelow(join(root, fsSafeNativePath));
}
