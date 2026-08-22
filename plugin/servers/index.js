// servers/index.ts
import { randomBytes as randomBytes2, randomUUID as randomUUID2 } from "node:crypto";
import { resolve as resolve2 } from "node:path";
import { StdioServerTransport as StdioServerTransport2 } from "@modelcontextprotocol/sdk/server/stdio.js";

// servers/plugin-server.ts
import { McpServer as McpServer3 } from "@modelcontextprotocol/sdk/server/mcp.js";

// servers/contracts/case-record.ts
import { z } from "zod";
var caseIdSchema = z.string().regex(/^case-[a-f0-9]{16}$/);
var isoDate = z.iso.date();
var isoDateTime = z.iso.datetime({ offset: true });
var caseCreateInputSchema = z.strictObject({
  amountKrw: z.number().int().min(1).max(30000000),
  occurredAt: isoDate,
  summary: z.string().trim().min(1).max(2000),
  counterpartyAlias: z.string().trim().min(1).max(100).optional()
});
var evidenceKindSchema = z.enum([
  "transfer-receipt",
  "conversation",
  "listing",
  "report",
  "court-document",
  "other"
]);
var evidenceAddInputSchema = z.strictObject({
  caseId: caseIdSchema,
  path: z.string().trim().min(1).max(4096),
  kind: evidenceKindSchema,
  description: z.string().trim().min(1).max(500)
});
var criminalStageSchema = z.enum([
  "evidence-review",
  "complaint-ready",
  "complaint-filed"
]);
var civilStageSchema = z.enum([
  "pre-filing",
  "payment-order-pending",
  "service-attested",
  "judgment-recorded",
  "enforceable-title-confirmed"
]);
var trackUpdateInputSchema = z.discriminatedUnion("track", [
  z.strictObject({
    caseId: caseIdSchema,
    track: z.literal("criminal"),
    stage: criminalStageSchema
  }),
  z.strictObject({
    caseId: caseIdSchema,
    track: z.literal("civil"),
    stage: civilStageSchema
  })
]);
var evidenceRecordSchema = z.strictObject({
  evidenceId: z.string().regex(/^evidence-[a-f0-9]{16}$/),
  kind: evidenceKindSchema,
  path: z.string().min(1),
  description: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  addedAt: isoDateTime
});
var caseRecordSchema = z.strictObject({
  version: z.literal(1),
  caseId: caseIdSchema,
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
  amountKrw: z.number().int().min(1).max(30000000),
  occurredAt: isoDate,
  summary: z.string().min(1).max(2000),
  counterpartyAlias: z.string().min(1).max(100).optional(),
  evidence: z.array(evidenceRecordSchema),
  criminalStage: criminalStageSchema,
  civilStage: civilStageSchema
});

// servers/case-workspace/case-workspace.ts
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
var criminalStages = ["evidence-review", "complaint-ready", "complaint-filed"];
var civilStages = [
  "pre-filing",
  "payment-order-pending",
  "service-attested",
  "judgment-recorded",
  "enforceable-title-confirmed"
];

class CaseWorkspaceError extends Error {
  name = "CaseWorkspaceError";
}

