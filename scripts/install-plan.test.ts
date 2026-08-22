import { describe, expect, test } from "bun:test";
import { createInstallPlan } from "./install-plan.ts";

describe("plugin install plan", () => {
  test("builds official local Claude and Codex commands", () => {
    const plan = createInstallPlan("/workspace/haksulsomoim", "/workspace/haksulsomoim/plugin");
    expect(plan.claude).toEqual(["claude", "--plugin-dir", "/workspace/haksulsomoim/plugin"]);
    expect(plan.codex).toEqual([
      ["codex", "plugin", "marketplace", "add", "/workspace/haksulsomoim"],
      ["codex", "plugin", "add", "haksulsomoim-small-fraud@haksulsomoim-local"],
    ]);
  });
});
