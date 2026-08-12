import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  createReadStream,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, join, relative, win32 } from "node:path";

export const FIXED_INSTALL_DIR = "$LOCALAPPDATA\\Programs\\HaksulSomoimSmallFraudAgent";
export const OWNERSHIP_MARKER = ".haksulsomoim-smallfraud-owned";
const NSIS_MARKER_REFERENCE = `$${"{OWNERSHIP_MARKER}"}`;
const NSIS_SEVEN_ZIP_REFERENCE = `$${"{SEVEN_ZIP_FILE}"}`;

const requiredWindowsDependencies = [
  "node_modules/@openai/codex-win32-x64",
  "node_modules/@img/sharp-win32-x64",
  "node_modules/@napi-rs/canvas-win32-x64-msvc",
] as const;
const forbiddenHostDependencies = [
  "node_modules/@openai/codex-linux-",
  "node_modules/@img/sharp-linux-",
  "node_modules/@napi-rs/canvas-linux-",
] as const;

export function packagingStrategy(hostPlatform: string, hostArch: string): "custom" {
  if (hostPlatform === "win32" || (hostPlatform === "linux" && hostArch === "arm64")) {
    return "custom";
  }
  throw new Error(`Unsupported packaging host: ${hostPlatform}/${hostArch}`);
}

type ToolInfo = { path: string; env?: NodeJS.ProcessEnv };
type SevenZipLoader = () => Promise<string>;
type MakeNsisLoader = (version: "1.2.1") => Promise<ToolInfo>;

export async function resolveElectronBuilderTools(
  hostPlatform: string,
  loadSevenZip: SevenZipLoader,
  loadMakeNsis: MakeNsisLoader,
): Promise<{ sevenZip: string; makensis: string; makensisEnv: NodeJS.ProcessEnv }> {
  const sevenZip = await loadSevenZip();
  const tool = await loadMakeNsis("1.2.1");
  if (hostPlatform !== "win32") {
    return { sevenZip, makensis: tool.path, makensisEnv: tool.env ?? {} };
  }
  const path = win32;
  const bundleRoot = path.dirname(tool.path.replaceAll("/", "\\"));
  return {
    sevenZip,
    makensis: path.join(bundleRoot, "windows", "makensis.exe"),
    makensisEnv: { ...tool.env, NSISDIR: path.join(bundleRoot, "windows") },
  };
}

export function assertWindowsDependencyPaths(paths: readonly string[]): void {
  const normalized = paths.map((value) => value.replaceAll("\\", "/").toLowerCase());
  for (const required of requiredWindowsDependencies) {
    if (!normalized.some((value) => value.includes(required))) {
      throw new Error(`Missing Windows x64 dependency: ${required}`);
    }
  }
  for (const forbidden of forbiddenHostDependencies) {
    if (normalized.some((value) => value.includes(forbidden))) {
      throw new Error(`Refusing host-native dependency in Windows package: ${forbidden}`);
    }
  }
}

function requireTemplateParts(source: string, parts: readonly string[], message: string): void {
  if (parts.some((part) => !source.includes(part))) throw new Error(message);
}

function assertMarkerGatedRemoval(source: string, variable: "$INSTDIR" | "$R8" | "$R9"): void {
  const removal = `RMDir /r "${variable}"`;
  if (
    source.includes(removal) &&
    !source.includes(`IfFileExists "${variable}\\${NSIS_MARKER_REFERENCE}"`)
  ) {
    throw new Error(`NSIS recursive removal of ${variable} requires the ownership marker`);
  }
}

export function validateInstallerTemplate(source: string): void {
  requireTemplateParts(
    source,
    [
      `StrCpy $INSTDIR "${FIXED_INSTALL_DIR}"`,
      `!define OWNERSHIP_MARKER "${OWNERSHIP_MARKER}"`,
      'StrCpy $R8 "$INSTDIR.installing"',
      'StrCpy $R9 "$INSTDIR.previous"',
      `IfFileExists "$INSTDIR\\${NSIS_MARKER_REFERENCE}"`,
      `File /oname=7za.exe "${NSIS_SEVEN_ZIP_REFERENCE}"`,
      "nsExec::ExecToStack",
      'StrCmp $R1 "0" extraction_succeeded extraction_failed',
      'IfFileExists "$R8\\resources\\."',
      'IfFileExists "$R8\\resources\\app.asar"',
      'Rename "$R8" "$INSTDIR"',
      'Rename "$R9" "$INSTDIR"\n    IfErrors rollback_failed',
      "rollback_failed:",
      "기존 설치가 복원되지 않았습니다",
    ],
    "NSIS installer requires fixed-path staging, payload validation, and an ownership marker",
  );
  if (source.includes("MUI_PAGE_DIRECTORY") || source.includes("InstallDirRegKey")) {
    throw new Error("NSIS installer must not accept a variable installation directory");
  }
  for (const variable of ["$INSTDIR", "$R8", "$R9"] as const) {
    assertMarkerGatedRemoval(source, variable);
  }
  const extraction = source.indexOf("nsExec::ExecToStack");
  const exitCheck = source.indexOf('StrCmp $R1 "0" extraction_succeeded extraction_failed');
  const asarValidation = source.indexOf('IfFileExists "$R8\\resources\\app.asar"');
  const replacement = source.indexOf('Rename "$R8" "$INSTDIR"');
  if (
    extraction < 0 ||
    extraction > exitCheck ||
    exitCheck > asarValidation ||
    asarValidation > replacement
  ) {
    throw new Error("NSIS installer must validate staged extraction before replacement");
  }
}