class CaseWorkspaceRepository {
  #configuredRoot;
  #now;
  #idFactory;
  #rootPath;
  constructor(options) {
    this.#configuredRoot = resolve(options.casesRoot);
    this.#now = options.now ?? (() => new Date);
    this.#idFactory = options.idFactory ?? (() => randomBytes(8).toString("hex"));
  }
  async create(input) {
    const caseId = caseIdSchema.parse(`case-${this.#idFactory()}`);
    const root = await this.rootPath();
    const directory = this.caseDirectory(root, caseId);
    const timestamp = this.timestamp();
    const record = caseRecordSchema.parse({
      version: 1,
      caseId,
      createdAt: timestamp,
      updatedAt: timestamp,
      amountKrw: input.amountKrw,
      occurredAt: input.occurredAt,
      summary: input.summary,
      ...input.counterpartyAlias === undefined ? {} : { counterpartyAlias: input.counterpartyAlias },
      evidence: [],
      criminalStage: "evidence-review",
      civilStage: "pre-filing"
    });
    let directoryCreated = false;
    try {
      await mkdir(directory);
      directoryCreated = true;
      await this.writeWorkspace(directory, record);
      return record;
    } catch (error) {
      if (directoryCreated)
        await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }
  async read(caseId) {
    const root = await this.rootPath();
    const directory = await this.existingCaseDirectory(root, caseIdSchema.parse(caseId));
    let parsed;
    try {
      parsed = JSON.parse(await readFile(`${directory}/record.json`, "utf8"));
    } catch (error) {
      throw new CaseWorkspaceError(`Cannot read case record: ${String(error)}`);
    }
    return caseRecordSchema.parse(parsed);
  }
  async addEvidence(input) {
    const root = await this.rootPath();
    const directory = await this.existingCaseDirectory(root, input.caseId);
    const record = await this.read(input.caseId);
    const path = await this.resolveEvidencePath(root, input.path);
    const evidence = {
      evidenceId: `evidence-${this.#idFactory()}`,
      kind: input.kind,
      path,
      description: input.description,
      sha256: await sha256(path),
      addedAt: this.timestamp()
    };
    const updated = caseRecordSchema.parse({
      ...record,
      updatedAt: evidence.addedAt,
      evidence: [...record.evidence, evidence]
    });
    await this.writeWorkspace(directory, updated);
    return updated;
  }
  async updateTrack(input) {
    const root = await this.rootPath();
    const directory = await this.existingCaseDirectory(root, input.caseId);
    const record = await this.read(input.caseId);
    const timestamp = this.timestamp();
    const updated = input.track === "criminal" ? this.updateCriminal(record, input.stage, timestamp) : this.updateCivil(record, input.stage, timestamp);
    await this.writeWorkspace(directory, updated);
    return updated;
  }
  updateCriminal(record, stage, updatedAt) {
    if (criminalStages.indexOf(stage) <= criminalStages.indexOf(record.criminalStage)) {
      throw new CaseWorkspaceError("Invalid criminal stage transition");
    }
    return caseRecordSchema.parse({ ...record, criminalStage: stage, updatedAt });
  }
  updateCivil(record, stage, updatedAt) {
    if (civilStages.indexOf(stage) <= civilStages.indexOf(record.civilStage)) {
      throw new CaseWorkspaceError("Invalid civil stage transition");
    }
    return caseRecordSchema.parse({ ...record, civilStage: stage, updatedAt });
  }
  async rootPath() {
    this.#rootPath ??= this.initializeRoot();
    return this.#rootPath;
  }
  async initializeRoot() {
    await mkdir(this.#configuredRoot, { recursive: true });
    if ((await lstat(this.#configuredRoot)).isSymbolicLink()) {
      throw new CaseWorkspaceError("Cases root must not be a symlink");
    }
    return realpath(this.#configuredRoot);
  }
  caseDirectory(root, caseId) {
    return resolve(root, caseId);
  }
  async existingCaseDirectory(root, caseId) {
    const directory = this.caseDirectory(root, caseId);
    const details = await lstat(directory).catch(() => {
      return;
    });
    if (details === undefined || !details.isDirectory() || details.isSymbolicLink()) {
      throw new CaseWorkspaceError("Case does not exist or is not a directory");
    }
    return directory;
  }
  async resolveEvidencePath(root, suppliedPath) {
    if (suppliedPath.split(sep).includes("..")) {
      throw new CaseWorkspaceError("Evidence path is outside the cases root");
    }
    const candidate = resolve(root, suppliedPath);
    if (!isInside(root, candidate))
      throw new CaseWorkspaceError("Evidence path is outside the cases root");
    const details = await lstat(candidate).catch(() => {
      return;
    });
    if (details === undefined)
      throw new CaseWorkspaceError("Evidence path is not a local file");
    if (details.isSymbolicLink())
      throw new CaseWorkspaceError("Evidence path must not be a symlink");
    if (!details.isFile())
      throw new CaseWorkspaceError("Evidence path is not a local file");
    const resolved = await realpath(candidate);
    if (resolved !== candidate || !isInside(root, resolved)) {
      throw new CaseWorkspaceError("Evidence path must not use a symlink");
    }
    return resolved;
  }
  timestamp() {
    return this.#now().toISOString();
  }
  async writeWorkspace(directory, record) {
    const strictRecord = caseRecordSchema.parse(record);
    await Promise.all([
      atomicWrite(`${directory}/record.json`, `${JSON.stringify(strictRecord, null, 2)}
`),
      atomicWrite(`${directory}/timeline.md`, timelineMarkdown(strictRecord)),
      atomicWrite(`${directory}/evidence.md`, evidenceMarkdown(strictRecord)),
      atomicWrite(`${directory}/criminal.md`, trackMarkdown("Criminal", strictRecord.criminalStage)),
      atomicWrite(`${directory}/civil.md`, trackMarkdown("Civil", strictRecord.civilStage))
    ]);
  }
}
function isInside(root, path) {
  const pathRelative = relative(root, path);
  return pathRelative !== "" && !pathRelative.startsWith(`..${sep}`) && pathRelative !== ".." && !isAbsolute(pathRelative);
}
async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path))
    hash.update(chunk);
  return hash.digest("hex");
}
async function atomicWrite(path, contents) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, contents, { flag: "wx" });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
function timelineMarkdown(record) {
  const evidence = record.evidence.map((item) => `- ${item.addedAt}: Evidence added (${item.kind})`).join(`
`);
  return [
    "# Timeline",
    "",
    "- Case type: Domestic bank-transfer fraud",
    `- Incident date: ${record.occurredAt}`,
    `- Created: ${record.createdAt}`,
    ...evidence === "" ? [] : [evidence],
    ""
  ].join(`
`);
}
function evidenceMarkdown(record) {
  const entries = record.evidence.map((item) => [
    `## ${item.evidenceId}`,
    `- Kind: ${item.kind}`,
    `- Description: ${item.description}`,
    `- Path: ${item.path}`,
    `- SHA-256: ${item.sha256}`,
    `- Added: ${item.addedAt}`,
    ""
  ].join(`
`));
  return [
    "# Evidence",
    "",
    ...entries.length === 0 ? ["No evidence recorded.", ""] : entries
  ].join(`
`);
}
function trackMarkdown(track, stage) {
  return `# ${track} track

- Current stage: ${stage}
`;
}

// servers/case-workspace/index.ts
class CaseWorkspace {
  #repository;
  constructor(options) {
    this.#repository = new CaseWorkspaceRepository({
      casesRoot: options.casesRoot,
      ...options.now === undefined ? {} : { now: options.now },
      ...options.idFactory === undefined ? {} : { idFactory: options.idFactory }
    });
  }
  async create(input) {
    return masked(await this.#repository.create(caseCreateInputSchema.parse(input)));
  }
  async getMasked(caseId) {
    return masked(await this.#repository.read(caseIdSchema.parse(caseId)));
  }
  async addEvidence(input) {
    return masked(await this.#repository.addEvidence(evidenceAddInputSchema.parse(input)));
  }
  async updateTrack(input) {
    return masked(await this.#repository.updateTrack(trackUpdateInputSchema.parse(input)));
  }
}
function masked(record) {
  return {
    caseId: record.caseId,
    amountKrw: record.amountKrw,
    occurredAt: record.occurredAt,
    summary: "[MASKED]",
    ...record.counterpartyAlias === undefined ? {} : { counterpartyAlias: "[MASKED]" },
    evidenceCount: record.evidence.length,
    criminalStage: record.criminalStage,
    civilStage: record.civilStage,
    updatedAt: record.updatedAt
  };
}

// servers/case-workspace/mcp-server.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
function result(summary) {
  return {
    content: [{ type: "text", text: JSON.stringify(summary) }],
    structuredContent: summary
  };
}
function registerCaseWorkspaceTools(server, workspace) {
  server.registerTool("case_create", {
    description: "Create a local case workspace and return only a masked summary.",
    inputSchema: caseCreateInputSchema.shape,
    annotations: { destructiveHint: false, openWorldHint: false }
  }, async (input) => result(await workspace.create(input)));
  server.registerTool("case_get_masked", {
    description: "Read the current case stages and counts without returning raw case facts.",
    inputSchema: { caseId: caseIdSchema },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  }, async ({ caseId }) => result(await workspace.getMasked(caseId)));
  server.registerTool("case_add_evidence", {
    description: "Hash and index an existing local evidence file without copying its contents.",
    inputSchema: evidenceAddInputSchema.shape,
    annotations: { destructiveHint: false, openWorldHint: false }
  }, async (input) => result(await workspace.addEvidence(input)));
  server.registerTool("case_set_criminal_stage", {
    description: "Advance only the criminal track to a valid later stage.",
    inputSchema: { caseId: caseIdSchema, stage: criminalStageSchema },
    annotations: { destructiveHint: false, openWorldHint: false }
  }, async ({ caseId, stage }) => result(await workspace.updateTrack({ caseId, track: "criminal", stage })));
  server.registerTool("case_set_civil_stage", {
    description: "Advance only the civil track to a valid later stage.",
    inputSchema: { caseId: caseIdSchema, stage: civilStageSchema },
    annotations: { destructiveHint: false, openWorldHint: false }
  }, async ({ caseId, stage }) => result(await workspace.updateTrack({ caseId, track: "civil", stage })));
}

// servers/secure-computer/mcp-server.ts
import { McpServer as McpServer2 } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z as z3 } from "zod";

// servers/contracts/secure-computer.ts
import { z as z2 } from "zod";
var coordinate = z2.number().int().min(0).max(16384);
var observationDigest = z2.string().regex(/^[a-f0-9]{64}$/);
var redactionToken = z2.string().regex(/^\[(?:RRN|PHONE|ADDRESS|ACCOUNT|CASE|EMAIL|PERSON)_[A-Z2-7]{16}\]$/);
var secureComputerActionSchema = z2.discriminatedUnion("kind", [
  z2.strictObject({ kind: z2.literal("click"), x: coordinate, y: coordinate, observationDigest }),
  z2.strictObject({
    kind: z2.literal("type-text"),
    x: coordinate,
    y: coordinate,
    text: z2.string().min(1).max(2000),
    observationDigest
  }),
  z2.strictObject({
    kind: z2.literal("type-token"),
    x: coordinate,
    y: coordinate,
    token: redactionToken,
    observationDigest
  }),
  z2.strictObject({
    kind: z2.literal("scroll"),
    deltaX: z2.number().int().min(-4000).max(4000),
    deltaY: z2.number().int().min(-4000).max(4000),
    observationDigest
  })
]);

// servers/secure-computer/mcp-server.ts
var actionResult = (result2) => ({
  content: [{ type: "text", text: JSON.stringify(result2) }],
  isError: result2.outcome === "rejected"
});
function registerSecureComputerTools(server, computer) {
  server.registerTool("secure_computer_start", {
    description: "Open an allowlisted URL in an isolated local browser.",
    inputSchema: { url: z3.url().max(2048) },
    annotations: { destructiveHint: false, openWorldHint: true }
  }, async ({ url }) => {
    await computer.start(url);
    return { content: [{ type: "text", text: JSON.stringify({ outcome: "started" }) }] };
  });
  server.registerTool("secure_computer_observe", {
    description: "Return only a locally redacted PNG and masked screen text.",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  }, async () => {
    const observation = await computer.observe();
    const metadata = {
      url: observation.url,
      width: observation.width,
      height: observation.height,
      maskedText: observation.maskedText,
      observationDigest: observation.observationDigest
    };
    return {
      content: [
        {
          type: "image",
          data: Buffer.from(observation.imagePng).toString("base64"),
          mimeType: "image/png"
        },
        { type: "text", text: JSON.stringify(metadata) }
      ],
      structuredContent: metadata
    };
  });
  server.registerTool("secure_computer_click", {
    description: "Click only when the current observation digest and local policy permit it.",
    inputSchema: secureComputerActionSchema.options[0].omit({ kind: true }).shape,
    annotations: { destructiveHint: true, openWorldHint: false }
  }, async (input) => actionResult(await computer.act(secureComputerActionSchema.parse({ kind: "click", ...input }))));
  server.registerTool("secure_computer_type_text", {
    description: "Type non-sensitive text; raw direct identifiers are rejected locally.",
    inputSchema: secureComputerActionSchema.options[1].omit({ kind: true }).shape,
    annotations: { destructiveHint: true, openWorldHint: false }
  }, async (input) => actionResult(await computer.act(secureComputerActionSchema.parse({ kind: "type-text", ...input }))));
  server.registerTool("secure_computer_type_token", {
    description: "Type a token rehydrated only inside the local browser.",
    inputSchema: secureComputerActionSchema.options[2].omit({ kind: true }).shape,
    annotations: { destructiveHint: true, openWorldHint: false }
  }, async (input) => actionResult(await computer.act(secureComputerActionSchema.parse({ kind: "type-token", ...input }))));
  server.registerTool("secure_computer_scroll", {
    description: "Scroll only after binding to the latest redacted observation digest.",
    inputSchema: secureComputerActionSchema.options[3].omit({ kind: true }).shape,
    annotations: { destructiveHint: true, openWorldHint: false }
  }, async (input) => actionResult(await computer.act(secureComputerActionSchema.parse({ kind: "scroll", ...input }))));
  server.registerTool("secure_computer_close", {
    description: "Close the isolated browser and erase the in-memory token vault.",
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async () => {
    await computer.close();
    return { content: [{ type: "text", text: JSON.stringify({ outcome: "closed" }) }] };
  });
}

// servers/plugin-server.ts
function createPluginMcpServer(options) {
  const server = new McpServer3({ name: "haksulsomoim-local", version: "0.1.0" });
  const workspace = new CaseWorkspace({
    casesRoot: options.casesRoot,
    ...options.now === undefined ? {} : { now: options.now },
    ...options.idFactory === undefined ? {} : { idFactory: options.idFactory }
  });
  registerCaseWorkspaceTools(server, workspace);
  registerSecureComputerTools(server, options.computer);
  return server;
}

// servers/secure-computer/index.ts
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

// servers/secure-computer/local-ocr.ts
import { copyFile, mkdtemp, rm as rm2 } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Tesseract from "tesseract.js";
var moduleRequire = createRequire(import.meta.url);
var LANGUAGES = "kor+eng";
var trainedDataPath = (languagePackage, language) => join(dirname(moduleRequire.resolve(`${languagePackage}/package.json`)), "4.0.0_best_int", `${language}.traineddata.gz`);
var stageLocalLanguages = async () => {
  const directory = await mkdtemp(join(tmpdir(), "haksulsomoim-ocr-"));
  try {
    await Promise.all([
      copyFile(trainedDataPath("@tesseract.js-data/kor", "kor"), join(directory, "kor.traineddata.gz")),
      copyFile(trainedDataPath("@tesseract.js-data/eng", "eng"), join(directory, "eng.traineddata.gz"))
    ]);
    return directory;
  } catch (error) {
    await rm2(directory, { recursive: true, force: true });
    throw error;
  }
};
var toBoundingBox = (bbox) => ({
  x: bbox.x0,
  y: bbox.y0,
  width: bbox.x1 - bbox.x0,
  height: bbox.y1 - bbox.y0
});
var candidatesFromBlocks = (blocks) => (blocks ?? []).flatMap((block) => block.paragraphs.flatMap((paragraph) => paragraph.lines.flatMap((line) => line.words.filter((word) => word.text.trim().length > 0 && word.confidence >= 0 && word.confidence <= 100).map((word) => ({
  text: word.text.trim(),
  confidence: word.confidence,
  boundingBox: toBoundingBox(word.bbox)
})))));

class LocalKorEngOcr {
  #worker;
  #languageDirectory;
  #queue = Promise.resolve();
  #disposed = false;
  #disposal;
  constructor(worker, languageDirectory) {
    this.#worker = worker;
    this.#languageDirectory = languageDirectory;
  }
  recognize(image) {
    if (this.#disposed)
      throw new Error("OCR recognizer is disposed");
    if (image.byteLength === 0)
      return Promise.resolve([]);
    const ownedImage = image.slice();
    return this.#enqueue(async () => {
      const result2 = await this.#worker.recognize(Buffer.from(ownedImage), {}, { text: true, blocks: true });
      return candidatesFromBlocks(result2.data.blocks);
    });
  }
  dispose() {
    if (this.#disposal !== undefined)
      return this.#disposal;
    this.#disposed = true;
    this.#disposal = this.#enqueue(async () => {
      try {
        await this.#worker.terminate();
      } finally {
        await rm2(this.#languageDirectory, { recursive: true, force: true });
      }
    });
    return this.#disposal;
  }
  #enqueue(operation) {
    const result2 = this.#queue.then(operation);
    this.#queue = result2.then(() => {
      return;
    }, () => {
      return;
    });
    return result2;
  }
}
var createLocalKorEngOcr = async () => {
  const languageDirectory = await stageLocalLanguages();
  try {
    const worker = await Tesseract.createWorker(LANGUAGES, Tesseract.OEM.LSTM_ONLY, {
      langPath: languageDirectory,
      cacheMethod: "none",
      gzip: true
    });
    return new LocalKorEngOcr(worker, languageDirectory);
  } catch (error) {
    await rm2(languageDirectory, { recursive: true, force: true });
    throw error;
  }
};

