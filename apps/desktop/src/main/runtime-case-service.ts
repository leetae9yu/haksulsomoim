import type {
  CodexStatusResponse,
  EnforcementChoicesResponse,
  GuidanceResponse,
  TransitionResponse,
} from "../contracts/desktop-api";
import {
  advanceCivil,
  advanceCriminal,
  type CaseWorkflow,
  confirmOcrFacts,
  enforcementChoices,
  parseCaseInput,
} from "../domain/case-workflow";
import {
  type CodexAgentProvider,
  createUserApprovedSuggestionInput,
} from "../integrations/agent-provider/agent-provider";
import type { KoreanLawMcpAdapter } from "../integrations/korean-law-mcp/korean-law-mcp";
import type { LocalOcrResult } from "../ocr/local-ocr";
import type { Redactor } from "../security/redaction";
import { lookupLegalGuidance } from "./legal-guidance";
import { RuntimeCaseMutationQueue } from "./runtime-case-mutation-queue";
import { type RuntimeCaseRepository, workflowSnapshot } from "./runtime-case-types";

export type { RuntimeCaseDossier, RuntimeCaseRepository } from "./runtime-case-types";

interface Dependencies {
  repository: RuntimeCaseRepository;
  nextCaseId(): string;
  storeEvidence(bytes: Uint8Array): Promise<Readonly<{ id: string; sha256: string }>>;
  analyzeEvidence(bytes: Uint8Array): Promise<LocalOcrResult>;
  redactor: Redactor;
  law: KoreanLawMcpAdapter;
  provider(): Promise<CodexAgentProvider>;
}

export class CaseRuntimeService {
  readonly #dependencies: Dependencies;
  readonly #mutations = new RuntimeCaseMutationQueue();

  constructor(dependencies: Dependencies) {
    this.#dependencies = dependencies;
  }

