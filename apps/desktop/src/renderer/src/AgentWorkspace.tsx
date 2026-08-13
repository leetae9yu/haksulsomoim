import { useEffect, useRef, useState } from "react";
import type { AgentRunProjection } from "../../contracts/desktop-api";
import { useAgentProvider } from "./AgentProviderStatus";
import { AgentWorkspaceView } from "./AgentWorkspaceView";
import { agentGoal } from "./agent-workspace-goal";
import { acceptAgentProjection, acceptAgentProjectionEvent } from "./agent-workspace-projection";
import { type AgentProviderState, agentUiStatus } from "./agent-workspace-state";
import { useAgentArtifact } from "./use-agent-artifact";
import { useAgentRecovery } from "./use-agent-recovery";

type GoalChoice = "civil" | "criminal" | undefined;
interface AgentWorkspaceProps {
  readonly caseId: string;
  readonly officialCitationCount: number;
}
const unavailableMessage =
  "Agent 연결을 사용할 수 없습니다. 기존 민사·형사 수동 절차를 계속 이용해 주세요.";
const commandMessage = "Agent 상태를 안전하게 갱신하지 못했습니다. 현재 기록을 확인해 주세요.";
const contextChangedMessage = "사건 컨텍스트가 변경되었습니다. 새 지문을 다시 승인해 주세요.";
export function AgentWorkspace({ caseId, officialCitationCount }: AgentWorkspaceProps) {
  const provider = useAgentProvider();
  const [projection, setProjection] = useState<AgentRunProjection>();
  const [goal, setGoal] = useState<GoalChoice>();
  const [consent, setConsent] = useState(false);
  const [contextDigest, setContextDigest] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [inputValue, setInputValue] = useState("");
  const artifactControl = useAgentArtifact(caseId, projection, contextDigest);
  const recovery = useAgentRecovery(caseId, setProjection, () => {
    setGoal(undefined);
    setConsent(false);
    setContextDigest(undefined);
    setError("");
    setInputValue("");
  });
  const { caseRef, isCurrentCase, requestRef } = recovery;
  const approvalRef = useRef<HTMLDivElement>(null);
  const runId = projection?.runId;
  useEffect(() => {
    if (
      runId === undefined ||
      contextDigest === undefined ||
      window.haksul.subscribeAgentRun === undefined
    ) {
      return;
    }
    return window.haksul.subscribeAgentRun({ caseId, runId, contextDigest }, (event) => {
      if (!isCurrentCase(caseId) || event.caseId !== caseId || event.runId !== runId) return;
      setProjection((current) => acceptAgentProjectionEvent(current, event.projection));
    });
  }, [caseId, contextDigest, isCurrentCase, runId]);
  const approvalId = projection?.pendingApproval?.approvalId;
  useEffect(() => {
    if (approvalId !== undefined) approvalRef.current?.focus();
  }, [approvalId]);
  async function commit(
    operation: () => Promise<AgentRunProjection>,
    accept = acceptAgentProjectionEvent,
  ) {
    const requestId = ++requestRef.current;
    const requestCase = caseId;
    setBusy(true);
    setError("");
    try {
      const result = await operation();
      if (requestId === requestRef.current && caseRef.current === requestCase) {
        setProjection((current) => accept(current, result));
      }
    } catch {
      if (requestId === requestRef.current && caseRef.current === requestCase) {
        setError(commandMessage);
      }
    } finally {
      if (requestId === requestRef.current && caseRef.current === requestCase) setBusy(false);
    }
  }
  async function approveContext() {
    const openCase = window.haksul.openAgentCase;
    if (openCase === undefined) {
      setError(unavailableMessage);
      return;
    }
    const requestId = ++requestRef.current;
    setBusy(true);
    setError("");
    try {
      const opened = await openCase({ caseId });
      if (requestId !== requestRef.current || caseRef.current !== caseId) return;
      setContextDigest(opened.contextDigest);
      setConsent(true);
    } catch {
      if (requestId === requestRef.current && caseRef.current === caseId) setError(commandMessage);
    } finally {
      if (requestId === requestRef.current && caseRef.current === caseId) setBusy(false);
    }
  }
  function changeConsent(value: boolean) {
    if (!value) {
      setConsent(false);
      return;
    }
    void approveContext();
  }

  async function start() {
    const openCase = window.haksul.openAgentCase;
    const startRun = window.haksul.startAgentRun;
    if (
      goal === undefined ||
      !consent ||
      contextDigest === undefined ||
      openCase === undefined ||
      startRun === undefined ||
      recovery.issue !== undefined
    ) {
      if (openCase === undefined || startRun === undefined) setError(unavailableMessage);
      return;
    }
    const selectedGoal = agentGoal(goal, caseId);
    const requestId = ++requestRef.current;
    setBusy(true);
    setError("");
    try {
      const opened = await openCase({ caseId });
      if (requestId !== requestRef.current || caseRef.current !== caseId) return;
      if (opened.contextDigest !== contextDigest) {
        setContextDigest(opened.contextDigest);
        setConsent(false);
        setError(contextChangedMessage);
        return;
      }
      const result = await startRun({
        caseId,
        contextDigest: opened.contextDigest,
        goal: selectedGoal,
      });
      if (requestId !== requestRef.current || caseRef.current !== caseId) return;
      setProjection(result);
      if (result.state.kind === "paused" && result.state.reason === "context-changed") {
        setContextDigest(undefined);
        setConsent(false);
      }
    } catch {
      if (requestId === requestRef.current && caseRef.current === caseId) setError(commandMessage);
    } finally {
      if (requestId === requestRef.current && caseRef.current === caseId) setBusy(false);
    }
  }

  function binding() {
    if (projection === undefined || contextDigest === undefined) return undefined;
    return { caseId, runId: projection.runId, contextDigest };
  }

  function pause() {
    const request = binding();
    const command = window.haksul.pauseAgentRun;
    if (request !== undefined && command !== undefined) void commit(() => command(request));
  }

  function resume() {
    const request = binding();
    const command = window.haksul.resumeAgentRun;
    if (request === undefined || command === undefined) return;
    const userInput = inputValue.trim();
    void commit(
      () => command({ ...request, ...(userInput.length > 0 ? { userInput } : {}) }),
      acceptAgentProjection,
    );
  }

  function cancel() {
    const request = binding();
    const command = window.haksul.cancelAgentRun;
    if (request !== undefined && command !== undefined) void commit(() => command(request));
  }

  function decideApproval(outcome: "approved" | "denied") {
    const approval = projection?.pendingApproval;
    const command = window.haksul.decideAgentApproval;
    if (
      projection === undefined ||
      approval === null ||
      approval === undefined ||
      command === undefined
    ) {
      return;
    }
    void commit(() =>
      command({
        caseId,
        runId: projection.runId,
        contextDigest: approval.contextDigest,
        approvalId: approval.approvalId,
        approvalDigest: approval.approvalDigest,
        outcome,
      }),
    );
  }

  const effectiveProvider: AgentProviderState =
    recovery.issue === "unavailable" ? { status: "manual" } : provider.state;
  const status =
    recovery.issue === "unresolved-tool"
      ? "unresolved-tool"
      : agentUiStatus(effectiveProvider, projection);

  return (
    <AgentWorkspaceView
      approvalRef={approvalRef}
      artifactControl={artifactControl}
      busy={busy}
      caseId={caseId}
      consent={consent}
      contextDigest={contextDigest}
      error={recovery.issue === "unavailable" && error.length === 0 ? unavailableMessage : error}
      goal={goal}
      inputValue={inputValue}
      officialCitationCount={officialCitationCount}
      projection={projection}
      provider={effectiveProvider}
      recovery={recovery}
      providerBusy={provider.busy}
      status={status}
      onApproval={decideApproval}
      onCancel={cancel}
      onConsent={changeConsent}
      onGoal={setGoal}
      onInput={setInputValue}
      onLogin={() => void provider.login()}
      onOpenLogin={() => void provider.openLogin()}
      onPause={pause}
      onRefresh={() => void provider.refresh()}
      onResume={resume}
      onStart={start}
    />
  );
}
