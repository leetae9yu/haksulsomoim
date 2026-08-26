import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Finding } from "./qa-wiki-literal-audit-support.ts";
import { auditSource } from "./qa-wiki-literal-audit-support.ts";

export type Audit = Readonly<{
  files: readonly string[];
  literals: readonly Finding[];
  expectations: readonly Finding[];
  unknown: readonly Finding[];
}>;

type SourceInput = Readonly<Record<string, string>>;

function sourceFiles(): SourceInput {
  const directory = import.meta.dir;
  const names = readdirSync(directory).filter(
    (name) =>
      /^qa-wiki.*\.test\.ts$/.test(name) ||
      name === "qa-wiki-literal-audit.ts" ||
      /^qa-wiki.*-support\.ts$/.test(name),
  );
  return Object.fromEntries(
    names.toSorted().map((name) => [name, readFileSync(join(directory, name), "utf8")]),
  );
}

export function auditSources(inputs: SourceInput): Audit {
  const literals: Finding[] = [];
  const expectations: Finding[] = [];
  const unknown: Finding[] = [];
  for (const [file, content] of Object.entries(inputs).toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const audit = auditSource(file, content);
    literals.push(...audit.literals);
    expectations.push(...audit.expectations);
    unknown.push(...audit.unknown);
  }
  return { files: Object.keys(inputs).toSorted(), literals, expectations, unknown };
}

if (import.meta.main) {
  const audit = auditSources(sourceFiles());
  if (audit.unknown.length > 0)
    throw new Error(`Unjustified numeric contract: ${JSON.stringify(audit.unknown)}`);
  /** @qa-literal immutable-contract */
  const jsonIndent = 2;
  console.log(JSON.stringify(audit, null, jsonIndent));
}
