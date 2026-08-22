import { readdir, readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { z } from "zod";

const relativePath = z
  .string()
  .startsWith("./")
  .refine((value) => !value.split("/").includes(".."), "Plugin paths cannot escape the root");

const manifestSchema = z
  .strictObject({
    name: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    version: z
      .string()
      .regex(/^\d+\.\d+\.\d+$/)
      .optional(),
    description: z.string().min(1).optional(),
    author: z.strictObject({ name: z.string().min(1) }).optional(),
    repository: z.url().optional(),
    keywords: z.array(z.string().min(1)).optional(),
    skills: relativePath.optional(),
    mcpServers: relativePath.optional(),
    hooks: relativePath.optional(),
  })
  .refine(
    (value) => value.version !== undefined || value.description === undefined,
    "A described distributable manifest requires a version",
  );

const mcpServerSchema = z.strictObject({
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
});

const mcpConfigSchema = z.strictObject({
  mcpServers: z.record(z.string().min(1), mcpServerSchema),
});

interface SkillMetadata {
  readonly name: string;
  readonly description: string;
}

function parseFrontmatter(source: string, path: string): SkillMetadata {
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/u.exec(source);
  if (match === null) throw new TypeError(`Skill frontmatter is required: ${path}`);
  const values = new Map<string, string>();
  for (const line of (match[1] ?? "").split("\n")) {
    const separator = line.indexOf(":");
    if (separator < 1) continue;
    values.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  const name = values.get("name");
  const description = values.get("description");
  if (name === undefined || name === "") throw new TypeError(`Skill name is required: ${path}`);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name)) {
    throw new TypeError(`Skill name must be kebab-case: ${path}`);
  }
  if (description === undefined || description === "") {
    throw new TypeError(`Skill description is required: ${path}`);
  }
  return { name, description };
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

function inside(root: string, path: string): string {
  const resolved = resolve(root, path);
  if (resolved !== root && !resolved.startsWith(`${root}${sep}`)) {
    throw new TypeError(`Plugin path escapes root: ${path}`);
  }
  return resolved;
}

export interface PluginValidationSummary {
  readonly pluginName: string;
  readonly skillNames: readonly string[];
  readonly mcpServerNames: readonly string[];
}

export async function validatePluginRoot(rootInput: string): Promise<PluginValidationSummary> {
  const root = resolve(rootInput);
  const claude = manifestSchema.parse(await readJson(join(root, ".claude-plugin", "plugin.json")));
  const codex = manifestSchema.parse(await readJson(join(root, ".codex-plugin", "plugin.json")));
  if (claude.name !== codex.name) throw new TypeError("Claude and Codex plugin names must match");
  if (codex.version === undefined || codex.description === undefined) {
    throw new TypeError("Codex manifest requires version and description");
  }

  const skillRoot = inside(root, codex.skills ?? "./skills/");
  const skillNames: string[] = [];
  for (const entry of await readdir(skillRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const metadata = parseFrontmatter(
      await readFile(join(skillRoot, entry.name, "SKILL.md"), "utf8"),
      entry.name,
    );
    if (metadata.name !== entry.name) {
      throw new TypeError(`Skill directory and name differ: ${entry.name}`);
    }
    skillNames.push(metadata.name);
  }
  if (skillNames.length === 0) throw new TypeError("At least one skill is required");

  const claudeMcp = mcpConfigSchema.parse(
    await readJson(inside(root, claude.mcpServers ?? "./.mcp.json")),
  );
  const codexMcp = mcpConfigSchema.parse(
    await readJson(inside(root, codex.mcpServers ?? "./.mcp.json")),
  );
  const claudeNames = Object.keys(claudeMcp.mcpServers).sort();
  const codexNames = Object.keys(codexMcp.mcpServers).sort();
  if (JSON.stringify(claudeNames) !== JSON.stringify(codexNames)) {
    throw new TypeError("Claude and Codex MCP server names must match");
  }
  return { pluginName: codex.name, skillNames: skillNames.sort(), mcpServerNames: codexNames };
}