// servers/secure-computer/playwright-browser.ts
import { platform } from "node:os";
import {
  chromium
} from "playwright-core";
var candidateKey = (candidate) => `${candidate.text}\x00${candidate.boundingBox.x}:${candidate.boundingBox.y}:${candidate.boundingBox.width}:${candidate.boundingBox.height}`;

class PlaywrightSecureBrowser {
  #ocr;
  #allowedHosts;
  #launchOptions;
  #viewport;
  #browser;
  #context;
  #page;
  #closed = false;
  constructor(options) {
    this.#ocr = options.ocr;
    this.#allowedHosts = new Set(options.allowedHosts.map((host) => host.toLowerCase()));
    this.#viewport = options.viewport ?? { width: 1440, height: 900 };
    this.#launchOptions = { headless: options.headless ?? false };
    if (options.executablePath !== undefined)
      this.#launchOptions.executablePath = options.executablePath;
    else if (platform() === "win32")
      this.#launchOptions.channel = "msedge";
  }
  async start(url) {
    if (this.#browser !== undefined || this.#closed)
      throw new Error("Secure browser is unavailable");
    this.#browser = await chromium.launch(this.#launchOptions);
    this.#context = await this.#browser.newContext({
      acceptDownloads: false,
      viewport: this.#viewport
    });
    await this.#context.route("**/*", async (route) => {
      const requestUrl = new URL(route.request().url());
      if (["data:", "blob:"].includes(requestUrl.protocol) || this.#allowedHosts.has(requestUrl.hostname.toLowerCase())) {
        await route.continue();
        return;
      }
      await route.abort("blockedbyclient");
    });
    this.#page = await this.#context.newPage();
    await this.#page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  }
  async inspect() {
    const page = this.#requirePage();
    const screenshot = await page.screenshot({ type: "png" });
    const [domCandidates, ocrCandidates] = await Promise.all([
      this.#readDomCandidates(page),
      this.#ocr.recognize(screenshot)
    ]);
    const candidates = this.#deduplicate([...domCandidates, ...ocrCandidates]);
    const viewport = page.viewportSize() ?? this.#viewport;
    return { url: page.url(), width: viewport.width, height: viewport.height, candidates };
  }
  async captureMasked(regions) {
    const page = this.#requirePage();
    await page.evaluate((masks) => {
      document.querySelector("[data-haksul-redaction-layer]")?.remove();
      const layer = document.createElement("div");
      layer.dataset.haksulRedactionLayer = "true";
      Object.assign(layer.style, {
        position: "fixed",
        inset: "0",
        zIndex: "2147483647",
        pointerEvents: "none"
      });
      for (const mask of masks) {
        const box = document.createElement("div");
        box.textContent = mask.label;
        Object.assign(box.style, {
          position: "absolute",
          left: `${mask.boundingBox.x}px`,
          top: `${mask.boundingBox.y}px`,
          width: `${mask.boundingBox.width}px`,
          height: `${mask.boundingBox.height}px`,
          overflow: "hidden",
          background: "#172033",
          color: "#ffffff",
          font: "600 12px sans-serif",
          lineHeight: `${mask.boundingBox.height}px`,
          whiteSpace: "nowrap"
        });
        layer.append(box);
      }
      document.documentElement.append(layer);
    }, regions);
    try {
      return await page.screenshot({ type: "png" });
    } finally {
      await page.evaluate(() => document.querySelector("[data-haksul-redaction-layer]")?.remove());
    }
  }
  async targetAt(x, y) {
    return this.#requirePage().evaluate(({ x: targetX, y: targetY }) => {
      const element = document.elementFromPoint(targetX, targetY);
      if (!(element instanceof HTMLElement))
        return;
      const input = element instanceof HTMLInputElement ? element : undefined;
      const role = element.getAttribute("role");
      const ariaLabel = element.getAttribute("aria-label");
      return {
        text: (element.innerText || element.getAttribute("name") || "").slice(0, 500),
        tagName: element.tagName,
        ...role === null ? {} : { role },
        ...ariaLabel === null ? {} : { ariaLabel },
        ...input === undefined ? {} : { inputType: input.type }
      };
    }, { x, y });
  }
  async click(x, y) {
    const page = this.#requirePage();
    await page.mouse.click(x, y);
    await this.#nextPaint(page);
  }
  async typeText(x, y, text) {
    const page = this.#requirePage();
    await page.mouse.click(x, y);
    await page.keyboard.press(platform() === "darwin" ? "Meta+A" : "Control+A");
    await page.keyboard.insertText(text);
    await this.#nextPaint(page);
  }
  async scroll(deltaX, deltaY) {
    const page = this.#requirePage();
    await page.mouse.wheel(deltaX, deltaY);
    await this.#nextPaint(page);
  }
  async close() {
    if (this.#closed)
      return;
    this.#closed = true;
    try {
      await this.#browser?.close();
    } finally {
      await this.#ocr.dispose();
      this.#page = undefined;
      this.#context = undefined;
      this.#browser = undefined;
    }
  }
  async#readDomCandidates(page) {
    return page.evaluate(() => {
      const regions = [];
      const add = (text, rect) => {
        const normalized = text.trim();
        if (normalized.length === 0 || rect.width <= 0 || rect.height <= 0)
          return;
        regions.push({
          text: normalized.slice(0, 2000),
          boundingBox: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
        });
      };
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode();node !== null && regions.length < 1000; node = walker.nextNode()) {
        if (node.textContent === null)
          continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        add(node.textContent, range.getBoundingClientRect());
      }
      for (const element of document.querySelectorAll("input, textarea")) {
        const value = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element.value : "";
        add(value, element.getBoundingClientRect());
      }
      return regions;
    });
  }
  #deduplicate(candidates) {
    return [
      ...new Map(candidates.map((candidate) => [candidateKey(candidate), candidate])).values()
    ];
  }
  async#nextPaint(page) {
    await page.evaluate(() => new Promise((resolve2) => requestAnimationFrame(() => resolve2())));
  }
  #requirePage() {
    if (this.#page === undefined)
      throw new Error("Secure browser is not started");
    return this.#page;
  }
}

