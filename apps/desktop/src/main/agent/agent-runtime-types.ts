import type { AgentRun } from "./agent-contracts";
import type {
  AgentLoopApprovalInput,
  AgentLoopApprovalResolution,
  AgentLoopStartInput,
} from "./agent-loop-types";

export type AgentUnavailableReason = "provider-initialization" | "mcp-initialization";
export type AgentRuntimeResult =
  | Readonly<{ status: "completed"; run: AgentRun }>
  | Readonly<{ status: "unavailable"; reason: AgentUnavailableReason }>;
export type AgentRuntimeBeginResult =
  | Readonly<{ status: "unavailable"; reason: AgentUnavailableReason }>
  | Readonly<{ status: "started"; run: AgentRun; completion: Promise<AgentRun> }>;

export type AgentResumeInput = Readonly<{
  caseId: string;
  runId: string;
  approvedContextDigest: string;
}>;

export interface DesktopAgentRuntime {
  openCase(caseId: string): Promise<
    Readonly<{
      contextDigest: string;
      interruptedRun?: AgentRun;
    }>
  >;
  begin(input: AgentLoopStartInput): Promise<AgentRuntimeBeginResult>;
  start(input: AgentLoopStartInput): Promise<AgentRuntimeResult>;
  beginResume(input: AgentResumeInput): Promise<AgentRuntimeBeginResult>;
  resume(input: AgentResumeInput): Promise<AgentRuntimeResult>;
  pause(input: Readonly<{ caseId: string; runId: string }>): Promise<AgentRun>;
  decideApproval(input: AgentLoopApprovalInput): Promise<AgentLoopApprovalResolution>;
  cancel(input: Readonly<{ caseId: string; runId: string }>): Promise<AgentRun>;
  subscribe(listener: (run: AgentRun) => void): () => void;
  dispose(): Promise<void>;
}
