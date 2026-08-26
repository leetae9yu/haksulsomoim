import { readdir } from "node:fs/promises";
import { basename, extname, join, relative, sep } from "node:path";
import { z } from "zod";
import { legacySchemas } from "./qa-wiki-contract.ts";
import { ledgerRecordSchema } from "./qa-wiki-records.ts";

export type ParsedCorpus = Readonly<{
  files: readonly Readonly<{ path: string; content: string }>[];
  records: readonly z.infer<typeof ledgerRecordSchema>[];
  malformedInputs: number;
  overlongExcerpts: number;
  frontmatterKeysetMismatches: number;
  newFrontmatterKeys: number;
}>;

const frontmatterSchema = z.record(z.string(), z.unknown());
const frontmatterPattern = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/;

async function markdownFiles(directory: string): Promise<readonly string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) paths.push(...(await markdownFiles(path)));
    if (entry.isFile() && extname(entry.name) === ".md") paths.push(path);
  }
  return paths.toSorted();
}

function incrementFrontmatterErrors(
  value: unknown,
  expectedKeys: readonly string[],
): Readonly<{ mismatch: number; newKeys: number }> {
  const parsed = frontmatterSchema.safeParse(value);
  if (!parsed.success) return { mismatch: 1, newKeys: 0 };
  const keys = Object.keys(parsed.data);
  const newKeys = keys.filter((key) => !expectedKeys.includes(key)).length;
  return { mismatch: Number(newKeys > 0 || keys.length !== expectedKeys.length), newKeys };
}

function legacyKind(value: unknown): "P" | "R" | "index" | undefined {
  const parsed = frontmatterSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const id = parsed.data.id;
  if (typeof id !== "string") return undefined;
  if (/^P/.test(id)) return "P";
  if (/^R/.test(id)) return "R";
  if (id === "INDEX-0001") return "index";
  return undefined;
}

function expectedLegacyKind(path: string): "P" | "R" | "index" | undefined {
  const stem = basename(path, ".md");
  if (/^P(?:10|[1-9])_/.test(stem)) return "P";
  if (/^R(?:10|[1-9])_/.test(stem)) return "R";
  if (stem === "전체_사례_목록") return "index";
  return undefined;
}

function parseLegacy(
  path: string,
  content: string,
): Readonly<{ malformed: number; mismatch: number; newKeys: number }> {
  const expected = expectedLegacyKind(path);
  const match = frontmatterPattern.exec(content);
  if (!match) return { malformed: 0, mismatch: Number(expected !== undefined), newKeys: 0 };
  const [, yaml] = match;
  if (yaml === undefined)
    return { malformed: 0, mismatch: Number(expected !== undefined), newKeys: 0 };
  try {
    const parsedYaml = Bun.YAML.parse(yaml);
    const kind = expected ?? legacyKind(parsedYaml);
    if (kind === undefined) return { malformed: 0, mismatch: 0, newKeys: 0 };
    const schema = legacySchemas[kind];
    const keyErrors = incrementFrontmatterErrors(parsedYaml, Object.keys(schema.shape));
    const schemaValid = schema.safeParse(parsedYaml).success;
    return {
      malformed: 0,
      mismatch: Math.max(keyErrors.mismatch, Number(!schemaValid)),
      newKeys: keyErrors.newKeys,
    };
  } catch (error) {
    if (error instanceof Error)
      return { malformed: 0, mismatch: Number(expected !== undefined), newKeys: 0 };
    throw error;
  }
}

function jsonlBlocks(content: string): readonly string[] {
  return [...content.matchAll(/```jsonl\r?\n([\s\S]*?)```/g)].map((match) => match[1] ?? "");
}

function parseLedger(content: string): Readonly<{
  records: readonly z.infer<typeof ledgerRecordSchema>[];
  malformed: number;
  overlong: number;
}> {
  const blocks = jsonlBlocks(content);
  if (blocks.length !== 1) return { records: [], malformed: 1, overlong: 0 };
  const block = blocks[0];
  if (block === undefined) return { records: [], malformed: 1, overlong: 0 };
  const records: z.infer<typeof ledgerRecordSchema>[] = [];
  let malformed = 0;
  let overlong = 0;
  for (const line of block.split(/\r?\n/).filter((value) => value.trim().length > 0)) {
    try {
      const raw = JSON.parse(line);
      const rawRecord = frontmatterSchema.safeParse(raw);
      const excerpt = rawRecord.success ? rawRecord.data.excerpt : undefined;
      if (typeof excerpt === "string" && [...excerpt].length > 500) overlong += 1;
      const parsed = ledgerRecordSchema.safeParse(raw);
      if (parsed.success) records.push(parsed.data);
      else {
        const onlyOverlongExcerpt =
          typeof excerpt === "string" &&
          [...excerpt].length > 500 &&
          parsed.error.issues.every(
            (issue) =>
              issue.code === "too_big" && issue.path.length === 1 && issue.path[0] === "excerpt",
          );
        if (!onlyOverlongExcerpt) malformed += 1;
      }
    } catch (error) {
      if (error instanceof Error) malformed += 1;
      else throw error;
    }
  }
  return { records, malformed, overlong };
}

function isMachineLedger(path: string, root: string): boolean {
  const segments = relative(root, path).split(sep);
  const filename = basename(path);
  return (
    segments.includes("_ledgers") &&
    filename !== "SCHEMA.md" &&
    filename !== "README.md" &&
    filename !== "seed-audit.md"
  );
}

export async function parseCorpus(root: string): Promise<ParsedCorpus> {
  const paths = await markdownFiles(root);
  const files: Readonly<{ path: string; content: string }>[] = [];
  const records: z.infer<typeof ledgerRecordSchema>[] = [];
  let malformedInputs = 0;
  let overlongExcerpts = 0;
  let frontmatterKeysetMismatches = 0;
  let newFrontmatterKeys = 0;
  for (const path of paths) {
    const content = await Bun.file(path).text();
    files.push({ path, content });
    if (isMachineLedger(path, root)) {
      const ledger = parseLedger(content);
      records.push(...ledger.records);
      malformedInputs += ledger.malformed;
      overlongExcerpts += ledger.overlong;
    } else {
      const legacy = parseLegacy(path, content);
      malformedInputs += legacy.malformed;
      frontmatterKeysetMismatches += legacy.mismatch;
      newFrontmatterKeys += legacy.newKeys;
    }
  }
  return {
    files,
    records,
    malformedInputs,
    overlongExcerpts,
    frontmatterKeysetMismatches,
    newFrontmatterKeys,
  };
}