// servers/secure-computer/redaction.ts
import { createHmac } from "node:crypto";
var IDENTIFIER_PATTERNS = [
  { kind: "EMAIL", pattern: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu },
  { kind: "CASE", pattern: /(?<!\d)(?:19|20)\d{2}[가-힣]{1,4}\d{1,10}(?!\d)/gu },
  { kind: "RRN", pattern: /(?<!\d)\d{6}-?[1-4]\d{6}(?!\d)/g },
  { kind: "PHONE", pattern: /(?<!\d)01[016789][ -]?\d{3,4}[ -]?\d{4}(?!\d)/g },
  {
    kind: "ADDRESS",
    pattern: /(?:서울(?:특별시)?|부산(?:광역시)?|대구(?:광역시)?|인천(?:광역시)?|광주(?:광역시)?|대전(?:광역시)?|울산(?:광역시)?|세종(?:특별자치시)?|경기(?:도)?|강원(?:특별자치도|도)?|충청[남북]도|전라[남북]도|경상[남북]도|제주(?:특별자치도|도)?)\s+[가-힣0-9·]+(?:시|군|구)\s+[가-힣0-9·.-]+(?:대로|로|길|동|읍|면)\s+\d+(?:-\d+)?/gu
  },
  {
    kind: "ACCOUNT",
    pattern: /(?<!\d)(?!(?:19|20)\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])(?!\d))\d{2,6}(?:-\d{2,6}){2,4}(?!\d)/g
  }
];
var CONTEXTUAL_PERSON = /((?:성명|이름|신청인|송금인|sender)\s*[:=]\s*)([가-힣]{2,4})(?![가-힣])/giu;
var BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
var containsDirectIdentifier = (input) => {
  if (CONTEXTUAL_PERSON.test(input)) {
    CONTEXTUAL_PERSON.lastIndex = 0;
    return true;
  }
  CONTEXTUAL_PERSON.lastIndex = 0;
  return IDENTIFIER_PATTERNS.some(({ pattern }) => {
    const matched = pattern.test(input);
    pattern.lastIndex = 0;
    return matched;
  });
};
var base32Prefix = (bytes, count) => {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = value << 8 | byte;
    bits += 8;
    while (bits >= 5 && output.length < count) {
      output += BASE32_ALPHABET[value >>> bits - 5 & 31];
      bits -= 5;
    }
    if (output.length === count)
      return output;
  }
  if (bits > 0 && output.length < count)
    output += BASE32_ALPHABET[value << 5 - bits & 31];
  return output.slice(0, count);
};

