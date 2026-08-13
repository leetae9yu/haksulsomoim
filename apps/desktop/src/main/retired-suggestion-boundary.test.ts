import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { IPC_CHANNELS } from "../contracts/ipc-channels";
import { createDesktopPreloadApi } from "../preload";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const productionSurfaces = [
  "src/contracts/desktop-api.ts",
  "src/contracts/ipc-channels.ts",
  "src/preload/index.ts",
  "src/main/ipc-register.ts",
  "src/main/ipc-handlers.ts",
  "src/main/runtime-case-service.ts",
  "src/integrations/agent-provider/agent-provider.ts",
] as const;

describe("retired suggestion boundary", () => {
  test("does not expose or register the retired outbound suggestion capability", async () => {
    const api = createDesktopPreloadApi({
      invoke: async () => ({}),
      send: () => undefined,
      on: () => undefined,
      removeListener: () => undefined,
    });
    expect("codexSuggestion" in api).toBe(false);
    expect("codexSuggestion" in IPC_CHANNELS).toBe(false);
    expect(Object.values(IPC_CHANNELS)).not.toContain("codex:suggestion");

    const sources = await Promise.all(
      productionSurfaces.map((path) => readFile(join(testDirectory, "../..", path), "utf8")),
    );
    expect(sources.join("\n")).not.toContain("codexSuggestion");
  });
});
