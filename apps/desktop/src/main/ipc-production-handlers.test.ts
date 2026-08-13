import { describe, expect, test } from "bun:test";
import { type AgentLifecycleService, createDesktopHandlers } from "./ipc-handlers";
import type { CaseRuntimeService } from "./runtime-case-service";

const lifecycle = {
  openCase: async () => ({}),
  openArtifact: async () => ({}),
  start: async () => ({}),
  get: async () => ({}),
  list: async () => [],
  pause: async () => ({}),
  resume: async () => ({}),
  cancel: async () => ({}),
  decideApproval: async () => ({ status: "recorded" as const, run: {} }),
  subscribe: () => () => undefined,
} satisfies AgentLifecycleService;

describe("production desktop handler composition", () => {
  test("composes the complete Agent lifecycle into the production handler surface", () => {
    const handlers = createDesktopHandlers({} as CaseRuntimeService, lifecycle);
    const lifecycleMethods = [
      "openAgentCase",
      "openAgentArtifact",
      "startAgentRun",
      "getAgentRun",
      "listAgentRuns",
      "pauseAgentRun",
      "resumeAgentRun",
      "cancelAgentRun",
      "decideAgentApproval",
      "subscribeAgentRun",
    ] as const;

    expect(lifecycleMethods.filter((name) => typeof handlers[name] === "function")).toHaveLength(
      10,
    );
  });
});
