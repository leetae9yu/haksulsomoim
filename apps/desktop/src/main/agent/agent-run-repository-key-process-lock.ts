import { createHash } from "node:crypto";
import { createConnection, createServer, type Server, type Socket } from "node:net";

const LOCK_WAIT_TIMEOUT_MS = 5_000;

function isNodeError(error: unknown, ...codes: string[]): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    codes.includes(error.code)
  );
}

function lockEndpoint(canonicalDirectory: string): string {
  const token = createHash("sha256").update(canonicalDirectory).digest("hex");
  return process.platform === "win32"
    ? `\\\\.\\pipe\\haksulsomoim-agent-key-${token}`
    : `\0haksulsomoim-agent-key-${token}`;
}

async function listen(server: Server, endpoint: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const failed = (error: Error): void => {
      server.off("listening", ready);
      reject(error);
    };
    const ready = (): void => {
      server.off("error", failed);
      resolve();
    };
    server.once("error", failed);
    server.once("listening", ready);
    server.listen(endpoint);
  });
}

async function waitForOwner(endpoint: string): Promise<void> {
  const signal = AbortSignal.timeout(LOCK_WAIT_TIMEOUT_MS);
  const socket = createConnection(endpoint);
  try {
    await new Promise<void>((resolve, reject) => {
      const finish = (outcome: () => void): void => {
        signal.removeEventListener("abort", aborted);
        outcome();
      };
      const aborted = (): void => finish(() => reject(signal.reason));
      signal.addEventListener("abort", aborted, { once: true });
      socket.once("close", () => finish(resolve));
      socket.once("error", (error) => {
        if (isNodeError(error, "ECONNREFUSED", "ENOENT")) finish(resolve);
        else finish(() => reject(error));
      });
    });
  } finally {
    socket.destroy();
  }
}

async function closeServer(server: Server, sockets: Set<Socket>): Promise<void> {
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

export async function withAgentRepositoryKeyProcessLock<T>(
  canonicalDirectory: string,
  operation: () => Promise<T>,
): Promise<T> {
  const endpoint = lockEndpoint(canonicalDirectory);
  while (true) {
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    try {
      await listen(server, endpoint);
    } catch (error) {
      if (!isNodeError(error, "EADDRINUSE")) throw error;
      await waitForOwner(endpoint);
      continue;
    }
    try {
      return await operation();
    } finally {
      await closeServer(server, sockets);
    }
  }
}
