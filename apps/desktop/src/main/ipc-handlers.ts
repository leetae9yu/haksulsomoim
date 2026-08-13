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
import {
  type AgentArtifactView,
  agentArtifactOpenRequestSchema,
  agentArtifactViewSchema,
} from "./agent/agent-artifact-ipc-contracts";
import {
  type AgentApprovalDecisionIpcRequest,
  type AgentCaseContext,
  type AgentRunBinding,
  type AgentRunEvent,
  type AgentRunListRequest,
  type AgentRunProjection,
  type AgentRunResumeRequest,
  type AgentRunStartIpcRequest,
  agentApprovalDecisionIpcRequestSchema,
  agentCaseContextSchema,
  agentCaseOpenRequestSchema,
  agentRunCancelRequestSchema,
  agentRunGetRequestSchema,
  agentRunListRequestSchema,
  agentRunListResponseSchema,
  agentRunPauseRequestSchema,
  agentRunProjectionSchema,
  agentRunResumeRequestSchema,
  agentRunStartIpcRequestSchema,
  agentRunSubscribeRequestSchema,
} from "./agent/agent-ipc-contracts";
import { toAgentRunEvent, toAgentRunProjection } from "./agent/agent-ipc-mapper";
import type { CaseRuntimeService } from "./runtime-case-service";

export interface AgentLifecycleHandlers {
  openAgentCase(request: unknown): Promise<AgentCaseContext>;
  openAgentArtifact(request: unknown): Promise<AgentArtifactView>;
  startAgentRun(request: unknown): Promise<AgentRunProjection>;
  getAgentRun(request: unknown): Promise<AgentRunProjection>;
  listAgentRuns(request: unknown): Promise<readonly AgentRunProjection[]>;
  pauseAgentRun(request: unknown): Promise<AgentRunProjection>;
  resumeAgentRun(request: unknown): Promise<AgentRunProjection>;
  cancelAgentRun(request: unknown): Promise<AgentRunProjection>;
  decideAgentApproval(request: unknown): Promise<AgentRunProjection>;
  subscribeAgentRun(request: unknown, listener: (event: AgentRunEvent) => void): () => void;
}

export interface AgentLifecycleService {
  openCase(caseId: string): Promise<unknown>;
  openArtifact(request: unknown): Promise<unknown>;
  start(
    request: Readonly<{ caseId: string; goal: unknown; approvedContextDigest: string }>,
  ): Promise<unknown>;
  get(request: AgentRunBinding): Promise<unknown>;
  list(request: AgentRunListRequest): Promise<readonly unknown[]>;
  pause(request: AgentRunBinding): Promise<unknown>;
  resume(request: AgentRunResumeRequest): Promise<unknown>;
  cancel(request: AgentRunBinding): Promise<unknown>;
  decideApproval(
    request: AgentApprovalDecisionIpcRequest,
  ): Promise<Readonly<{ status: "recorded" | "stale"; run: unknown }>>;
  subscribe(request: AgentRunBinding, listener: (event: unknown) => void): () => void;
}

export interface DesktopHandlers extends AgentLifecycleHandlers {
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

function boundProjection(
  value: unknown,
  binding: Readonly<{ caseId: string; runId?: string }>,
): AgentRunProjection {
  const projection = agentRunProjectionSchema.parse(toAgentRunProjection(value));
  if (
    projection.caseId !== binding.caseId ||
    (binding.runId !== undefined && projection.runId !== binding.runId)
  ) {
    throw new Error("Agent service returned a mismatched case or run");
  }
  return projection;
}

export function createAgentLifecycleHandlers(
  service: AgentLifecycleService,
): AgentLifecycleHandlers {
  const runCommand = async (
    request: unknown,
    schema: typeof agentRunGetRequestSchema,
    command: (parsed: AgentRunBinding) => Promise<unknown>,
  ) => {
    const parsed = schema.parse(request);
    return boundProjection(await command(parsed), parsed);
  };
  return {
    async openAgentCase(request) {
      const parsed = agentCaseOpenRequestSchema.parse(request);
      const context = agentCaseContextSchema.parse(await service.openCase(parsed.caseId));
      if (context.caseId !== parsed.caseId) throw new Error("Agent service returned another case");
      return context;
    },
    async openAgentArtifact(request) {
      const parsed = agentArtifactOpenRequestSchema.parse(request);
      return agentArtifactViewSchema.parse(await service.openArtifact(parsed));
    },
    async startAgentRun(request) {
      const parsed: AgentRunStartIpcRequest = agentRunStartIpcRequestSchema.parse(request);
      const run = await service.start({
        caseId: parsed.caseId,
        goal: parsed.goal,
        approvedContextDigest: parsed.contextDigest,
      });
      return boundProjection(run, parsed);
    },
    getAgentRun: (request) =>
      runCommand(request, agentRunGetRequestSchema, service.get.bind(service)),
    async listAgentRuns(request) {
      const parsed = agentRunListRequestSchema.parse(request);
      const runs = (await service.list(parsed)).map((run) => boundProjection(run, parsed));
      return agentRunListResponseSchema.parse(runs);
    },
    pauseAgentRun: (request) =>
      runCommand(request, agentRunPauseRequestSchema, service.pause.bind(service)),
    async resumeAgentRun(request) {
      const parsed = agentRunResumeRequestSchema.parse(request);
      return boundProjection(await service.resume(parsed), parsed);
    },
    cancelAgentRun: (request) =>
      runCommand(request, agentRunCancelRequestSchema, service.cancel.bind(service)),
    async decideAgentApproval(request) {
      const parsed = agentApprovalDecisionIpcRequestSchema.parse(request);
      const result = await service.decideApproval(parsed);
      if (result.status === "stale") throw new Error("Rejected stale Agent approval");
      return boundProjection(result.run, parsed);
    },
    subscribeAgentRun(request, listener) {
      const parsed = agentRunSubscribeRequestSchema.parse(request);
      return service.subscribe(parsed, (value) => {
        const event = toAgentRunEvent(value, parsed);
        if (event !== undefined) listener(event);
      });
    },
  };
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

export function createDesktopHandlers(
  service: CaseRuntimeService,
  agent: AgentLifecycleService,
): DesktopHandlers {
  return {
    ...createAgentLifecycleHandlers(agent),
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
