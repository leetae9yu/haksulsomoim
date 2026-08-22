import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInstallPlan } from "./install-plan";
import { validatePluginRoot } from "./plugin-validation";

type Target = "claude" | "codex" | "both";

function option(name: string): string | undefined {
  const prefix = `${name}=`;
  return process.argv
    .slice(2)
    .find((value) => value.startsWith(prefix))
    ?.slice(prefix.length);
}

function target(): Target {
  const value = option("--target") ?? "both";
  if (value === "claude" || value === "codex" || value === "both") return value;
  throw new TypeError("--target must be claude, codex, or both");
}

async function run(command: readonly string[]): Promise<void> {
  const process_ = Bun.spawn([...command], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await process_.exited;
  if (exitCode !== 0) throw new Error(`${command[0]} exited with ${exitCode}`);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pluginRoot = resolve(root, "plugin");
const selected = target();
const apply = process.argv.includes("--apply");
const validation = await validatePluginRoot(pluginRoot);
const plan = createInstallPlan(root, pluginRoot);

if (apply && (selected === "codex" || selected === "both")) {
  for (const command of plan.codex) await run(command);
}

process.stdout.write(
  `${JSON.stringify({
    status: "PASS",
    target: selected,
    applied: apply,
    plugin: validation.pluginName,
    claudeLaunch: selected === "codex" ? undefined : plan.claude,
    codexCommands: selected === "claude" ? undefined : plan.codex,
  })}\n`,
);
