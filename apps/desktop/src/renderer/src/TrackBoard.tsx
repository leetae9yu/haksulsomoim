import { useCallback, useState } from "react";
import type {
  CivilTransitionRequest,
  CriminalTransitionRequest,
  KoreanLawCitation,
  WorkflowSnapshot,
} from "../../contracts/desktop-api";
import { AgentWorkspace } from "./AgentWorkspace";
import { EnforcementPanel } from "./components/EnforcementPanel";
import { GuidancePanel } from "./components/GuidancePanel";
import { HandoffCards } from "./components/HandoffCards";
import { ProcedureTracks } from "./components/ProcedureTracks";
import { messages } from "./renderer-state";

interface TrackBoardProps {
  readonly caseId: string;
  readonly confirmedText: string;
  readonly workflow: WorkflowSnapshot;
  readonly onWorkflowChange: (snapshot: WorkflowSnapshot) => void;
}

export function TrackBoard({ caseId, confirmedText, workflow, onWorkflowChange }: TrackBoardProps) {
  const [criminalBusy, setCriminalBusy] = useState(false);
  const [civilBusy, setCivilBusy] = useState(false);
  const [criminalError, setCriminalError] = useState("");
  const [civilError, setCivilError] = useState("");
  const [citations, setCitations] = useState<readonly KoreanLawCitation[]>([]);
  const [contextRevision, setContextRevision] = useState(0);
  const updateCitations = useCallback(
    (next: readonly KoreanLawCitation[]) => setCitations([...next]),
    [],
  );

  async function advanceCriminal(command: CriminalTransitionRequest["command"]) {
    const advance = window.haksul.advanceCriminal;
    if (advance === undefined) {
      setCriminalError(messages.transitionFailed);
      return;
    }
    setCriminalBusy(true);
    setCriminalError("");
    try {
      const result = await advance({ caseId, command });
      if (result.status === "ok") {
        setContextRevision((current) => current + 1);
        onWorkflowChange(result.snapshot);
      } else setCriminalError(messages.transitionUnavailable);
    } catch {
      setCriminalError(messages.transitionFailed);
    } finally {
      setCriminalBusy(false);
    }
  }

  async function advanceCivil(command: CivilTransitionRequest["command"]) {
    const advance = window.haksul.advanceCivil;
    if (advance === undefined) {
      setCivilError(messages.transitionFailed);
      return;
    }
    setCivilBusy(true);
    setCivilError("");
    try {
      const result = await advance({ caseId, command, userAttested: true });
      if (result.status === "ok") {
        setContextRevision((current) => current + 1);
        onWorkflowChange(result.snapshot);
      } else setCivilError(messages.transitionUnavailable);
    } catch {
      setCivilError(messages.transitionFailed);
    } finally {
      setCivilBusy(false);
    }
  }

  return (
    <>
      <section className="track-board reveal" aria-label="민사 형사 절차">
        <div className="section-heading">
          <span className="section-number">03</span>
          <div>
            <h2>절차 작업판</h2>
            <p>두 트랙의 상태는 분리해 저장하며, 각 제출 사실은 사용자가 직접 확인합니다.</p>
          </div>
        </div>
        <div className="confirmed-fact">
          <span className="result-label">사용자 확인 사실</span>
          <p>{confirmedText}</p>
        </div>
        <ProcedureTracks
          civilBusy={civilBusy}
          civilError={civilError}
          criminalBusy={criminalBusy}
          criminalError={criminalError}
          onCivil={(command) => void advanceCivil(command)}
          onCriminal={(command) => void advanceCriminal(command)}
          workflow={workflow}
        />
        <EnforcementPanel caseId={caseId} civilState={workflow.civilState} />
      </section>
      <section className="integration-board reveal" aria-label="공식 근거와 사건 Agent">
        <GuidancePanel caseId={caseId} onCitations={updateCitations} />
        <AgentWorkspace
          caseId={caseId}
          key={`${caseId}:${contextRevision}`}
          officialCitationCount={citations.length}
        />
      </section>
      <HandoffCards />
    </>
  );
}
