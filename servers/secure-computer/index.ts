import { randomBytes, randomUUID } from "node:crypto";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createLocalKorEngOcr } from "./local-ocr";
import { createSecureComputerMcpServer, type SecureComputerPort } from "./mcp-server";
import { PlaywrightSecureBrowser } from "./playwright-browser";
import { Redactor } from "./redaction";
import { SecureComputerService } from "./secure-computer-service";

export type { SecureComputerPort } from "./mcp-server";

export interface SecureComputerRuntimeOptions {
  readonly allowedHosts: readonly string[];
  readonly caseId: string;
  readonly redactionKey: Uint8Array;
  readonly maxActions?: number;
  readonly executablePath?: string;
  readonly headless?: boolean;
  readonly viewport?: Readonly<{ width: number; height: number }>;
}

export const createSecureComputerRuntime = async (
  options: SecureComputerRuntimeOptions,
): Promise<SecureComputerPort> => {
  const ocr = await createLocalKorEngOcr();
  const browser = new PlaywrightSecureBrowser({
    ocr,
    allowedHosts: options.allowedHosts,
    ...(options.executablePath === undefined ? {} : { executablePath: options.executablePath }),
    ...(options.headless === undefined ? {} : { headless: options.headless }),
    ...(options.viewport === undefined ? {} : { viewport: options.viewport }),
  });
  return new SecureComputerService({
    browser,
    caseId: options.caseId,
    redactor: new Redactor(options.redactionKey),
    allowedHosts: options.allowedHosts,
    maxActions: options.maxActions ?? 64,
  });
};

const runtimeOptionsFromEnvironment = (): SecureComputerRuntimeOptions => {
  const allowedHosts = (process.env.HAKSUL_SECURE_COMPUTER_HOSTS ?? "ecfs.scourt.go.kr")
    .split(",")
    .map((host) => host.trim())
    .filter((host) => host.length > 0);
  const executablePath = process.env.HAKSUL_BROWSER_EXECUTABLE;
  return {
    allowedHosts,
    caseId: process.env.HAKSUL_SECURE_COMPUTER_CASE_ID ?? randomUUID(),
    redactionKey: randomBytes(32),
    ...(executablePath === undefined ? {} : { executablePath }),
    headless: process.env.HAKSUL_BROWSER_HEADLESS === "true",
  };
};

export const runSecureComputerStdio = async (
  options: SecureComputerRuntimeOptions = runtimeOptionsFromEnvironment(),
): Promise<void> => {
  const computer = await createSecureComputerRuntime(options);
  const server = createSecureComputerMcpServer(computer);
  let closing = false;
  const close = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    await computer.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  };
  process.once("SIGINT", () => void close().finally(() => process.exit(0)));
  process.once("SIGTERM", () => void close().finally(() => process.exit(0)));
  await server.connect(
    new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 5_000_000 }),
  );
};
