import { validatePluginRoot } from "./plugin-validation";

const root = process.argv[2] ?? ".";

try {
  const summary = await validatePluginRoot(root);
  process.stdout.write(`${JSON.stringify({ status: "PASS", ...summary })}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${JSON.stringify({ status: "FAIL", message })}\n`);
  process.exitCode = 1;
}