class Redactor {
  #tokenKey;
  constructor(tokenKey) {
    if (tokenKey.byteLength < 32)
      throw new RangeError("Redaction token key must be at least 32 bytes");
    this.#tokenKey = Uint8Array.from(tokenKey);
  }
  redactWithMappings(caseId, input, fields = {}) {
    if (caseId.length === 0)
      throw new TypeError("A non-empty case id is required for redaction");
    let text = input;
    const mappings = new Map;
    const replace = (kind, value) => {
      const token = this.#token(caseId, kind, value);
      mappings.set(token, { kind, token, value });
      return token;
    };
    for (const [kind, values] of [
      ["EMAIL", fields.email],
      ["PERSON", fields.personName]
    ]) {
      for (const value of values ?? []) {
        if (value.length === 0)
          throw new TypeError(`Structured ${kind.toLowerCase()} fields must not be empty`);
        text = text.replaceAll(value, replace(kind, value));
      }
    }
    text = text.replace(CONTEXTUAL_PERSON, (_match, label, person) => `${label}${replace("PERSON", person)}`);
    for (const { kind, pattern } of IDENTIFIER_PATTERNS)
      text = text.replace(pattern, (value) => replace(kind, value));
    return Object.freeze({ text, mappings: Object.freeze([...mappings.values()]) });
  }
  #token(caseId, kind, value) {
    const digest = createHmac("sha256", this.#tokenKey).update(caseId, "utf8").update("\x00").update(kind, "utf8").update("\x00").update(value, "utf8").digest();
    return `[${kind}_${base32Prefix(digest, 16)}]`;
  }
}

