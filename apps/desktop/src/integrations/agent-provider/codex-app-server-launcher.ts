import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join } from "node:path";
import { sanitizeSecret } from "../../security/redaction";
import { JsonLineConnection } from "./codex-app-server-connection";
import type { CodexAppServerLauncher, CodexJsonLineProcess } from "./codex-app-server-protocol";
import { spawnCodexProcess } from "./codex-process";

export type { CodexJsonLineProcess } from "./codex-app-server-protocol";

export type CodexProcessFactory = (
  command: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
) => Promise<CodexJsonLineProcess>;

export interface LaunchCodexAppServerOptions {
  command?: string;
  processFactory?: CodexProcessFactory;
  resolveExecutable?: () => string;
  environment?: Readonly<Record<string, string | undefined>>;
  onNotificationError?: (error: Error) => void;
}

const CODEX_ENV_ALLOWLIST = [
  "APPDATA",
  "CODEX_HOME",
  "HOME",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "LANG",
  "LC_ALL",
  "LOCALAPPDATA",
  "NO_PROXY",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "USERPROFILE",
] as const;

const PLATFORM_TARGETS: Readonly<
  Record<string, Readonly<{ packageName: string; triple: string; executable: string }>>
> = {
  "darwin-arm64": {
    packageName: "@openai/codex-darwin-arm64",
    triple: "aarch64-apple-darwin",
    executable: "codex",
  },
  "darwin-x64": {
    packageName: "@openai/codex-darwin-x64",
    triple: "x86_64-apple-darwin",
    executable: "codex",
  },
  "linux-arm64": {
    packageName: "@openai/codex-linux-arm64",
    triple: "aarch64-unknown-linux-musl",
    executable: "codex",
  },
  "linux-x64": {
    packageName: "@openai/codex-linux-x64",
    triple: "x86_64-unknown-linux-musl",
    executable: "codex",
  },
  "win32-arm64": {
    packageName: "@openai/codex-win32-arm64",
    triple: "aarch64-pc-windows-msvc",
    executable: "codex.exe",
  },
  "win32-x64": {
    packageName: "@openai/codex-win32-x64",
    triple: "x86_64-pc-windows-msvc",
    executable: "codex.exe",
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function allowlistedEnvironment(
  source: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const name of CODEX_ENV_ALLOWLIST) {
    const value = source[name];
    if (value !== undefined && value.length > 0 && !value.startsWith("()")) {
      environment[name] = value;
    }
  }
  return environment;
}

export function resolveCodexExecutable(): string {
  const target = PLATFORM_TARGETS[`${process.platform}-${process.arch}`];
  if (target === undefined) {
    throw Object.assign(new Error("The official Codex binary is unavailable on this platform"), {
      code: "ENOENT",
    });
  }

  const require = createRequire(import.meta.url);
  let packageJson: string;
  try {
    packageJson = require.resolve(`${target.packageName}/package.json`);
  } catch {
    throw Object.assign(new Error("The packaged official Codex binary is unavailable"), {
      code: "ENOENT",
    });
  }
  const executable = join(dirname(packageJson), "vendor", target.triple, "bin", target.executable);
  const unpackedExecutable = executable.replace("app.asar", "app.asar.unpacked");
  const resolved = [unpackedExecutable, executable].find((candidate) => existsSync(candidate));
  if (resolved === undefined) {
    throw Object.assign(new Error("The packaged official Codex binary is unavailable"), {
      code: "ENOENT",
    });
  }
  return resolved;
}

export const launchCodexAppServer = (
  options: LaunchCodexAppServerOptions = {},
): ReturnType<CodexAppServerLauncher> => {
  const sourceEnvironment = options.environment ?? process.env;
  const sanitizeError = (message: string): string =>
    sanitizeSecret(message, sourceEnvironment.LAW_OC);
  const processFactory = options.processFactory ?? spawnCodexProcess;
  const reportNotificationError =
    options.onNotificationError ??
    ((error: Error) => console.error("Codex notification listener failed", error));

  return Promise.resolve()
    .then(() => {
      const command = options.command ?? (options.resolveExecutable ?? resolveCodexExecutable)();
      if (!isAbsolute(command)) {
        throw new TypeError("Codex executable must be an explicit absolute path");
      }
      return processFactory(
        command,
        ["app-server", "--stdio"],
        allowlistedEnvironment(sourceEnvironment),
      );
    })
    .then((process) => ({
      status: "ready" as const,
      connection: new JsonLineConnection(process, sanitizeError, reportNotificationError),
    }))
    .catch((error: unknown) => {
      if (isRecord(error) && error.code === "ENOENT") {
        return {
          status: "binary-unavailable" as const,
          reason: "The official Codex app-server binary is unavailable",
        };
      }
      if (error instanceof Error) throw new Error(sanitizeError(error.message));
      throw new Error("Failed to launch the official Codex app-server binary");
    });
};
