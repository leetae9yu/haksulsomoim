import { z } from "zod";

export type {
  ActiveAgentRun,
  AgentApprovalDecisionRequest,
  AgentRun,
  AgentRunInterruptRequest,
  AgentRunStartRequest,
} from "../main/agent/agent-contracts";
export {
  agentApprovalDecisionRequestSchema,
  agentRunInterruptRequestSchema,
  agentRunStartRequestSchema,
} from "../main/agent/agent-contracts";
export type {
  AgentApprovalDecisionIpcRequest,
  AgentOfficialCitationProjection,
  AgentRunBinding,
  AgentRunEvent,
  AgentRunListRequest,
  AgentRunProjection,
  AgentRunResumeRequest,
  AgentRunStartIpcRequest,
  AgentStepSummary,
} from "../main/agent/agent-ipc-contracts";
export {
  agentApprovalDecisionIpcRequestSchema,
  agentRunCancelRequestSchema,
  agentRunEventSchema,
  agentRunGetRequestSchema,
  agentRunListRequestSchema,
  agentRunListResponseSchema,
  agentRunPauseRequestSchema,
  agentRunProjectionSchema,
  agentRunResumeRequestSchema,
  agentRunStartIpcRequestSchema,
  agentRunSubscribeRequestSchema,
} from "../main/agent/agent-ipc-contracts";

import type {
  AgentApprovalDecisionIpcRequest,
  AgentRunBinding,
  AgentRunEvent,
  AgentRunListRequest,
  AgentRunProjection,
  AgentRunResumeRequest,
  AgentRunStartIpcRequest,
} from "../main/agent/agent-ipc-contracts";

const caseId = z.string().min(1).max(255);
const evidenceId = z.string().min(1).max(255);
const emptyRequest = z.strictObject({});

export const caseCreateRequestSchema = z.strictObject({
  amountKrw: z.number().int().min(1).max(30_000_000),
  jurisdiction: z.literal("domestic"),
  paymentMethod: z.literal("bank-transfer"),
});
export type CaseCreateRequest = z.infer<typeof caseCreateRequestSchema>;

export const evidenceAnalyzeRequestSchema = z.strictObject({
  caseId,
  filename: z.string().min(1).max(255),
  mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]),
  bytes: z
    .array(z.number().int().min(0).max(255))
    .min(1)
    .max(20 * 1024 * 1024),
});
export type EvidenceAnalyzeIpcRequest = z.infer<typeof evidenceAnalyzeRequestSchema>;
export type EvidenceAnalyzeRequest = Omit<EvidenceAnalyzeIpcRequest, "caseId"> &
  Readonly<{ caseId?: string }>;

export const confirmedFactSchema = z.strictObject({
  field: z.string().min(1).max(255),
  value: z.string().min(1).max(4096),
});
export type ConfirmedFact = z.infer<typeof confirmedFactSchema>;

export const confirmOcrFactsRequestSchema = z.strictObject({
  caseId,
  evidenceId,
  facts: z.array(confirmedFactSchema).min(1).max(100),
});
export type ConfirmOcrFactsRequest = z.infer<typeof confirmOcrFactsRequestSchema>;

export const criminalTransitionRequestSchema = z.strictObject({
  caseId,
  command: z.enum(["prepare-complaint", "file-complaint"]),
});
export type CriminalTransitionRequest = z.infer<typeof criminalTransitionRequestSchema>;

export const civilTransitionRequestSchema = z.strictObject({
  caseId,
  command: z.enum(["apply-payment-order", "attest-service", "record-judgment", "attest-finality"]),
  userAttested: z.boolean(),
});
export type CivilTransitionRequest = z.infer<typeof civilTransitionRequestSchema>;

export const enforcementChoicesRequestSchema = z.strictObject({ caseId });
export type EnforcementChoicesRequest = z.infer<typeof enforcementChoicesRequestSchema>;

export const guidanceRequestSchema = z.strictObject({
  caseId,
  query: z.string().trim().min(1).max(2000),
});
export type GuidanceRequest = z.infer<typeof guidanceRequestSchema>;

const officialSourceOrigins = new Set([
  "https://law.go.kr",
  "https://www.law.go.kr",
  "https://scourt.go.kr",
  "https://ecrm.police.go.kr",
]);
export const officialSourceRequestSchema = z.strictObject({
  url: z
    .string()
    .max(2048)
    .refine((value) => {
      try {
        return officialSourceOrigins.has(new URL(value).origin);
      } catch {
        return false;
      }
    }, "URL must use an approved official HTTPS origin"),
});
export type OfficialSourceRequest = z.infer<typeof officialSourceRequestSchema>;

export const trustedAuthenticationRequestSchema = z.strictObject({
  url: z
    .string()
    .max(2048)
    .refine((value) => {
      try {
        return new URL(value).origin === "https://auth.openai.com";
      } catch {
        return false;
      }
    }, "URL must use the trusted authentication HTTPS origin"),
});
export type TrustedAuthenticationRequest = z.infer<typeof trustedAuthenticationRequestSchema>;

