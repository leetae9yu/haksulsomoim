import { mock } from "bun:test";
import { fireEvent, screen } from "@testing-library/react";
import type {
  CaseCreateRequest,
  CaseCreateResponse,
  CivilTransitionRequest,
  CodexStatusResponse,
  ConfirmOcrFactsRequest,
  CriminalTransitionRequest,
  DesktopApi,
  EmptyRequest,
  EnforcementChoicesRequest,
  EnforcementChoicesResponse,
  EvidenceAnalyzeRequest,
  EvidenceAnalyzeResponse,
  GuidanceRequest,
  GuidanceResponse,
  TransitionResponse,
  WorkflowSnapshot,
} from "../../contracts/desktop-api";

export const initialWorkflow: WorkflowSnapshot = {
  criminalState: "evidence-review",
  civilState: "pre-filing",
};

export function acceptedCase(caseId = "case-1", amountKrw = 5_380_000): CaseCreateResponse {
  return { status: "accepted", caseId, amountKrw, ...initialWorkflow };
}

const civilStates: Record<CivilTransitionRequest["command"], WorkflowSnapshot["civilState"]> = {
  "apply-payment-order": "payment-order-pending",
  "attest-service": "service-attested",
  "record-judgment": "judgment-recorded",
  "attest-finality": "enforceable-title-confirmed",
};

export function installApi(overrides: Partial<DesktopApi> = {}) {
  const api: DesktopApi = {
    createCase: mock(
      async (request: CaseCreateRequest): Promise<CaseCreateResponse> =>
        acceptedCase("case-1", request.amountKrw),
    ),
    analyzeEvidence: mock(
      async (_request: EvidenceAnalyzeRequest): Promise<EvidenceAnalyzeResponse> => ({
        status: "candidates",
        evidenceId: "evidence-1",
        sha256: "a".repeat(64),
        text: "5,380,000원 송금 완료",
        confidence: 94,
        needsManualConfirmation: true,
      }),
    ),
    confirmOcrFacts: mock(
      async (_request: ConfirmOcrFactsRequest): Promise<TransitionResponse> => ({
        status: "ok",
        snapshot: initialWorkflow,
      }),
    ),
    advanceCriminal: mock(
      async (request: CriminalTransitionRequest): Promise<TransitionResponse> => ({
        status: "ok",
        snapshot: {
          ...initialWorkflow,
          criminalState:
            request.command === "prepare-complaint" ? "complaint-ready" : "complaint-filed",
        },
      }),
    ),
    advanceCivil: mock(
      async (request: CivilTransitionRequest): Promise<TransitionResponse> => ({
        status: "ok",
        snapshot: { ...initialWorkflow, civilState: civilStates[request.command] },
      }),
    ),
    enforcementChoices: mock(
      async (_request: EnforcementChoicesRequest): Promise<EnforcementChoicesResponse> => ({
        status: "ok",
        choices: [
          { kind: "asset-inquiry", condition: "enforceable-title-confirmed" },
          { kind: "seizure-and-collection", condition: "attachable-asset-identified" },
          { kind: "debtor-registry", condition: "statutory-requirements-met" },
        ],
      }),
    ),
    guidance: mock(
      async (_request: GuidanceRequest): Promise<GuidanceResponse> => ({
        status: "ok",
        content: null,
        citations: [
          {
            id: "law-1",
            sourceUrl: "https://law.go.kr/법령/민사집행법",
            law: "민사집행법",
            versionDate: "2026-01-01",
            retrievedAt: "2026-08-11T00:00:00.000Z",
          },
        ],
      }),
    ),
    openOfficialSource: mock(async () => undefined),
    codexStatus: mock(
      async (_request: EmptyRequest): Promise<CodexStatusResponse> => ({
        status: "offline",
        mode: "manual",
        reason: "offline",
      }),
    ),
    codexLogin: mock(async () => ({
      loginId: "login-1",
      authorizationUrl: "https://auth.openai.com/authorize",
    })),
    codexSuggestion: mock(async () => ({
      text: "확인된 사실을 기준으로 정리했습니다.",
      citationIds: [],
    })),
    openAgentCase: mock(async (request) => ({
      caseId: request.caseId,
      contextDigest: "a".repeat(64),
    })),
    listAgentRuns: mock(async () => []),
    subscribeAgentRun: mock(() => () => undefined),
    ...overrides,
  };
  Object.defineProperty(window, "haksul", { configurable: true, value: api });
  return api;
}

export function pngFile(name = "transfer.png") {
  return new File([Uint8Array.from([137, 80, 78, 71])], name, { type: "image/png" });
}

export async function startCase(
  user: ReturnType<typeof import("@testing-library/user-event").default.setup>,
) {
  await user.type(screen.getByLabelText("피해금액"), "5380000");
  await user.click(screen.getByRole("button", { name: "사건 시작" }));
  await screen.findByText("₩5,380,000");
}

export async function uploadEvidence(
  user: ReturnType<typeof import("@testing-library/user-event").default.setup>,
) {
  await user.upload(screen.getByLabelText("증빙 캡처"), pngFile());
  await screen.findByText("5,380,000원 송금 완료");
}

export async function reachTracks(
  user: ReturnType<typeof import("@testing-library/user-event").default.setup>,
) {
  await startCase(user);
  await uploadEvidence(user);
  await user.click(screen.getByRole("button", { name: "추출 내용 확인" }));
  await screen.findByRole("heading", { name: "형사 절차" });
}

export function setAmount(value: string) {
  const input = screen.getByLabelText("피해금액");
  fireEvent.change(input, { target: { value } });
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
