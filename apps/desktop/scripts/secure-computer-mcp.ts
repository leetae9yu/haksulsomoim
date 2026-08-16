import { randomBytes, randomUUID } from "node:crypto";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createLocalKorEngOcr } from "../src/ocr/tesseract-recognizer";
import { createSecureComputerMcpServer } from "../src/secure-computer/mcp-server";
import { PlaywrightSecureBrowser } from "../src/secure-computer/playwright-browser";
import { SecureComputerService } from "../src/secure-computer/secure-computer-service";
import { Redactor } from "../src/security/redaction";

const allowedHosts = (process.env.HAKSUL_SECURE_COMPUTER_HOSTS ?? "ecfs.scourt.go.kr")
  .split(",")
  .map((host) => host.trim())
  .filter((host) => host.length > 0);
const ocr = await createLocalKorEngOcr();
const executablePath = process.env.HAKSUL_BROWSER_EXECUTABLE;
const browser = new PlaywrightSecureBrowser({
  ocr,
  allowedHosts,
  headless: process.env.HAKSUL_BROWSER_HEADLESS === "true",
  ...(executablePath === undefined ? {} : { executablePath }),
});
const computer = new SecureComputerService({
  browser,
  caseId: process.env.HAKSUL_SECURE_COMPUTER_CASE_ID ?? randomUUID(),
  redactor: new Redactor(randomBytes(32)),
  allowedHosts,
  maxActions: 64,
});
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