// servers/secure-computer/secure-computer-service.ts
import { createHash as createHash2 } from "node:crypto";

// servers/secure-computer/action-gate.ts
var HIGH_RISK_ACTION = /(?:최종\s*제출|제출\s*완료|결제|납부|송금|이체|서약|법적\s*동의|삭제|취소\s*확정|submit|pay|purchase|transfer|delete)/iu;
var AUTHENTICATION = /(?:로그인|인증|비밀번호|패스워드|일회용|공동인증서|금융인증서|captcha|password|otp|sign[ -]?in)/iu;

class SecureComputerActionGate {
  #allowedHosts;
  constructor(allowedHosts) {
    if (allowedHosts.length === 0)
      throw new TypeError("At least one allowed host is required");
    this.#allowedHosts = new Set(allowedHosts.map((host) => host.toLowerCase()));
  }
  evaluate(input) {
    if (!this.#isAllowedUrl(input.url))
      return { outcome: "rejected", reason: "origin-not-allowlisted" };
    if (input.action.kind === "type-text" && containsDirectIdentifier(input.action.text)) {
      return { outcome: "rejected", reason: "raw-identifier" };
    }
    if (input.action.kind === "scroll")
      return { outcome: "allowed" };
    if (input.target === undefined)
      return { outcome: "rejected", reason: "target-unavailable" };
    const typing = input.action.kind === "type-text" || input.action.kind === "type-token";
    const editable = input.target.tagName === "INPUT" || input.target.tagName === "TEXTAREA" || input.target.role === "textbox";
    if (typing && !editable)
      return { outcome: "rejected", reason: "unsupported-input-target" };
    const targetText = [
      input.target.text,
      input.target.ariaLabel ?? "",
      input.target.role ?? "",
      input.target.inputType ?? ""
    ].join(" ");
    if (input.target.inputType === "password" || AUTHENTICATION.test(targetText)) {
      return { outcome: "requires-user", reason: "authentication-field" };
    }
    if (input.action.kind === "click" && HIGH_RISK_ACTION.test(targetText)) {
      return { outcome: "requires-user", reason: "high-risk-action" };
    }
    return { outcome: "allowed" };
  }
  #isAllowedUrl(input) {
    try {
      const url = new URL(input);
      const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
      return (url.protocol === "https:" || loopback && url.protocol === "http:") && this.#allowedHosts.has(url.hostname.toLowerCase());
    } catch {
      return false;
    }
  }
}

