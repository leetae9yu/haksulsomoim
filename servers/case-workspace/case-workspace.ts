import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import {
  type CaseCreateInput,
  type CaseRecord,
  caseIdSchema,
  caseRecordSchema,
  type EvidenceAddInput,
  type EvidenceRecord,
  type TrackUpdateInput,
} from "../contracts/case-record.ts";

const criminalStages = ["evidence-review", "complaint-ready", "complaint-filed"] as const;
const civilStages = [
  "pre-filing",
  "payment-order-pending",
  "service-attested",
  "judgment-recorded",
  "enforceable-title-confirmed",
] as const;

export class CaseWorkspaceError extends Error {
  override name = "CaseWorkspaceError";
}

export type CaseWorkspaceRepositoryOptions = Readonly<{
  casesRoot: string;
  now?: () => Date;
  idFactory?: () => string;
}>;

export class CaseWorkspaceRepository {
  readonly #configuredRoot: string;
  readonly #now: () => Date;
  readonly #idFactory: () => string;
  #rootPath: Promise<string> | undefined;

  constructor(options: CaseWorkspaceRepositoryOptions) {
    this.#configuredRoot = resolve(options.casesRoot);
    this.#now = options.now ?? (() => new Date());
    this.#idFactory = options.idFactory ?? (() => randomBytes(8).toString("hex"));
  }

