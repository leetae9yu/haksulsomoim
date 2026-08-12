import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { CodexJsonLineProcess } from "./codex-app-server-protocol";

export async function spawnCodexProcess(
  command: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
): Promise<CodexJsonLineProcess> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const handleError = (error: Error) => reject(error);
    child.once("error", handleError);
    child.once("spawn", () => {
      child.off("error", handleError);
      const lines = createInterface({ input: child.stdout });
      const lineListeners = new Set<(line: string) => void>();
      const exitListeners = new Set<(error?: Error) => void>();
      let exited = false;
      let resolveClosed: () => void = () => undefined;
      const closed = new Promise<void>((resolveClosedPromise) => {
        resolveClosed = resolveClosedPromise;
      });
      const complete = (error?: Error): void => {
        if (exited) return;
        exited = true;
        for (const listener of exitListeners) listener(error);
        resolveClosed();
      };
      lines.on("line", (line) => {
        for (const listener of lineListeners) listener(line);
      });
      child.once("error", complete);
      child.once("exit", () => complete());
      child.stderr.resume();
      resolve({
        send(line) {
          if (!child.stdin.write(line)) {
            throw new Error("Codex app-server stdin is not writable");
          }
        },
        onLine(listener) {
          lineListeners.add(listener);
          return () => lineListeners.delete(listener);
        },
        onExit(listener) {
          exitListeners.add(listener);
          return () => exitListeners.delete(listener);
        },
        async close() {
          lines.close();
          child.stdin.end();
          if (!child.killed) child.kill();
          let forceKill: ReturnType<typeof setTimeout> | undefined;
          let rejectClose: ReturnType<typeof setTimeout> | undefined;
          const timeout = new Promise<never>((_resolve, rejectTimeout) => {
            forceKill = setTimeout(() => {
              if (!exited) child.kill("SIGKILL");
            }, 1_500);
            rejectClose = setTimeout(
              () => rejectTimeout(new Error("Timed out closing Codex app-server")),
              5_000,
            );
          });
          try {
            await Promise.race([closed, timeout]);
          } finally {
            if (forceKill !== undefined) clearTimeout(forceKill);
            if (rejectClose !== undefined) clearTimeout(rejectClose);
          }
        },
      });
    });
  });
}