  async createCase(input: Readonly<{ amountKrw: number }>) {
    const result = parseCaseInput({
      jurisdiction: "KR-domestic",
      paymentMethod: "bank-transfer",
      currency: "KRW",
      amount: input.amountKrw,
      ocrFacts: [{ field: "claimed-amount", value: String(input.amountKrw) }],
    });
    if (result.status !== "accepted")
      return { status: "out-of-scope" as const, reason: result.reason };
    const caseId = this.#dependencies.nextCaseId();
    await this.#dependencies.repository.create({
      caseId,
      amountKrw: input.amountKrw,
      evidence: [],
      confirmedOcrFacts: [],
      retrievedCitations: [],
      workflow: result.value,
    });
    return {
      status: "accepted" as const,
      caseId,
      amountKrw: input.amountKrw,
      ...workflowSnapshot(result.value),
    };
  }

  async analyzeEvidence(
    input: Readonly<{
      caseId: string;
      filename: string;
      mimeType: "image/png" | "image/jpeg" | "image/webp";
      bytes: Uint8Array;
    }>,
  ) {
    await this.#dependencies.repository.read(input.caseId);
    const stored = await this.#dependencies.storeEvidence(input.bytes);
    await this.#mutations.run(input.caseId, async () => {
      const dossier = await this.#dependencies.repository.read(input.caseId);
      await this.#dependencies.repository.save({
        ...dossier,
        evidence: [
          ...dossier.evidence,
          {
            evidenceId: stored.id,
            filename: input.filename,
            mimeType: input.mimeType,
            sha256: stored.sha256,
          },
        ],
      });
    });
    const ocr = await this.#dependencies.analyzeEvidence(input.bytes);
    if (ocr.status === "unreadable") {
      return {
        status: "unreadable" as const,
        evidenceId: stored.id,
        sha256: stored.sha256,
        reason: ocr.reason,
        needsManualConfirmation: true as const,
      };
    }
    const confidence =
      ocr.candidates.reduce((sum, candidate) => sum + candidate.confidence, 0) /
      ocr.candidates.length;
    return {
      status: "candidates" as const,
      evidenceId: stored.id,
      sha256: stored.sha256,
      text: ocr.candidates.map((candidate) => candidate.text).join(" "),
      confidence,
      needsManualConfirmation: true as const,
    };
  }

  async confirmOcrFacts(
    input: Readonly<{
      caseId: string;
      evidenceId: string;
      facts: readonly Readonly<{ field: string; value: string }>[];
    }>,
  ): Promise<TransitionResponse> {
    return this.#mutations.run(input.caseId, async () => {
      const dossier = await this.#dependencies.repository.read(input.caseId);
      if (!dossier.evidence.some((item) => item.evidenceId === input.evidenceId)) {
        throw new Error("Evidence is not attached to this case");
      }
      const parsed = parseCaseInput({
        jurisdiction: "KR-domestic",
        paymentMethod: "bank-transfer",
        currency: "KRW",
        amount: dossier.amountKrw,
        ocrFacts: input.facts,
      });
      if (parsed.status !== "accepted") throw new Error("Confirmed OCR facts are invalid");
      const confirmed = confirmOcrFacts({
        ...parsed.value,
        criminalState: dossier.workflow.criminalState,
        civilState: dossier.workflow.civilState,
      });
      if (confirmed.status !== "ok") return confirmed;
      await this.#dependencies.repository.save({
        ...dossier,
        confirmedOcrFacts: input.facts,
        workflow: confirmed.value,
      });
      return { status: "ok" as const, snapshot: workflowSnapshot(confirmed.value) };
    });
  }

  async advanceCriminal(caseId: string, command: "prepare-complaint" | "file-complaint") {
    return this.#transition(caseId, (workflow) => advanceCriminal(workflow, command));
  }

  async advanceCivil(
    caseId: string,
    command: "apply-payment-order" | "attest-service" | "record-judgment" | "attest-finality",
    userAttested: boolean,
  ) {
    const run = (workflow: CaseWorkflow) =>
      command === "attest-service" || command === "attest-finality"
        ? advanceCivil(workflow, command, userAttested)
        : advanceCivil(workflow, command);
    return this.#transition(caseId, run);
  }

  async enforcementChoices(caseId: string): Promise<EnforcementChoicesResponse> {
    const result = enforcementChoices((await this.#dependencies.repository.read(caseId)).workflow);
    return result.status === "ok"
      ? { status: "ok", choices: result.value }
      : { status: "not-allowed", reason: result.reason };
  }

  async guidance(caseId: string, query: string): Promise<GuidanceResponse> {
    await this.#dependencies.repository.read(caseId);
    const result = await lookupLegalGuidance(this.#dependencies.law, query);
    if (result.status === "needs-credentials") {
      return { status: "needs-credentials", credential: "LAW_OC" };
    }
    if (result.status === "error") {
      return result;
    }
    const citations = result.citations;
    await this.#mutations.run(caseId, async () => {
      const dossier = await this.#dependencies.repository.read(caseId);
      const byId = new Map(
        dossier.retrievedCitations.map((citation) => [citation.citationId, citation]),
      );
      for (const citation of citations) byId.set(citation.citationId, citation);
      await this.#dependencies.repository.save({
        ...dossier,
        retrievedCitations: [...byId.values()],
      });
    });
    return {
      status: "ok",
      content: result.content,
      citations: citations.map((citation) => ({
        id: citation.citationId,
        sourceUrl: citation.sourceUrl,
        law: citation.law,
        versionDate: citation.versionDate,
        retrievedAt: citation.retrievedAt,
      })),
    };
  }

  async codexStatus(): Promise<CodexStatusResponse> {
    const state = (await this.#dependencies.provider()).state;
    if (state.status === "unavailable") {
      return { status: "offline", mode: "manual", reason: state.detail };
    }
    return state;
  }

  async codexLogin() {
    return (await this.#dependencies.provider()).startChatGptLogin();
  }

  async suggest(
    input: Readonly<{
      caseId: string;
      approval: "user-approved";
      citationIds: readonly string[];
    }>,
  ) {
    const dossier = await this.#dependencies.repository.read(input.caseId);
    const retrieved = new Set(dossier.retrievedCitations.map((citation) => citation.citationId));
    if (input.citationIds.some((citationId) => !retrieved.has(citationId))) {
      throw new Error("Every citation ID must have been retrieved for this case");
    }
    const summary = [
      { id: "amount-krw", text: `amountKrw: ${dossier.amountKrw}` },
      { id: "criminal-state", text: `criminalState: ${dossier.workflow.criminalState}` },
      { id: "civil-state", text: `civilState: ${dossier.workflow.civilState}` },
    ] as const;
    const maskedFacts = summary.map((fact) => ({
      id: fact.id,
      text: this.#dependencies.redactor.redact(input.caseId, fact.text),
    }));
    const approved = createUserApprovedSuggestionInput(maskedFacts, input.citationIds);
    return (await this.#dependencies.provider()).suggest(approved);
  }

  async #transition(
    caseId: string,
    transition: (workflow: CaseWorkflow) => ReturnType<typeof advanceCriminal>,
  ): Promise<TransitionResponse> {
    return this.#mutations.run(caseId, async () => {
      const dossier = await this.#dependencies.repository.read(caseId);
      const result = transition(dossier.workflow);
      if (result.status !== "ok") return result;
      await this.#dependencies.repository.save({ ...dossier, workflow: result.value });
      return { status: "ok" as const, snapshot: workflowSnapshot(result.value) };
    });
  }
}
