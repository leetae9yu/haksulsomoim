import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  digest,
  type Input,
  IntakeError,
  ledger,
  readInputs,
  recordBundle,
  serial,
} from "./wiki-intake-data.ts";

const repository = resolve(import.meta.dir, "..");

function external(path: string): boolean {
  const value = relative(repository, path);
  return value === ".." || value.startsWith(`..${sep}`);
}

function options(values: readonly string[]) {
  if (values.length === 1 && values[0] === "--help") return { help: true } as const;
  let workspace: string | undefined;
  let replace = false;
  const inputs: string[] = [];
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--workspace") {
      workspace = values[index + 1];
      index += 1;
    } else if (value === "--replace") replace = true;
    else if (value?.startsWith("-")) throw new IntakeError("ARGUMENTS");
    else if (value !== undefined) inputs.push(value);
  }
  if (workspace === undefined || !isAbsolute(workspace) || inputs.length === 0)
    throw new IntakeError("ARGUMENTS");
  return { workspace: resolve(workspace), replace, inputs } as const;
}

function writeDraft(workspace: string, inputs: readonly Input[], replace: boolean) {
  if (!external(workspace)) throw new IntakeError("WORKSPACE_INVALID");
  const request = digest(serial(inputs.map((input) => [input.identity, input.rawHash])));
  const draft = join(workspace, "draft");
  const inventoryPath = join(draft, "inventory.json");
  if (existsSync(inventoryPath)) {
    const existing = JSON.parse(readFileSync(inventoryPath, "utf8")) as { request_sha256?: string };
    if (existing.request_sha256 === request && !replace) return { replayed: true, request };
    if (!replace) throw new IntakeError("CHANGED_INPUT");
  } else if (existsSync(draft) && !replace) throw new IntakeError("OUTPUT_EXISTS");
  if (replace) rmSync(draft, { recursive: true, force: true });
  const { records, inventory } = recordBundle(inputs);
  mkdirSync(join(workspace, "raw"), { recursive: true });
  mkdirSync(join(workspace, "extracted"), { recursive: true });
  for (const input of inputs) {
    const suffix = input.kind === "url" ? ".url" : extname(input.kind === "pdf" ? "x.pdf" : "x.md");
    writeFileSync(join(workspace, "raw", `${input.rawHash}${suffix}`), input.raw);
    if (input.kind !== "url")
      writeFileSync(join(workspace, "extracted", `${digest(input.content)}.txt`), input.content);
  }
  const wiki = join(draft, "wiki");
  const kinds = ["sources", "observations", "claims", "verification", "coverage"];
  for (const [index, kind] of kinds.entries()) {
    mkdirSync(join(wiki, "_ledgers", kind), { recursive: true });
    writeFileSync(join(wiki, "_ledgers", kind, "INTAKE.md"), ledger(records[index] ?? []));
  }
  writeFileSync(
    join(wiki, "README.md"),
    "# Generated local draft\n\nManual review and copying are separate steps.\n",
  );
  for (const entry of inventory) {
    writeFileSync(
      join(wiki, `${entry.occurrence_id}.md`),
      `---\nid: ${entry.occurrence_id}\n유형: draft\n제목: local intake\ntags: [draft]\n---\n\n# Draft\n\n[${entry.occurrence_id}]\n`,
    );
  }
  writeFileSync(
    inventoryPath,
    serial({ format: "wiki-intake-v1", request_sha256: request, inputs: inventory }),
  );
  writeFileSync(
    join(draft, "validation.json"),
    serial({ valid: true, records: inventory.length * 5, request_sha256: request }),
  );
  return { replayed: false, request };
}

const usage = {
  command: "wiki-intake",
  usage: "--workspace ABSOLUTE [--replace] URL_OR_LOCAL_PDF_OR_MARKDOWN...",
  boundary: "URLs are metadata only and are never fetched.",
};
try {
  const parsed = options(Bun.argv.slice(2));
  if ("help" in parsed) process.stdout.write(serial(usage));
  else
    process.stdout.write(
      serial({
        ok: true,
        ...writeDraft(parsed.workspace, readInputs(parsed.inputs), parsed.replace),
      }),
    );
} catch (error) {
  process.stdout.write(
    serial({ ok: false, error: error instanceof IntakeError ? error.code : "INPUT_INVALID" }),
  );
  process.exitCode = 1;
}
