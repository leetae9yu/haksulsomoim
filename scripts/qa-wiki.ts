import { resolve } from "node:path";
import { z } from "zod";
import { parseCorpus } from "./qa-wiki-parse.ts";
import { validateCorpus } from "./qa-wiki-validate.ts";

const argumentsSchema = z.union([z.tuple([]), z.tuple([z.string().min(1)])]);

class WikiCliError extends Error {
  public constructor(readonly causeMessage: string) {
    super(causeMessage);
    this.name = "WikiCliError";
  }
}

async function run(): Promise<
  Readonly<{ summary: Readonly<Record<string, number>>; hardCount: number }>
> {
  const parsed = argumentsSchema.safeParse(Bun.argv.slice(2));
  if (!parsed.success) throw new WikiCliError("Expected zero or one corpus directory argument.");
  const corpus = await parseCorpus(resolve(parsed.data[0] ?? "wiki"));
  return validateCorpus(corpus);
}

let exitCode = 0;
let output: Readonly<Record<string, number>> = { "malformed-inputs": 0 };

// no-excuse-ok: catch
try {
  const result = await run();
  output = result.summary;
  exitCode = result.hardCount === 0 ? 0 : 1;
} catch (error) {
  if (error instanceof WikiCliError || error instanceof Error) {
    output = { "malformed-inputs": 1 };
    exitCode = 1;
  } else {
    throw error;
  }
}

process.stdout.write(`${JSON.stringify(output)}\n`);
process.exitCode = exitCode;
