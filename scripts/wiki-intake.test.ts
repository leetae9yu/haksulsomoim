import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCorpus } from "./qa-wiki-parse.ts";

const roots: string[] = [];
const root = `${import.meta.dir}/..`;

function pdf(text: string): string {
  const stream = `BT /F1 18 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let value = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(value));
    value += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const start = Buffer.byteLength(value);
  return `${value}xref\n0 6\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
}

async function temporary(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "wiki-intake-"));
  roots.push(path);
  return path;
}

async function run(args: readonly string[]) {
  const process = Bun.spawn(["bun", "run", "scripts/wiki-intake.ts", ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: await process.exited,
    output: JSON.parse(await new Response(process.stdout).text()),
  };
}

async function inputs(path: string) {
  const markdown = join(path, "source.md");
  const localPdf = join(path, "source.pdf");
  await writeFile(markdown, "성명: 홍길동\n전화: 010-1234-5678\n로컬 메모입니다.");
  await writeFile(localPdf, pdf("PDF local reference"));
  return { markdown, localPdf };
}

function args(workspace: string, values: readonly string[], replace = false): string[] {
  return ["--workspace", workspace, ...(replace ? ["--replace"] : []), ...values];
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("wiki intake compiler", () => {
  test("compiles URL metadata, a real PDF, and Markdown into deterministic parseable drafts", async () => {
    const path = await temporary();
    const workspace = join(path, "workspace");
    const input = await inputs(path);
    const values = [
      "https://example.com/reference?email=a@example.com",
      input.localPdf,
      input.markdown,
    ];
    const first = await run(args(workspace, values));
    expect(first).toMatchObject({ code: 0, output: { ok: true, replayed: false } });
    const inventory = join(workspace, "draft", "inventory.json");
    const initial = await readFile(inventory, "utf8");
    const second = await run(args(workspace, [...values].reverse()));
    expect(second).toMatchObject({ code: 0, output: { ok: true, replayed: true } });
    expect(await readFile(inventory, "utf8")).toBe(initial);
    expect(initial).toContain('"kind": "url"');
    expect(initial).toContain('"metadata_only": true');
    expect(initial).toContain('"duplicate": false');
    expect(initial).not.toContain("a@example.com");
    const draft = await readFile(
      join(workspace, "draft", "wiki", "_ledgers", "claims", "INTAKE.md"),
      "utf8",
    );
    expect(draft).toContain('"evidence_status":"reported"');
    const observations = await readFile(
      join(workspace, "draft", "wiki", "_ledgers", "observations", "INTAKE.md"),
      "utf8",
    );
    expect(observations).not.toContain("홍길동");
    expect(observations).not.toContain("010-1234-5678");
    const corpus = await parseCorpus(join(workspace, "draft", "wiki"));
    expect([corpus.malformedInputs, corpus.overlongExcerpts, corpus.records.length > 0]).toEqual([
      0,
      0,
      true,
    ]);
  });

  test("rejects changed replay, malformed input, existing output, and bad arguments", async () => {
    const path = await temporary();
    const workspace = join(path, "workspace");
    const input = await inputs(path);
    expect((await run(args(workspace, [input.markdown]))).code).toBe(0);
    await writeFile(input.markdown, "changed");
    expect(await run(args(workspace, [input.markdown]))).toMatchObject({
      code: 1,
      output: { error: "CHANGED_INPUT" },
    });
    expect(await run(args(join(path, "bad"), [join(path, "missing.md")]))).toMatchObject({
      code: 1,
      output: { error: "INPUT_INVALID" },
    });
    const malformed = join(path, "bad.pdf");
    await writeFile(malformed, "not a PDF");
    expect(await run(args(join(path, "bad-pdf"), [malformed]))).toMatchObject({
      code: 1,
      output: { error: "PDF_INVALID" },
    });
    const output = join(path, "output");
    await writeFile(join(path, "existing.md"), "existing");
    await run(args(output, [join(path, "existing.md")]));
    expect(await run(args(output, [join(path, "existing.md")]))).toMatchObject({
      code: 0,
      output: { replayed: true },
    });
    expect(await run(["--workspace"])).toMatchObject({ code: 1, output: { error: "ARGUMENTS" } });
  });

  test("refuses an existing draft note without --replace and documents the explicit replacement path", async () => {
    const path = await temporary();
    const workspace = join(path, "workspace");
    const input = await inputs(path);
    await writeFile(join(path, "note.md"), "note");
    await run(args(workspace, [input.markdown]));
    await writeFile(join(workspace, "draft", "wiki", "INTAKE-0001.md"), "manual note");
    expect(await run(args(workspace, [join(path, "note.md")]))).toMatchObject({
      code: 1,
      output: { error: "CHANGED_INPUT" },
    });
    expect(await readFile(join(workspace, "draft", "wiki", "INTAKE-0001.md"), "utf8")).toBe(
      "manual note",
    );
    expect((await run(args(workspace, [join(path, "note.md")], true))).code).toBe(0);
  });

  test("flags duplicate source identities for review", async () => {
    const path = await temporary();
    const input = await inputs(path);
    expect((await run(args(join(path, "workspace"), [input.markdown, input.markdown]))).code).toBe(
      0,
    );
    const inventory = await readFile(join(path, "workspace", "draft", "inventory.json"), "utf8");
    expect(inventory).toContain('"duplicate": true');
  });

  test("prints help and never treats a URL as fetchable content", async () => {
    expect(await run(["--help"])).toMatchObject({ code: 0, output: { command: "wiki-intake" } });
    const path = await temporary();
    const result = await run(args(join(path, "workspace"), ["https://example.com/remote.pdf"]));
    expect(result).toMatchObject({ code: 0, output: { ok: true } });
    const draft = await readFile(
      join(path, "workspace", "draft", "wiki", "_ledgers", "observations", "INTAKE.md"),
      "utf8",
    );
    expect(draft).toContain("download remote material locally");
  });
});
