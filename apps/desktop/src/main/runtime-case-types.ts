import type { CaseWorkflow } from "../domain/case-workflow";
import type { KoreanLawCitation } from "../integrations/korean-law-mcp/korean-law-mcp";

export interface RuntimeCaseDossier {
  readonly caseId: string;
  readonly amountKrw: number;
  readonly evidence: readonly Readonly<{
    evidenceId: string;
    filename: string;
    mimeType: "image/png" | "image/jpeg" | "image/webp";
    sha256: string;
  }>[];
  readonly confirmedOcrFacts: readonly Readonly<{ field: string; value: string }>[];
  readonly retrievedCitations: readonly KoreanLawCitation[];
  readonly workflow: CaseWorkflow;
}

export interface RuntimeCaseRepository {
  create(dossier: RuntimeCaseDossier): Promise<void>;
  read(caseId: string): Promise<RuntimeCaseDossier>;
  save(dossier: RuntimeCaseDossier): Promise<void>;
}

export const workflowSnapshot = (workflow: CaseWorkflow) => ({
  criminalState: workflow.criminalState,
  civilState: workflow.civilState,
});
