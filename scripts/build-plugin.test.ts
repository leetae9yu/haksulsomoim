import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildPlugin } from "./build-plugin.ts";
import { validatePluginRoot } from "./plugin-validation";

const outputs: string[] = [];

afterEach(async () => {
  await Promise.all(outputs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("distributable plugin build", () => {
  test("contains only plugin runtime, skills, manifests, config, and hooks", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "haksul-plugin-build-"));
    outputs.push(outputRoot);
    await buildPlugin(resolve("."), outputRoot);
    expect((await readdir(outputRoot)).sort()).toEqual([
      ".claude-plugin",
      ".codex-plugin",
      "config",
      "hooks",
      "package.json",
      "servers",
      "skills",
    ]);
    await expect(validatePluginRoot(outputRoot)).resolves.toMatchObject({
      pluginName: "haksulsomoim-small-fraud",
    });
  });
});