export function validateUninstallerTemplate(source: string): void {
  requireTemplateParts(
    source,
    [
      `StrCpy $INSTDIR "${FIXED_INSTALL_DIR}"`,
      `!define OWNERSHIP_MARKER "${OWNERSHIP_MARKER}"`,
      `IfFileExists "$INSTDIR\\${NSIS_MARKER_REFERENCE}"`,
      'RMDir /r "$INSTDIR"',
    ],
    "NSIS uninstall requires the fixed path and ownership marker",
  );
  assertMarkerGatedRemoval(source, "$INSTDIR");
  const markerCheck = source.indexOf(`IfFileExists "$INSTDIR\\${NSIS_MARKER_REFERENCE}"`);
  const firstMutation = Math.min(
    source.indexOf('Delete "$DESKTOP'),
    source.indexOf("DeleteRegKey"),
    source.indexOf('RMDir /r "$INSTDIR"'),
  );
  if (markerCheck < 0 || firstMutation < 0 || markerCheck > firstMutation) {
    throw new Error("NSIS uninstall must verify ownership before changing the installation");
  }
}

export function privateUnsignedReleaseReport(path: string, bytes: number, digest: string) {
  return {
    artifact: path,
    bytes,
    signed: false,
    distribution: "private" as const,
    checksum: { algorithm: "sha256" as const, digest, artifact: `${path}.sha256` },
  };
}

export function run(
  command: string,
  args: readonly string[],
  cwd: string,
  env = process.env,
): void {
  const result = spawnSync(command, args, { cwd, env, stdio: "inherit" });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status ?? "unknown"}`);
  }
}

export function collectPaths(root: string): string[] {
  const paths: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      paths.push(relative(root, absolute));
      if (entry.isDirectory()) visit(absolute);
    }
  };
  visit(root);
  return paths;
}

export function isDependencyTestPath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  return (
    /(^|\/)(?:test|tests|__tests__)(?:\/|$)/iu.test(normalized) ||
    /(?:^|\/)[^/]+\.(?:test|spec)\.[cm]?[jt]sx?$/iu.test(normalized)
  );
}

export function pruneDependencyTests(root: string): void {
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      const relativePath = relative(root, absolute);
      if (isDependencyTestPath(relativePath)) {
        rmSync(absolute, { force: true, recursive: true });
      } else if (entry.isDirectory()) {
        visit(absolute);
      }
    }
  };
  visit(root);
}

export function findFile(root: string, predicate: (path: string) => boolean): string {
  const matches = collectPaths(root)
    .map((path) => join(root, path))
    .filter(predicate)
    .sort();
  const match = matches.at(-1);
  if (match === undefined) throw new Error(`Required packaging tool not found under ${root}`);
  return match;
}

export function directorySize(root: string): number {
  let total = 0;
  for (const path of collectPaths(root)) {
    const absolute = join(root, path);
    const stat = statSync(absolute);
    if (!stat.isDirectory()) total += stat.size;
  }
  return total;
}

export function readPeMachine(path: string): number {
  const descriptor = openSync(path, "r");
  try {
    const header = Buffer.alloc(64);
    readSync(descriptor, header, 0, header.length, 0);
    if (header.toString("ascii", 0, 2) !== "MZ") throw new Error(`${path} is not a PE file`);
    const peOffset = header.readUInt32LE(0x3c);
    const signature = Buffer.alloc(6);
    readSync(descriptor, signature, 0, signature.length, peOffset);
    if (signature.toString("ascii", 0, 4) !== "PE\u0000\u0000") {
      throw new Error(`${path} has no PE signature`);
    }
    return signature.readUInt16LE(4);
  } finally {
    closeSync(descriptor);
  }
}

export async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export function readVersion(packagePath: string): string {
  const parsed: unknown = JSON.parse(readFileSync(packagePath, "utf8"));
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("version" in parsed) ||
    typeof parsed.version !== "string"
  ) {
    throw new Error("package.json must contain a string version");
  }
  return parsed.version;
}

export function hashReceipt(path: string, digest: string): string {
  return `${digest}  ${basename(path)}\n`;
}
