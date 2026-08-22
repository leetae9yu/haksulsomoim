import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validatePluginRoot } from "./plugin-validation.ts";

const roots: string[] = [];

async function fixture(skillFrontmatter: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "haksul-plugin-validation-"));
  roots.push(root);
  await mkdir(join(root, ".claude-plugin"), { recursive: true });
  await mkdir(join(root, ".codex-plugin"), { recursive: true });
  await mkdir(join(root, "config"), { recursive: true });
  await mkdir(join(root, "skills", "small-fraud"), { recursive: true });
  await writeFile(
    join(root, ".claude-plugin", "plugin.json"),
    JSON.stringify({
      name: "small-fraud",
      skills: "./skills/",
      mcpServers: "./config/claude.json",
    }),
  );
  await writeFile(
    join(root, ".codex-plugin", "plugin.json"),
    JSON.stringify({
      name: "small-fraud",
      version: "0.1.0",
      description: "Small fraud",
      skills: "./skills/",
      mcpServers: "./config/codex.json",
    }),
  );
  const mcp = JSON.stringify({
    mcpServers: { local: { command: "bun", args: ["run", "servers/index.ts"] } },
  });
  await writeFile(join(root, "config", "claude.json"), mcp);
  await writeFile(join(root, "config", "codex.json"), mcp);
  await writeFile(join(root, "skills", "small-fraud", "SKILL.md"), skillFrontmatter);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("plugin validation", () => {
  test("accepts matching Claude and Codex manifests with a valid skill", async () => {
    const root = await fixture("---\nname: small-fraud\ndescription: Handle small fraud\n---\n");
    await expect(validatePluginRoot(root)).resolves.toEqual({
      pluginName: "small-fraud",
      skillNames: ["small-fraud"],
      mcpServerNames: ["local"],
    });
  });

  test("rejects a skill without required Codex frontmatter", async () => {
    const root = await fixture("---\ndescription: Missing name\n---\n");
    await expect(validatePluginRoot(root)).rejects.toThrow("Skill name is required");
  });
});