// servers/secure-computer/redaction-session.ts
class SecureComputerRedactionSession {
  #caseId;
  #redactor;
  #valuesByToken = new Map;
  #disposed = false;
  constructor(caseId, redactor) {
    if (caseId.length === 0)
      throw new TypeError("A non-empty case id is required");
    this.#caseId = caseId;
    this.#redactor = redactor;
  }
  redact(input, fields = {}) {
    this.#assertActive();
    const result2 = this.#redactor.redactWithMappings(this.#caseId, input, fields);
    for (const mapping of result2.mappings)
      this.#remember(mapping);
    return result2;
  }
  rehydrate(token) {
    this.#assertActive();
    const value = this.#valuesByToken.get(token);
    if (value === undefined)
      throw new Error("Unknown redaction token");
    return value;
  }
  dispose() {
    this.#disposed = true;
    this.#valuesByToken.clear();
  }
  #remember(mapping) {
    const existing = this.#valuesByToken.get(mapping.token);
    if (existing !== undefined && existing !== mapping.value)
      throw new Error("Redaction token collision");
    this.#valuesByToken.set(mapping.token, mapping.value);
  }
  #assertActive() {
    if (this.#disposed)
      throw new Error("Redaction session is disposed");
  }
}

// servers/secure-computer/secure-computer-service.ts
var rejected = (reason, actionCount) => ({
  outcome: "rejected",
  reason,
  actionCount
});
var overlaps = (left, right) => left.x < right.x + right.width && left.x + left.width > right.x && left.y < right.y + right.height && left.y + left.height > right.y;
var contains = (outer, inner) => outer.x <= inner.x && outer.y <= inner.y && outer.x + outer.width >= inner.x + inner.width && outer.y + outer.height >= inner.y + inner.height;
var collapseMaskRegions = (regions) => {
  const collapsed = [];
  const largestFirst = [...regions].sort((left, right) => right.boundingBox.width * right.boundingBox.height - left.boundingBox.width * left.boundingBox.height);
  for (const region of largestFirst) {
    if (!collapsed.some((outer) => contains(outer.boundingBox, region.boundingBox)))
      collapsed.push(region);
  }
  return collapsed;
};

