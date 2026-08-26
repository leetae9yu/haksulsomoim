import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const summarySchema = z.record(z.string(), z.number().int().nonnegative());
export type CliResult = Readonly<{ exitCode: number; summary: Readonly<Record<string, number>> }>;

export function runCorpus(path?: string): CliResult {
  const result = spawnSync("bun", ["run", "qa:wiki", ...(path === undefined ? [] : [path])], {
    cwd: `${import.meta.dir}/..`,
    encoding: "utf8",
  });
  const parsed = summarySchema.parse(JSON.parse(result.stdout.trim()));
  return { exitCode: result.status ?? 1, summary: parsed };
}

export function runFixture(name: string): CliResult {
  return runCorpus(`fixtures/${name}`);
}

export function withPublicWiki(mutate: (path: string) => void): CliResult {
  const path = mkdtempSync(join(tmpdir(), "qa-wiki-public-"));
  try {
    cpSync(join(import.meta.dir, "..", "wiki"), path, { recursive: true });
    mutate(path);
    return runCorpus(path);
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
}
