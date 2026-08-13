import type { ApprovedAgentDecisionContext } from "../../integrations/agent-provider/agent-provider";
import type { RedactedText } from "../../security/redaction";
import type { AgentToolLeaseTransition } from "./agent-case-tool-lease";
import type { AgentGoal, AgentRun } from "./agent-contracts";
import type { AgentRunSnapshot } from "./agent-run-repository";

export interface AgentRunStore {
  create(run: AgentRun): Promise<void>;
  createOwned(run: AgentRun): Promise<void>;
  transitionToolLease(transition: AgentToolLeaseTransition): Promise<void>;
  releaseOwned(caseId: string, runId: string): Promise<void>;
  load(runId: string): Promise<AgentRunSnapshot>;
  save(snapshot: AgentRunSnapshot): Promise<void>;
}

export interface AgentCaseProjection {
  readonly caseId: string;
  readonly contextDigest: string;
  readonly maskedFacts: readonly Readonly<{ id: string; text: RedactedText }>[];
  readonly citationIds: readonly string[];
  readonly workflow: Readonly<{ criminalState: string; civilState: string }>;
  readonly evidenceCount: number;
  readonly confirmedFactCount: number;
}

export interface AgentCaseProjectionReader {
  load(caseId: string): Promise<AgentCaseProjection>;
}

export interface AgentLoopProvider {
  readonly state: Readonly<{
    status: "authenticated" | "sign-in-required" | "unavailable";
  }>;
  nextDecision(input: ApprovedAgentDecisionContext): Promise<unknown>;
  interrupt(): Promise<void>;
}

export interface AgentLoopClock {
  now(): number;
}

export interface AgentLoopIdentifiers {
  nextRunId(): string;
  nextDecisionId(): string;
  nextToolCallId(): string;
  nextApprovalId(): string;
  nextStepId(): string;
}

export type AgentLoopStartInput = Readonly<{
  caseId: string;
  goal: AgentGoal;
  approvedContextDigest: string;
}>;

export type AgentLoopRunReference = Readonly<{
  caseId: string;
  runId: string;
}>;

export type AgentLoopApprovalInput = AgentLoopRunReference &
  Readonly<{
    approvalId: string;
    approvalDigest: string;
    outcome: "approved" | "denied";
  }>;

export type AgentLoopApprovalResolution = Readonly<{
  status: "recorded" | "stale";
  run: AgentRun;
}>;