class SecureComputerService {
  #browser;
  #redaction;
  #gate;
  #maxActions;
  #actionCount = 0;
  #latestObservation;
  #started = false;
  constructor(options) {
    if (!Number.isSafeInteger(options.maxActions) || options.maxActions < 1) {
      throw new RangeError("maxActions must be a positive safe integer");
    }
    this.#browser = options.browser;
    this.#redaction = new SecureComputerRedactionSession(options.caseId, options.redactor);
    this.#gate = new SecureComputerActionGate(options.allowedHosts);
    this.#maxActions = options.maxActions;
  }
  async start(url) {
    const probe = this.#gate.evaluate({
      url,
      action: { kind: "scroll", deltaX: 0, deltaY: 0, observationDigest: "0".repeat(64) }
    });
    if (probe.outcome !== "allowed")
      throw new Error(probe.reason);
    await this.#browser.start(url);
    this.#started = true;
  }
  async observe() {
    this.#assertStarted();
    const inspection = await this.#browser.inspect();
    const origin = this.#gate.evaluate({
      url: inspection.url,
      action: { kind: "scroll", deltaX: 0, deltaY: 0, observationDigest: "0".repeat(64) }
    });
    if (origin.outcome !== "allowed")
      throw new Error(origin.reason);
    const analyzed = inspection.candidates.map((candidate) => ({
      candidate,
      redacted: this.#redaction.redact(candidate.text)
    }));
    const regions = collapseMaskRegions(analyzed.filter(({ candidate, redacted }) => redacted.text !== candidate.text).map(({ candidate, redacted }) => ({
      label: redacted.text,
      boundingBox: candidate.boundingBox
    })));
    const maskedText = analyzed.map(({ candidate, redacted }) => redacted.text !== candidate.text ? redacted.text : regions.find((region) => overlaps(region.boundingBox, candidate.boundingBox))?.label ?? redacted.text);
    const imagePng = await this.#browser.captureMasked(regions);
    const text = [...new Set(maskedText)].join(`
`).slice(0, 20000);
    const observation = Object.freeze({
      url: inspection.url,
      width: inspection.width,
      height: inspection.height,
      imagePng: imagePng.slice(),
      maskedText: text,
      observationDigest: createHash2("sha256").update(inspection.url, "utf8").update("\x00").update(imagePng).update("\x00").update(text, "utf8").digest("hex")
    });
    this.#latestObservation = observation;
    return observation;
  }
  async act(input) {
    this.#assertStarted();
    const action = secureComputerActionSchema.parse(input);
    if (this.#latestObservation?.observationDigest !== action.observationDigest)
      return rejected("stale-observation", this.#actionCount);
    if (this.#actionCount >= this.#maxActions)
      return rejected("action-budget-exhausted", this.#actionCount);
    const target = action.kind === "scroll" ? undefined : await this.#browser.targetAt(action.x, action.y);
    const decision = this.#gate.evaluate(target === undefined ? { url: this.#latestObservation.url, action } : { url: this.#latestObservation.url, action, target });
    if (decision.outcome !== "allowed")
      return { ...decision, actionCount: this.#actionCount };
    await this.#execute(action);
    this.#actionCount += 1;
    this.#latestObservation = undefined;
    return { outcome: "executed", actionCount: this.#actionCount };
  }
  async close() {
    this.#latestObservation = undefined;
    this.#started = false;
    this.#redaction.dispose();
    await this.#browser.close();
  }
  async#execute(action) {
    switch (action.kind) {
      case "click":
        return this.#browser.click(action.x, action.y);
      case "type-text":
        return this.#browser.typeText(action.x, action.y, action.text);
      case "type-token":
        return this.#browser.typeText(action.x, action.y, this.#redaction.rehydrate(action.token));
      case "scroll":
        return this.#browser.scroll(action.deltaX, action.deltaY);
    }
  }
  #assertStarted() {
    if (!this.#started)
      throw new Error("Secure computer session is not started");
  }
}

// servers/secure-computer/index.ts
var createSecureComputerRuntime = async (options) => {
  const ocr = await createLocalKorEngOcr();
  const browser = new PlaywrightSecureBrowser({
    ocr,
    allowedHosts: options.allowedHosts,
    ...options.executablePath === undefined ? {} : { executablePath: options.executablePath },
    ...options.headless === undefined ? {} : { headless: options.headless },
    ...options.viewport === undefined ? {} : { viewport: options.viewport }
  });
  return new SecureComputerService({
    browser,
    caseId: options.caseId,
    redactor: new Redactor(options.redactionKey),
    allowedHosts: options.allowedHosts,
    maxActions: options.maxActions ?? 64
  });
};

// servers/index.ts
function allowedHosts() {
  const hosts = (process.env.HAKSUL_SECURE_COMPUTER_HOSTS ?? "ecfs.scourt.go.kr,law.go.kr").split(",").map((host) => host.trim()).filter((host) => host.length > 0);
  if (hosts.length === 0)
    throw new TypeError("At least one secure-computer host is required");
  return hosts;
}
var computer = await createSecureComputerRuntime({
  allowedHosts: allowedHosts(),
  caseId: process.env.HAKSUL_CASE_ID ?? `session-${randomUUID2()}`,
  redactionKey: randomBytes2(32),
  ...process.env.HAKSUL_BROWSER_EXECUTABLE === undefined ? {} : { executablePath: process.env.HAKSUL_BROWSER_EXECUTABLE }
});
var server = createPluginMcpServer({
  casesRoot: resolve2(process.env.HAKSUL_CASES_DIR ?? ".haksulsomoim/cases"),
  computer
});
await server.connect(new StdioServerTransport2);
