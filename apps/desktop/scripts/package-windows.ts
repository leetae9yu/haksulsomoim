import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { arch, platform, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { listPackage } from "@electron/asar";
import { getPath7za } from "app-builder-lib/out/toolsets/7zip.js";
import { getMakeNsisPath } from "app-builder-lib/out/toolsets/windows.js";
import { auditWindowsPackage, pruneWindowsNativePayload } from "./package-windows-audit.ts";
import {
  assertWindowsDependencyPaths,
  collectPaths,
  directorySize,
  hashReceipt,
  isDependencyTestPath,
  packagingStrategy,
  privateUnsignedReleaseReport,
  pruneDependencyTests,
  readPeMachine,
  readVersion,
  resolveElectronBuilderTools,
  run,
  sha256,
  validateInstallerTemplate,
  validateUninstallerTemplate,
} from "./package-windows-lib.ts";

async function packageWindows(desktopRoot: string): Promise<void> {
  const packagePath = join(desktopRoot, "package.json");
  const version = readVersion(packagePath);
  const outputRoot = join(desktopRoot, "dist");
  const stageRoot = mkdtempSync(join(tmpdir(), "haksul-win-stage-"));

  try {
    run("bun", ["run", "build"], desktopRoot);
    rmSync(outputRoot, { force: true, recursive: true });
    mkdirSync(outputRoot, { recursive: true });
    for (const name of ["package.json", "bun.lock", "electron-builder.yml"] as const) {
      cpSync(join(desktopRoot, name), join(stageRoot, name));
    }
    cpSync(join(desktopRoot, "out"), join(stageRoot, "out"), { recursive: true });

    run(
      "bun",
      ["install", "--production", "--frozen-lockfile", "--os=win32", "--cpu=x64"],
      stageRoot,
    );
    assertWindowsDependencyPaths(collectPaths(stageRoot));
    pruneWindowsNativePayload(stageRoot);

    const builderCli = resolve(desktopRoot, "node_modules/electron-builder/cli.js");
    const unpackedRoot = join(stageRoot, "dist", "win-unpacked");
    run(
      process.execPath,
      [
        builderCli,
        "--projectDir",
        stageRoot,
        "--win",
        "dir",
        "--x64",
        `--config.directories.output=${join(stageRoot, "dist")}`,
      ],
      desktopRoot,
    );

    const applicationExe = join(unpackedRoot, "haksulsomoim-small-fraud-agent.exe");
    if (readPeMachine(applicationExe) !== 0x8664) {
      throw new Error("Packaged application executable is not Windows x64");
    }
    const asarPath = join(unpackedRoot, "resources", "app.asar");
    const asarPaths = listPackage(asarPath, { isPack: false });
    if (asarPaths.some((path) => isDependencyTestPath(path))) {
      throw new Error("Packaged ASAR still contains dependency test payload");
    }
    const unpackedDependencies = join(
      unpackedRoot,
      "resources",
      "app.asar.unpacked",
      "node_modules",
    );
    pruneWindowsNativePayload(join(unpackedRoot, "resources", "app.asar.unpacked"));
    pruneDependencyTests(unpackedDependencies);
    if (collectPaths(unpackedDependencies).some((path) => isDependencyTestPath(path))) {
      throw new Error("Packaged production dependencies still contain test payload");
    }
    console.log(JSON.stringify({ windowsPayload: auditWindowsPackage(unpackedRoot, asarPaths) }));

    const tools = await resolveElectronBuilderTools(platform(), getPath7za, getMakeNsisPath);
    const archivePath = join(stageRoot, "app-x64.7z");
    run(
      tools.sevenZip,
      ["a", "-bd", "-mx=1", "-mtc=off", "-mtm=off", "-mta=off", archivePath, "."],
      unpackedRoot,
    );

    const nsisEnv = { ...process.env, ...tools.makensisEnv };
    const uninstallPath = join(stageRoot, "uninstall.exe");
    const uninstallTemplate = join(desktopRoot, "scripts", "nsis", "uninstall.nsi");
    const installerTemplate = join(desktopRoot, "scripts", "nsis", "installer.nsi");
    const windowsSevenZip = join(
      desktopRoot,
      "node_modules",
      "electron-winstaller",
      "vendor",
      "7z-x64.exe",
    );
    if (readPeMachine(windowsSevenZip) !== 0x8664) {
      throw new Error("Bundled installer extraction executable is not Windows x64");
    }
    validateUninstallerTemplate(readFileSync(uninstallTemplate, "utf8"));
    validateInstallerTemplate(readFileSync(installerTemplate, "utf8"));
    run(
      tools.makensis,
      ["-V2", `-DOUTPUT_FILE=${uninstallPath}`, uninstallTemplate],
      desktopRoot,
      nsisEnv,
    );

    const setupPath = join(outputRoot, `small-fraud-agent-${version}-x64-setup.exe`);
    run(
      tools.makensis,
      [
        "-V2",
        `-DOUTPUT_FILE=${setupPath}`,
        `-DAPP_ARCHIVE=${archivePath}`,
        `-DUNINSTALLER_FILE=${uninstallPath}`,
        `-DSEVEN_ZIP_FILE=${windowsSevenZip}`,
        `-DAPP_VERSION=${version}`,
        `-DESTIMATED_SIZE=${Math.ceil(directorySize(unpackedRoot) / 1024)}`,
        installerTemplate,
      ],
      desktopRoot,
      nsisEnv,
    );
    if (!existsSync(setupPath) || statSync(setupPath).size <= statSync(archivePath).size) {
      throw new Error("NSIS setup is missing or does not contain the application archive");
    }
    const digest = await sha256(setupPath);
    const hashPath = `${setupPath}.sha256`;
    writeFileSync(hashPath, hashReceipt(setupPath, digest), { mode: 0o600 });
    console.log(
      JSON.stringify(privateUnsignedReleaseReport(setupPath, statSync(setupPath).size, digest)),
    );
  } finally {
    rmSync(stageRoot, { force: true, recursive: true });
  }
}

export async function main(): Promise<void> {
  const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  packagingStrategy(platform(), arch());
  await packageWindows(desktopRoot);
}

const entryUrl =
  process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href;
if (entryUrl === import.meta.url) await main();