  async create(input: CaseCreateInput): Promise<CaseRecord> {
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
      ...(input.counterpartyAlias === undefined
        ? {}
        : { counterpartyAlias: input.counterpartyAlias }),
      evidence: [],
      criminalStage: "evidence-review",
      civilStage: "pre-filing",
    });
    let directoryCreated = false;
    try {
      await mkdir(directory);
      directoryCreated = true;
      await this.writeWorkspace(directory, record);
      return record;
    } catch (error) {
      if (directoryCreated) await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  async read(caseId: string): Promise<CaseRecord> {
    const root = await this.rootPath();
    const directory = await this.existingCaseDirectory(root, caseIdSchema.parse(caseId));
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(`${directory}/record.json`, "utf8")) as unknown;
    } catch (error) {
      throw new CaseWorkspaceError(`Cannot read case record: ${String(error)}`);
    }
    return caseRecordSchema.parse(parsed);
  }

  async addEvidence(input: EvidenceAddInput): Promise<CaseRecord> {
    const root = await this.rootPath();
    const directory = await this.existingCaseDirectory(root, input.caseId);
    const record = await this.read(input.caseId);
    const path = await this.resolveEvidencePath(root, input.path);
    const evidence: EvidenceRecord = {
      evidenceId: `evidence-${this.#idFactory()}`,
      kind: input.kind,
      path,
      description: input.description,
      sha256: await sha256(path),
      addedAt: this.timestamp(),
    };
    const updated = caseRecordSchema.parse({
      ...record,
      updatedAt: evidence.addedAt,
      evidence: [...record.evidence, evidence],
    });
    await this.writeWorkspace(directory, updated);
    return updated;
  }

  async updateTrack(input: TrackUpdateInput): Promise<CaseRecord> {
    const root = await this.rootPath();
    const directory = await this.existingCaseDirectory(root, input.caseId);
    const record = await this.read(input.caseId);
    const timestamp = this.timestamp();
    const updated =
      input.track === "criminal"
        ? this.updateCriminal(record, input.stage, timestamp)
        : this.updateCivil(record, input.stage, timestamp);
    await this.writeWorkspace(directory, updated);
    return updated;
  }

  private updateCriminal(
    record: CaseRecord,
    stage: CaseRecord["criminalStage"],
    updatedAt: string,
  ): CaseRecord {
    if (criminalStages.indexOf(stage) <= criminalStages.indexOf(record.criminalStage)) {
      throw new CaseWorkspaceError("Invalid criminal stage transition");
    }
    return caseRecordSchema.parse({ ...record, criminalStage: stage, updatedAt });
  }

  private updateCivil(
    record: CaseRecord,
    stage: CaseRecord["civilStage"],
    updatedAt: string,
  ): CaseRecord {
    if (civilStages.indexOf(stage) <= civilStages.indexOf(record.civilStage)) {
      throw new CaseWorkspaceError("Invalid civil stage transition");
    }
    return caseRecordSchema.parse({ ...record, civilStage: stage, updatedAt });
  }

  private async rootPath(): Promise<string> {
    this.#rootPath ??= this.initializeRoot();
    return this.#rootPath;
  }

  private async initializeRoot(): Promise<string> {
    await mkdir(this.#configuredRoot, { recursive: true });
    if ((await lstat(this.#configuredRoot)).isSymbolicLink()) {
      throw new CaseWorkspaceError("Cases root must not be a symlink");
    }
    return realpath(this.#configuredRoot);
  }

  private caseDirectory(root: string, caseId: string): string {
    return resolve(root, caseId);
  }

  private async existingCaseDirectory(root: string, caseId: string): Promise<string> {
    const directory = this.caseDirectory(root, caseId);
    const details = await lstat(directory).catch(() => undefined);
    if (details === undefined || !details.isDirectory() || details.isSymbolicLink()) {
      throw new CaseWorkspaceError("Case does not exist or is not a directory");
    }
    return directory;
  }

  private async resolveEvidencePath(root: string, suppliedPath: string): Promise<string> {
    if (suppliedPath.split(sep).includes("..")) {
      throw new CaseWorkspaceError("Evidence path is outside the cases root");
    }
    const candidate = resolve(root, suppliedPath);
    if (!isInside(root, candidate))
      throw new CaseWorkspaceError("Evidence path is outside the cases root");
    const details = await lstat(candidate).catch(() => undefined);
    if (details === undefined) throw new CaseWorkspaceError("Evidence path is not a local file");
    if (details.isSymbolicLink())
      throw new CaseWorkspaceError("Evidence path must not be a symlink");
    if (!details.isFile()) throw new CaseWorkspaceError("Evidence path is not a local file");
    const resolved = await realpath(candidate);
    if (resolved !== candidate || !isInside(root, resolved)) {
      throw new CaseWorkspaceError("Evidence path must not use a symlink");
    }
    return resolved;
  }

  private timestamp(): string {
    return this.#now().toISOString();
  }

  private async writeWorkspace(directory: string, record: CaseRecord): Promise<void> {
    const strictRecord = caseRecordSchema.parse(record);
    await Promise.all([
      atomicWrite(`${directory}/record.json`, `${JSON.stringify(strictRecord, null, 2)}\n`),
      atomicWrite(`${directory}/timeline.md`, timelineMarkdown(strictRecord)),
      atomicWrite(`${directory}/evidence.md`, evidenceMarkdown(strictRecord)),
      atomicWrite(
        `${directory}/criminal.md`,
        trackMarkdown("Criminal", strictRecord.criminalStage),
      ),
      atomicWrite(`${directory}/civil.md`, trackMarkdown("Civil", strictRecord.civilStage)),
    ]);
  }
}

function isInside(root: string, path: string): boolean {
  const pathRelative = relative(root, path);
  return (
    pathRelative !== "" &&
    !pathRelative.startsWith(`..${sep}`) &&
    pathRelative !== ".." &&
    !isAbsolute(pathRelative)
  );
}

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function atomicWrite(path: string, contents: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, contents, { flag: "wx" });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function timelineMarkdown(record: CaseRecord): string {
  const evidence = record.evidence
    .map((item) => `- ${item.addedAt}: Evidence added (${item.kind})`)
    .join("\n");
  return [
    "# Timeline",
    "",
    "- Case type: Domestic bank-transfer fraud",
    `- Incident date: ${record.occurredAt}`,
    `- Created: ${record.createdAt}`,
    ...(evidence === "" ? [] : [evidence]),
    "",
  ].join("\n");
}

function evidenceMarkdown(record: CaseRecord): string {
  const entries = record.evidence.map((item) =>
    [
      `## ${item.evidenceId}`,
      `- Kind: ${item.kind}`,
      `- Description: ${item.description}`,
      `- Path: ${item.path}`,
      `- SHA-256: ${item.sha256}`,
      `- Added: ${item.addedAt}`,
      "",
    ].join("\n"),
  );
  return [
    "# Evidence",
    "",
    ...(entries.length === 0 ? ["No evidence recorded.", ""] : entries),
  ].join("\n");
}

function trackMarkdown(track: string, stage: string): string {
  return `# ${track} track\n\n- Current stage: ${stage}\n`;
}
