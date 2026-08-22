import {
  type CaseRecord,
  caseCreateInputSchema,
  caseIdSchema,
  evidenceAddInputSchema,
  type MaskedCaseSummary,
  trackUpdateInputSchema,
} from "../contracts/case-record.ts";
import { CaseWorkspaceRepository } from "./case-workspace.ts";

export type CaseWorkspaceOptions = Readonly<{
  casesRoot: string;
  now?: () => Date;
  idFactory?: () => string;
}>;

export class CaseWorkspace {
  readonly #repository: CaseWorkspaceRepository;

  constructor(options: CaseWorkspaceOptions) {
    this.#repository = new CaseWorkspaceRepository({
      casesRoot: options.casesRoot,
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.idFactory === undefined ? {} : { idFactory: options.idFactory }),
    });
  }

  async create(input: unknown): Promise<MaskedCaseSummary> {
    return masked(await this.#repository.create(caseCreateInputSchema.parse(input)));
  }

  async getMasked(caseId: string): Promise<MaskedCaseSummary> {
    return masked(await this.#repository.read(caseIdSchema.parse(caseId)));
  }

  async addEvidence(input: unknown): Promise<MaskedCaseSummary> {
    return masked(await this.#repository.addEvidence(evidenceAddInputSchema.parse(input)));
  }

  async updateTrack(input: unknown): Promise<MaskedCaseSummary> {
    return masked(await this.#repository.updateTrack(trackUpdateInputSchema.parse(input)));
  }
}

function masked(record: CaseRecord): MaskedCaseSummary {
  return {
    caseId: record.caseId,
    amountKrw: record.amountKrw,
    occurredAt: record.occurredAt,
    summary: "[MASKED]",
    ...(record.counterpartyAlias === undefined ? {} : { counterpartyAlias: "[MASKED]" }),
    evidenceCount: record.evidence.length,
    criminalStage: record.criminalStage,
    civilStage: record.civilStage,
    updatedAt: record.updatedAt,
  };
}

export type { CaseWorkspaceRepositoryOptions } from "./case-workspace.ts";
export { CaseWorkspaceError, CaseWorkspaceRepository } from "./case-workspace.ts";
