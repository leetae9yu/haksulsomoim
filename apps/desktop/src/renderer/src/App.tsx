import { type SyntheticEvent, useRef, useState } from "react";
import type {
  CaseCreateResponse,
  EvidenceAnalyzeResponse,
  WorkflowSnapshot,
} from "../../contracts/desktop-api";
import { ProgressRail, Topbar } from "./components/AppChrome";
import { CaseIntake, CaseSummary, Hero } from "./components/CaseIntake";
import { EvidencePanel } from "./components/EvidencePanel";
import {
  isSupportedMime,
  MAX_CONFIRMED_TEXT,
  messages,
  validateEvidenceFile,
  workflowStep,
} from "./renderer-state";
import { TrackBoard } from "./TrackBoard";

type AcceptedCase = Extract<CaseCreateResponse, { status: "accepted" }>;

export function App() {
  const [amount, setAmount] = useState("");
  const [activeCase, setActiveCase] = useState<AcceptedCase>();
  const [workflow, setWorkflow] = useState<WorkflowSnapshot>();
  const [evidence, setEvidence] = useState<EvidenceAnalyzeResponse>();
  const [fileName, setFileName] = useState("");
  const [manualText, setManualText] = useState("");
  const [confirmedText, setConfirmedText] = useState("");
  const [caseError, setCaseError] = useState("");
  const [evidenceError, setEvidenceError] = useState("");
  const [caseBusy, setCaseBusy] = useState(false);
  const [ocrBusy, setOcrBusy] = useState(false);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const caseRequest = useRef(0);
  const evidenceRequest = useRef(0);
  const confirmationRequest = useRef(0);
  const activeCaseId = useRef<string | undefined>(undefined);

  const activeStep = workflowStep(workflow, evidence !== undefined, confirmedText.length > 0);

  function activateCase(nextCase: AcceptedCase) {
    evidenceRequest.current += 1;
    confirmationRequest.current += 1;
    activeCaseId.current = nextCase.caseId;
    setActiveCase(nextCase);
    setWorkflow({
      criminalState: nextCase.criminalState,
      civilState: nextCase.civilState,
    });
    setEvidence(undefined);
    setFileName("");
    setManualText("");
    setConfirmedText("");
    setEvidenceError("");
    setOcrBusy(false);
    setConfirmBusy(false);
  }

  async function startCase(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const amountNumber = Number(amount);
    if (!Number.isInteger(amountNumber) || amountNumber < 1 || amountNumber > 30_000_000) {
      setCaseError(messages.invalidAmount);
      return;
    }

    const requestId = ++caseRequest.current;
    setCaseError("");
    setCaseBusy(true);
    try {
      const result = await window.haksul.createCase({
        amountKrw: amountNumber,
        jurisdiction: "domestic",
        paymentMethod: "bank-transfer",
      });
      if (requestId !== caseRequest.current) return;
      if (result.status === "accepted") {
        activateCase(result);
      } else {
        setCaseError(messages.outOfScope);
      }
    } catch {
      if (requestId === caseRequest.current) setCaseError(messages.caseFailed);
    } finally {
      if (requestId === caseRequest.current) setCaseBusy(false);
    }
  }

  async function analyzeCapture(file: File | undefined) {
    if (file === undefined || activeCase === undefined) return;
    const requestId = ++evidenceRequest.current;
    confirmationRequest.current += 1;
    setFileName(file.name);
    setEvidence(undefined);
    setManualText("");
    setConfirmedText("");
    setEvidenceError("");
    setConfirmBusy(false);

    const validationError = validateEvidenceFile(file);
    if (validationError !== undefined) {
      setEvidenceError(validationError);
      setOcrBusy(false);
      return;
    }
    if (!isSupportedMime(file.type)) return;

    const caseId = activeCase.caseId;
    setOcrBusy(true);
    try {
      const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
      const result = await window.haksul.analyzeEvidence({
        caseId,
        filename: file.name,
        mimeType: file.type,
        bytes,
      });
      if (requestId === evidenceRequest.current && activeCaseId.current === caseId) {
        setEvidence(result);
      }
    } catch {
      if (requestId === evidenceRequest.current && activeCaseId.current === caseId) {
        setEvidenceError(messages.ocrFailed);
      }
    } finally {
      if (requestId === evidenceRequest.current && activeCaseId.current === caseId) {
        setOcrBusy(false);
      }
    }
  }

  async function confirmEvidence(value: string) {
    if (activeCase === undefined || evidence === undefined) return;
    const text = value.trim();
    if (text.length === 0) return;
    if (text.length > MAX_CONFIRMED_TEXT) {
      setEvidenceError(messages.factTooLong);
      return;
    }
    const confirmFacts = window.haksul.confirmOcrFacts;
    if (confirmFacts === undefined) {
      setEvidenceError(messages.confirmationUnavailable);
      return;
    }

    const requestId = ++confirmationRequest.current;
    const caseId = activeCase.caseId;
    setEvidenceError("");
    setConfirmBusy(true);
    try {
      const result = await confirmFacts({
        caseId,
        evidenceId: evidence.evidenceId,
        facts: [{ field: "ocr-confirmed-text", value: text }],
      });
      if (requestId !== confirmationRequest.current || activeCaseId.current !== caseId) return;
      if (result.status === "ok") {
        setWorkflow(result.snapshot);
        setConfirmedText(text);
      } else {
        setEvidenceError(messages.confirmationFailed);
      }
    } catch {
      if (requestId === confirmationRequest.current && activeCaseId.current === caseId) {
        setEvidenceError(messages.confirmationFailed);
      }
    } finally {
      if (requestId === confirmationRequest.current && activeCaseId.current === caseId) {
        setConfirmBusy(false);
      }
    }
  }

  function updateWorkflow(caseId: string, snapshot: WorkflowSnapshot) {
    if (activeCaseId.current === caseId) setWorkflow(snapshot);
  }

  return (
    <main className="app-shell">
      <Topbar />
      <ProgressRail activeStep={activeStep} />
      <section className="workspace">
        <Hero />
        <CaseIntake
          amount={amount}
          busy={caseBusy}
          error={caseError}
          onAmountChange={setAmount}
          onSubmit={(event) => void startCase(event)}
        />
        {activeCase !== undefined && <CaseSummary activeCase={activeCase} />}
        {activeCase !== undefined && (
          <EvidencePanel
            busy={ocrBusy}
            confirmBusy={confirmBusy}
            error={evidenceError}
            evidence={evidence}
            fileName={fileName}
            manualText={manualText}
            onConfirm={(value) => void confirmEvidence(value)}
            onFile={(file) => void analyzeCapture(file)}
            onManualText={setManualText}
          />
        )}
        {activeCase !== undefined &&
          evidence !== undefined &&
          workflow !== undefined &&
          confirmedText.length > 0 && (
            <TrackBoard
              caseId={activeCase.caseId}
              confirmedText={confirmedText}
              key={`${activeCase.caseId}:${evidence.evidenceId}`}
              onWorkflowChange={(snapshot) => updateWorkflow(activeCase.caseId, snapshot)}
              workflow={workflow}
            />
          )}
      </section>
    </main>
  );
}