export const codexStatusRequestSchema = emptyRequest;
export const codexLoginRequestSchema = emptyRequest;
export type EmptyRequest = z.infer<typeof emptyRequest>;
export const codexSuggestionRequestSchema = z.strictObject({
  caseId,
  approval: z.literal("user-approved"),
  citationIds: z.array(z.string().min(1).max(255)).max(100),
});
export type CodexSuggestionRequest = z.infer<typeof codexSuggestionRequestSchema>;

export type WorkflowSnapshot = Readonly<{
  criminalState: "evidence-review" | "complaint-ready" | "complaint-filed";
  civilState:
    | "pre-filing"
    | "payment-order-pending"
    | "service-attested"
    | "judgment-recorded"
    | "enforceable-title-confirmed";
}>;

export type CaseCreateResponse =
  | Readonly<{ status: "accepted"; caseId: string; amountKrw: number } & WorkflowSnapshot>
  | Readonly<{ status: "out-of-scope"; reason: string }>;

export type EvidenceAnalyzeResponse = Readonly<
  {
    evidenceId: string;
    sha256: string;
    needsManualConfirmation: true;
  } & (
    | { status: "candidates"; text: string; confidence: number }
    | { status: "unreadable"; reason: string }
  )
>;

export type TransitionResponse =
  | Readonly<{ status: "ok"; snapshot: WorkflowSnapshot }>
  | Readonly<{ status: "not-allowed"; reason: string }>;

export type EnforcementChoice = Readonly<{
  kind: "asset-inquiry" | "seizure-and-collection" | "debtor-registry";
  condition:
    | "enforceable-title-confirmed"
    | "attachable-asset-identified"
    | "statutory-requirements-met";
}>;
export type EnforcementChoicesResponse =
  | Readonly<{ status: "ok"; choices: readonly EnforcementChoice[] }>
  | Readonly<{ status: "not-allowed"; reason: string }>;

export type KoreanLawCitation = Readonly<{
  id: string;
  sourceUrl: string;
  law: string;
  versionDate: string;
  retrievedAt: string;
}>;
export type GuidanceResponse =
  | Readonly<{ status: "ok"; content: unknown; citations: readonly KoreanLawCitation[] }>
  | Readonly<{ status: "needs-credentials"; credential: "LAW_OC" }>
  | Readonly<{ status: "error"; message: string }>;

export type CodexStatusResponse =
  | Readonly<{ status: "offline"; mode: "manual"; reason: string }>
  | Readonly<{ status: "sign-in-required"; action: "sign-in-with-chatgpt" }>
  | Readonly<{
      status: "authenticated";
      account: Readonly<{ type: "chatgpt"; email: string | null; planType: string }>;
    }>;
export type CodexLoginResponse = Readonly<{
  loginId: string;
  authorizationUrl: string;
}>;
export type CodexSuggestionResponse = Readonly<{
  text: string;
  citationIds: readonly string[];
}>;

export interface DesktopApi {
  createCase(request: CaseCreateRequest): Promise<CaseCreateResponse>;
  analyzeEvidence(request: EvidenceAnalyzeRequest): Promise<EvidenceAnalyzeResponse>;
  confirmOcrFacts?(request: ConfirmOcrFactsRequest): Promise<TransitionResponse>;
  advanceCriminal?(request: CriminalTransitionRequest): Promise<TransitionResponse>;
  advanceCivil?(request: CivilTransitionRequest): Promise<TransitionResponse>;
  enforcementChoices?(request: EnforcementChoicesRequest): Promise<EnforcementChoicesResponse>;
  guidance?(request: GuidanceRequest): Promise<GuidanceResponse>;
  openOfficialSource?(request: OfficialSourceRequest): Promise<void>;
  openTrustedAuthentication?(request: TrustedAuthenticationRequest): Promise<void>;
  codexStatus?(request: EmptyRequest): Promise<CodexStatusResponse>;
  codexLogin?(request: EmptyRequest): Promise<CodexLoginResponse>;
  codexSuggestion?(request: CodexSuggestionRequest): Promise<CodexSuggestionResponse>;
  startAgentRun?(request: AgentRunStartIpcRequest): Promise<AgentRunProjection>;
  getAgentRun?(request: AgentRunBinding): Promise<AgentRunProjection>;
  listAgentRuns?(request: AgentRunListRequest): Promise<readonly AgentRunProjection[]>;
  pauseAgentRun?(request: AgentRunBinding): Promise<AgentRunProjection>;
  resumeAgentRun?(request: AgentRunResumeRequest): Promise<AgentRunProjection>;
  cancelAgentRun?(request: AgentRunBinding): Promise<AgentRunProjection>;
  decideAgentApproval?(request: AgentApprovalDecisionIpcRequest): Promise<AgentRunProjection>;
  subscribeAgentRun?(
    request: AgentRunBinding,
    listener: (event: AgentRunEvent) => void,
  ): () => void;
}
