import {
  type CaseCreateResponse,
  type CodexLoginResponse,
  type CodexStatusResponse,
  type CodexSuggestionResponse,
  caseCreateRequestSchema,
  civilTransitionRequestSchema,
  codexLoginRequestSchema,
  codexStatusRequestSchema,
  codexSuggestionRequestSchema,
  confirmOcrFactsRequestSchema,
  criminalTransitionRequestSchema,
  type EnforcementChoicesResponse,
  type EvidenceAnalyzeResponse,
  enforcementChoicesRequestSchema,
  evidenceAnalyzeRequestSchema,
  type GuidanceResponse,
  guidanceRequestSchema,
  officialSourceRequestSchema,
  type TransitionResponse,
  trustedAuthenticationRequestSchema,
} from "../contracts/desktop-api";
import type { CaseRuntimeService } from "./runtime-case-service";

export interface DesktopHandlers {
  createCase(request: unknown): Promise<CaseCreateResponse>;
  analyzeEvidence(request: unknown): Promise<EvidenceAnalyzeResponse>;
  confirmOcrFacts(request: unknown): Promise<TransitionResponse>;
  advanceCriminal(request: unknown): Promise<TransitionResponse>;
  advanceCivil(request: unknown): Promise<TransitionResponse>;
  enforcementChoices(request: unknown): Promise<EnforcementChoicesResponse>;
  guidance(request: unknown): Promise<GuidanceResponse>;
  codexStatus(request: unknown): Promise<CodexStatusResponse>;
  codexLogin(request: unknown): Promise<CodexLoginResponse>;
  codexSuggestion(request: unknown): Promise<CodexSuggestionResponse>;
}

export function createOpenOfficialSourceHandler(
  openExternal: (url: string) => Promise<void>,
): (request: unknown) => Promise<void> {
  return async (request) => {
    const parsed = officialSourceRequestSchema.parse(request);
    await openExternal(parsed.url);
  };
}

export function createOpenTrustedAuthenticationHandler(
  openExternal: (url: string) => Promise<void>,
): (request: unknown) => Promise<void> {
  return async (request) => {
    const parsed = trustedAuthenticationRequestSchema.parse(request);
    await openExternal(parsed.url);
  };
}

export function createDesktopHandlers(service: CaseRuntimeService): DesktopHandlers {
  return {
    async createCase(request) {
      const parsed = caseCreateRequestSchema.parse(request);
      return service.createCase({ amountKrw: parsed.amountKrw });
    },
    async analyzeEvidence(request) {
      const parsed = evidenceAnalyzeRequestSchema.parse(request);
      return service.analyzeEvidence({ ...parsed, bytes: Uint8Array.from(parsed.bytes) });
    },
    async confirmOcrFacts(request) {
      return service.confirmOcrFacts(confirmOcrFactsRequestSchema.parse(request));
    },
    async advanceCriminal(request) {
      const parsed = criminalTransitionRequestSchema.parse(request);
      return service.advanceCriminal(parsed.caseId, parsed.command);
    },
    async advanceCivil(request) {
      const parsed = civilTransitionRequestSchema.parse(request);
      return service.advanceCivil(parsed.caseId, parsed.command, parsed.userAttested);
    },
    async enforcementChoices(request) {
      const parsed = enforcementChoicesRequestSchema.parse(request);
      return service.enforcementChoices(parsed.caseId);
    },
    async guidance(request) {
      const parsed = guidanceRequestSchema.parse(request);
      return service.guidance(parsed.caseId, parsed.query);
    },
    async codexStatus(request) {
      codexStatusRequestSchema.parse(request);
      return service.codexStatus();
    },
    async codexLogin(request) {
      codexLoginRequestSchema.parse(request);
      return service.codexLogin();
    },
    async codexSuggestion(request) {
      return service.suggest(codexSuggestionRequestSchema.parse(request));
    },
  };
}
