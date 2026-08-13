import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { securePrivateArtifact } from "./package-windows-artifact.ts";
import {
  assertWindowsDependencyPaths,
  FIXED_INSTALL_DIR,
  isDependencyTestPath,
  OWNERSHIP_MARKER,
  packagingStrategy,
  privateUnsignedReleaseReport,
  resolveElectronBuilderTools,
  validateInstallerTemplate,
  validateUninstallerTemplate,
} from "./package-windows-lib.ts";

const nsisRoot = join(dirname(fileURLToPath(import.meta.url)), "nsis");
const desktopRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const nsisMarkerReference = `$${"{OWNERSHIP_MARKER}"}`;
const nsisSevenZipReference = `$${"{SEVEN_ZIP_FILE}"}`;

describe("Windows release packaging", () => {
  test("uses the custom installer on Linux arm64 and every native Windows host", () => {
    expect(packagingStrategy("linux", "arm64")).toBe("custom");
    expect(packagingStrategy("win32", "x64")).toBe("custom");
    expect(packagingStrategy("win32", "arm64")).toBe("custom");
    expect(() => packagingStrategy("linux", "x64")).toThrow("Unsupported packaging host");
  });

  test("unpacks the complete production dependency closure for packaged subprocesses", () => {
    const configuration = readFileSync(join(desktopRoot, "electron-builder.yml"), "utf8");
    expect(configuration).toContain("  - node_modules/**/*");
    expect(configuration).not.toContain("  - node_modules/korean-law-mcp/**/*");
    for (const exclusion of [
      "!node_modules/**/test/**/*",
      "!node_modules/**/tests/**/*",
      "!node_modules/**/__tests__/**/*",
      "!node_modules/**/*.test.*",
      "!node_modules/**/*.spec.*",
    ]) {
      expect(configuration).toContain(exclusion);
    }
  });

  test("excludes dependency test payload without removing runtime source", () => {
    expect(isDependencyTestPath("zod/src/v3/tests/index.test.ts")).toBe(true);
    expect(isDependencyTestPath("sdk/__tests__/client.spec.js")).toBe(true);
    expect(isDependencyTestPath("package/runtime.test.cjs")).toBe(true);
    expect(isDependencyTestPath("zod/src/v4/core/index.ts")).toBe(false);
    expect(isDependencyTestPath("package/fixtures/schema.json")).toBe(false);
  });

  test("selects reproducibly downloaded host tools from electron-builder", async () => {
    const calls: string[] = [];
    const tools = await resolveElectronBuilderTools(
      "win32",
      async () => {
        calls.push("7zip");
        return "C:\\cache\\7zip@1.0.0\\bin\\7za.exe";
      },
      async (version) => {
        calls.push(`nsis@${version}`);
        return { path: "C:\\cache\\nsis@1.2.1\\makensis.cmd" };
      },
    );
    expect(calls).toEqual(["7zip", "nsis@1.2.1"]);
    expect(tools).toEqual({
      sevenZip: "C:\\cache\\7zip@1.0.0\\bin\\7za.exe",
      makensis: "C:\\cache\\nsis@1.2.1\\windows\\makensis.exe",
      makensisEnv: { NSISDIR: "C:\\cache\\nsis@1.2.1\\windows" },
    });
  });

  test("requires Windows x64 native dependencies and rejects Linux payloads", () => {
    expect(() =>
      assertWindowsDependencyPaths([
        "node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/codex.exe",
        "node_modules/@img/sharp-win32-x64/lib/sharp-win32-x64.node",
        "node_modules/@napi-rs/canvas-win32-x64-msvc/skia.win32-x64-msvc.node",
      ]),
    ).not.toThrow();

    expect(() =>
      assertWindowsDependencyPaths([
        "node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/codex.exe",
        "node_modules/@img/sharp-win32-x64/lib/sharp-win32-x64.node",
        "node_modules/@napi-rs/canvas-win32-x64-msvc/skia.win32-x64-msvc.node",
        "node_modules/@openai/codex-linux-arm64/vendor/aarch64-unknown-linux-gnu/codex",
      ]),
    ).toThrow("host-native dependency");
  });

  test("installer stages and validates a complete payload before replacing an owned install", () => {
    const template = readFileSync(join(nsisRoot, "installer.nsi"), "utf8");
    expect(() => validateInstallerTemplate(template)).not.toThrow();
    expect(template).toContain(`!define OWNERSHIP_MARKER "${OWNERSHIP_MARKER}"`);
    expect(template).toContain('StrCpy $R8 "$INSTDIR.installing"');
    expect(template).toContain('IfFileExists "$R8\\resources\\app.asar"');
    expect(template).toContain('IfFileExists "$R8\\resources\\."');
  });

  test("checks rollback Rename and reports restoration failure as a distinct fatal state", () => {
    const template = readFileSync(join(nsisRoot, "installer.nsi"), "utf8");
    expect(template).toContain('Rename "$R9" "$INSTDIR"\n    IfErrors rollback_failed');
    expect(template).toContain("rollback_failed:");
    expect(template).toContain("기존 설치가 복원되지 않았습니다");
    expect(() => validateInstallerTemplate(template)).not.toThrow();
  });

  test("recovers an interrupted previous install before staging and never deletes it early", () => {
    const template = readFileSync(join(nsisRoot, "installer.nsi"), "utf8");
    const inspectPrevious = template.indexOf("inspect_previous:");
    const createStaging = template.indexOf("create_staging:");
    const payloadValid = template.indexOf("payload_valid:");
    const removePrevious = template.indexOf("remove_previous:");
    expect(template).toContain('Rename "$R9" "$INSTDIR"\n    IfErrors previous_recovery_failed');
    expect(inspectPrevious).toBeGreaterThan(0);
    expect(createStaging).toBeGreaterThan(inspectPrevious);
    expect(removePrevious).toBeGreaterThan(payloadValid);
  });

  test("requires a zero Windows 7za exit before validating or replacing files", () => {
    const template = readFileSync(join(nsisRoot, "installer.nsi"), "utf8");
    const extraction = template.indexOf("nsExec::ExecToStack");
    const exitCheck = template.indexOf('StrCmp $R1 "0" extraction_succeeded extraction_failed');
    const replaceExisting = template.indexOf("replace_existing:");
    expect(template).toContain(`File /oname=7za.exe "${nsisSevenZipReference}"`);
    expect(template).not.toContain("Nsis7z::Extract");
    expect(exitCheck).toBeGreaterThan(extraction);
    expect(exitCheck).toBeLessThan(replaceExisting);
  });

  test("installer validation rejects deletion without ownership and incomplete validation", () => {
    expect(() =>
      validateInstallerTemplate(`
Section
  StrCpy $INSTDIR "${FIXED_INSTALL_DIR}"
  RMDir /r "$INSTDIR"
SectionEnd
`),
    ).toThrow("ownership marker");
  });

  test("uninstall refuses foreign directories before changing shortcuts or registration", () => {
    const template = readFileSync(join(nsisRoot, "uninstall.nsi"), "utf8");
    expect(() => validateUninstallerTemplate(template)).not.toThrow();
    const markerCheck = template.indexOf(`IfFileExists "$INSTDIR\\${nsisMarkerReference}"`);
    expect(markerCheck).toBeGreaterThan(0);
    expect(markerCheck).toBeLessThan(template.indexOf('Delete "$DESKTOP'));
    expect(markerCheck).toBeLessThan(template.indexOf('RMDir /r "$INSTDIR"'));
    expect(template).not.toContain("$APPDATA");
  });

  test("publishes only the owned regular installer as mode 0600 across path races", () => {
    const root = mkdtempSync(join(tmpdir(), "haksul-private-artifact-"));
    try {
      const setup = join(root, "setup.exe");
      writeFileSync(setup, "installer", { mode: 0o644 });
      securePrivateArtifact(setup);
      expect(lstatSync(setup).mode & 0o777).toBe(0o600);

      const target = join(root, "target.exe");
      writeFileSync(target, "target", { mode: 0o600 });
      rmSync(setup);
      symlinkSync(target, setup);
      expect(() => securePrivateArtifact(setup)).toThrow("regular non-symlink");

      rmSync(setup);
      writeFileSync(setup, "installer", { mode: 0o644 });
      expect(() =>
        securePrivateArtifact(setup, () => {
          const replacement = join(root, "replacement.exe");
          writeFileSync(replacement, "replacement", { mode: 0o644 });
          renameSync(replacement, setup);
        }),
      ).toThrow("identity changed");
      expect(lstatSync(setup).mode & 0o777).toBe(0o644);
    } finally {
      chmodSync(root, 0o700);
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("release report explicitly identifies private unsigned checksum artifacts", () => {
    expect(privateUnsignedReleaseReport("setup.exe", 42, "abc")).toEqual({
      artifact: "setup.exe",
      bytes: 42,
      signed: false,
      distribution: "private",
      checksum: { algorithm: "sha256", digest: "abc", artifact: "setup.exe.sha256" },
    });
  });
});
