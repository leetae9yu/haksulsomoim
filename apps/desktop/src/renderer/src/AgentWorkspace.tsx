import { useEffect, useRef, useState } from "react";
import type { AgentRunProjection } from "../../contracts/desktop-api";
import { useAgentProvider } from "./AgentProviderStatus";
import { AgentWorkspaceView } from "./AgentWorkspaceView";
import { type AgentProviderState, agentUiStatus } from "./agent-workspace-state";

type GoalChoice = "civil" | "criminal" | undefined;

interface AgentWorkspaceProps {
  readonly caseId: string;
  readonly contextDigest: string;
  readonly officialCitationCount: number;
}

const unavailableMessage =
  "Agent 연결을 사용할 수 없습니다. 기존 민사·형사 수동 절차를 계속 이용해 주세요.";
const commandMessage = "Agent 상태를 안전하게 갱신하지 못했습니다. 현재 기록을 확인해 주세요.";

export function AgentWorkspace({
  caseId,
  contextDigest,
  officialCitationCount,
}: AgentWorkspaceProps) {
  const provider = useAgentProvider();
  const [projection, setProjection] = useState<AgentRunProjection>();
  const [goal, setGoal] = useState<GoalChoice>();
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [inputValue, setInputValue] = useState("");
  const [serviceUnavailable, setServiceUnavailable] = useState(false);
  const caseRef = useRef(caseId);
  const requestRef = useRef(0);
  const approvalRef = useRef<HTMLDivElement>(null);
  caseRef.current = caseId;

  useEffect(() => {
    const requestId = ++requestRef.current;
    setProjection(undefined);
    setGoal(undefined);
    setConsent(false);
    setError("");
    setInputValue("");
    setServiceUnavailable(false);
    const list = window.haksul.listAgentRuns;
    if (list === undefined) {
      setServiceUnavailable(true);
      return;
    }
    let current = true;
    void list({ caseId })
      .then((runs) => {
        if (!current || requestId !== requestRef.current || caseRef.current !== caseId) return;
        setProjection(runs.at(-1));
      })
      .catch(() => {
        if (current && requestId === requestRef.current && caseRef.current === caseId) {
          setServiceUnavailable(true);
        }
      });
    return () => {
      current = false;
    };
  }, [caseId]);

  const runId = projection?.runId;
  useEffect(() => {
    if (runId === undefined || window.haksul.subscribeAgentRun === undefined) return;
    return window.haksul.subscribeAgentRun({ caseId, runId, contextDigest }, (event) => {
      if (caseRef.current !== caseId || event.caseId !== caseId || event.runId !== runId) return;
      setProjection(event.projection);
    });
  }, [caseId, contextDigest, runId]);

  const approvalId = projection?.pendingApproval?.approvalId;
  useEffect(() => {
    if (approvalId !== undefined) approvalRef.current?.focus();
  }, [approvalId]);

  async function commit(operation: () => Promise<AgentRunProjection>) {
    const requestId = ++requestRef.current;
    const requestCase = caseId;
    setBusy(true);
    setError("");
    try {
      const result = await operation();
      if (requestId === requestRef.current && caseRef.current === requestCase) {
        setProjection(result);
      }
    } catch {
      if (requestId === requestRef.current && caseRef.current === requestCase) {
        setError(commandMessage);
      }
    } finally {
      if (requestId === requestRef.current && caseRef.current === requestCase) setBusy(false);
    }
  }

  function start() {
    const startRun = window.haksul.startAgentRun;
    if (goal === undefined || !consent || startRun === undefined) {
      setServiceUnavailable(startRun === undefined);
      return;
    }
    const agentGoal =
      goal === "civil"
        ? { kind: "civil-recovery" as const, caseId, objective: "prepare-civil-demand" as const }
        : {
            kind: "criminal-complaint" as const,
            caseId,
            objective: "prepare-criminal-complaint" as const,
          };
    void commit(() => startRun({ caseId, contextDigest, goal: agentGoal }));
  }

  function binding() {
    if (projection === undefined) return undefined;
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
    void commit(() => command({ ...request, ...(userInput.length > 0 ? { userInput } : {}) }));
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

  const effectiveProvider: AgentProviderState = serviceUnavailable
    ? { status: "manual" }
    : provider.state;
  const status = agentUiStatus(effectiveProvider, projection);

  return (
    <AgentWorkspaceView
      approvalRef={approvalRef}
      busy={busy}
      caseId={caseId}
      consent={consent}
      contextDigest={contextDigest}
      error={serviceUnavailable && error.length === 0 ? unavailableMessage : error}
      goal={goal}
      inputValue={inputValue}
      officialCitationCount={officialCitationCount}
      projection={projection}
      provider={effectiveProvider}
      providerBusy={provider.busy}
      status={status}
      onApproval={decideApproval}
      onCancel={cancel}
      onConsent={setConsent}
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
