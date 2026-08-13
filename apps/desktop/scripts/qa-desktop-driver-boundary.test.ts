import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import ts from "typescript";

const drivers = [
  "qa-desktop.ts",
  "qa-desktop-agent.ts",
  "qa-desktop-resume.ts",
  "qa-desktop-unresolved-tool.ts",
] as const;
const hiddenBridge =
  /\b(?:ipcRenderer|evaluateHandle|addInitScript|exposeFunction|exposeBinding)\b/u;
const rendererBridge = /\bwindow\s*(?:\.\s*haksul|\[\s*["']haksul["']\s*\])/u;
const lifecycleInEvaluation =
  /\b(?:localStorage|openAgentCase|startAgentRun|listAgentRuns|pauseAgentRun|resumeAgentRun|cancelAgentRun|decideAgentApproval|subscribeAgentRun)\b/u;

function evaluatedLifecycleCalls(source: string, filename: string): string[] {
  const file = ts.createSourceFile(
    filename,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const rejected: string[] = [];
  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "evaluate" &&
      lifecycleInEvaluation.test(node.getText(file))
    ) {
      rejected.push(node.getText(file));
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return rejected;
}

describe("standard F3 desktop QA driver boundary", () => {
  for (const driver of drivers) {
    test(`${driver} never invokes renderer lifecycle bridges`, async () => {
      const source = await readFile(resolve(import.meta.dirname, driver), "utf8");
      expect(source.match(hiddenBridge)).toBeNull();
      expect(source.match(rendererBridge)).toBeNull();
      expect(evaluatedLifecycleCalls(source, driver)).toEqual([]);
    });
  }
});
