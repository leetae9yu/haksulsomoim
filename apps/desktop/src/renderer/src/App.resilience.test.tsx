import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  CaseCreateRequest,
  EvidenceAnalyzeRequest,
  EvidenceAnalyzeResponse,
} from "../../contracts/desktop-api";
import { App } from "./App";
import {
  acceptedCase,
  deferred,
  installApi,
  pngFile,
  reachTracks,
  setAmount,
  startCase,
} from "./renderer-test-utils";

afterEach(cleanup);

describe("renderer recovery boundaries", () => {
  test("disables file selection during OCR and ignores a stale prior-case response", async () => {
    const first = deferred<EvidenceAnalyzeResponse>();
    const second = deferred<EvidenceAnalyzeResponse>();
    const createCase = mock(async (request: CaseCreateRequest) =>
      acceptedCase(request.amountKrw === 1_000_000 ? "case-1" : "case-2", request.amountKrw),
    );
    const analyzeEvidence = mock((_request) =>
      analyzeEvidence.mock.calls.length === 1 ? first.promise : second.promise,
    );
    installApi({ createCase, analyzeEvidence });
    const user = userEvent.setup();
    render(<App />);

    setAmount("1000000");
    await user.click(screen.getByRole("button", { name: "사건 시작" }));
    await screen.findByText("₩1,000,000");
    await user.upload(screen.getByLabelText("증빙 캡처"), pngFile("old.png"));
    await waitFor(() => expect(analyzeEvidence).toHaveBeenCalledTimes(1));
    expect((screen.getByLabelText("증빙 캡처") as HTMLInputElement).disabled).toBe(true);

    setAmount("2000000");
    await user.click(screen.getByRole("button", { name: "사건 시작" }));
    await screen.findByText("₩2,000,000");
    expect((screen.getByLabelText("증빙 캡처") as HTMLInputElement).disabled).toBe(false);
    await user.upload(screen.getByLabelText("증빙 캡처"), pngFile("current.png"));

    await act(async () => {
      second.resolve({
        status: "candidates",
        evidenceId: "current-evidence",
        sha256: "b".repeat(64),
        text: "현재 사건 증빙",
        confidence: 91,
        needsManualConfirmation: true,
      });
      await second.promise;
    });
    expect(await screen.findByText("현재 사건 증빙")).toBeTruthy();
    expect(analyzeEvidence).toHaveBeenLastCalledWith(
      expect.objectContaining({ caseId: "case-2", filename: "current.png" }),
    );

    await act(async () => {
      first.resolve({
        status: "candidates",
        evidenceId: "old-evidence",
        sha256: "c".repeat(64),
        text: "이전 사건 증빙",
        confidence: 99,
        needsManualConfirmation: true,
      });
      await first.promise;
    });
    expect(screen.queryByText("이전 사건 증빙")).toBeNull();
    expect(screen.getByText("현재 사건 증빙")).toBeTruthy();
  });

  test("preserves the active workspace while replacement is pending, then resets on acceptance", async () => {
    const replacement = deferred<ReturnType<typeof acceptedCase>>();
    const createCase = mock((request: CaseCreateRequest) =>
      request.amountKrw === 5_380_000
        ? Promise.resolve(acceptedCase("case-1", request.amountKrw))
        : replacement.promise,
    );
    installApi({ createCase });
    const user = userEvent.setup();
    render(<App />);
    await reachTracks(user);
    expect(await screen.findByTestId("provider-panel")).toBeTruthy();

    setAmount("1000000");
    await user.click(screen.getByRole("button", { name: "사건 시작" }));

    expect(screen.getByRole("heading", { name: "형사 절차" })).toBeTruthy();
    expect(screen.getAllByText("5,380,000원 송금 완료").length).toBeGreaterThan(0);
    expect(screen.getByTestId("provider-panel")).toBeTruthy();

    await act(async () => {
      replacement.resolve(acceptedCase("case-2", 1_000_000));
      await replacement.promise;
    });
    expect(await screen.findByText("₩1,000,000")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "형사 절차" })).toBeNull();
    expect(screen.queryByText("5,380,000원 송금 완료")).toBeNull();
    expect(screen.queryByTestId("provider-panel")).toBeNull();
  });

  test("keeps the active case usable after rejected and failed replacement intake", async () => {
    const createCase = mock(async (request: CaseCreateRequest) => {
      if (request.amountKrw === 5_380_000) return acceptedCase("case-1", request.amountKrw);
      if (request.amountKrw === 1_000_000) {
        return { status: "out-of-scope" as const, reason: "out-of-scope" };
      }
      throw new Error(`REMOTE_TOKEN=${"x".repeat(500)}`);
    });
    const api = installApi({ createCase });
    const user = userEvent.setup();
    render(<App />);
    await reachTracks(user);

    setAmount("1000000");
    await user.click(screen.getByRole("button", { name: "사건 시작" }));
    let message = screen.getByRole("alert").textContent ?? "";
    expect(message.length).toBeLessThanOrEqual(120);
    expect(screen.getByText("₩5,380,000")).toBeTruthy();
    expect(screen.getByTestId("provider-panel")).toBeTruthy();

    setAmount("2000000");
    await user.click(screen.getByRole("button", { name: "사건 시작" }));
    message = screen.getByRole("alert").textContent ?? "";
    expect(message.length).toBeLessThanOrEqual(120);
    expect(message).not.toContain("REMOTE_TOKEN");
    expect(screen.getByText("₩5,380,000")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "고소장 준비 시작" }));
    expect(api.advanceCriminal).toHaveBeenCalledWith({
      caseId: "case-1",
      command: "prepare-complaint",
    });
  });

  test("ignores a stale replacement response after a newer case is accepted", async () => {
    const first = deferred<ReturnType<typeof acceptedCase>>();
    const second = deferred<ReturnType<typeof acceptedCase>>();
    installApi({
      createCase: mock((request: CaseCreateRequest) =>
        request.amountKrw === 1_000_000 ? first.promise : second.promise,
      ),
    });
    render(<App />);
    const form = screen.getByLabelText("피해금액").closest("form");
    if (form === null) throw new Error("case intake form missing");

    setAmount("1000000");
    fireEvent.submit(form);
    setAmount("2000000");
    fireEvent.submit(form);

    await act(async () => {
      second.resolve(acceptedCase("case-2", 2_000_000));
      await second.promise;
    });
    expect(screen.getByText("₩2,000,000")).toBeTruthy();

    await act(async () => {
      first.resolve(acceptedCase("case-1", 1_000_000));
      await first.promise;
    });
    expect(screen.getByText("₩2,000,000")).toBeTruthy();
    expect(screen.queryByText("₩1,000,000")).toBeNull();
  });

  test("rejects strict MIME violations and bounds recoverable OCR failures in Korean", async () => {
    const analyzeEvidence = mock(async () => {
      throw new Error(`REMOTE_TOKEN=${"x".repeat(500)}`);
    });
    const api = installApi({ analyzeEvidence });
    const user = userEvent.setup({ applyAccept: false });
    render(<App />);
    await startCase(user);

    await user.upload(
      screen.getByLabelText("증빙 캡처"),
      new File([Uint8Array.from([1])], "receipt.pdf", { type: "application/pdf" }),
    );
    let message = screen.getByRole("alert").textContent ?? "";
    expect(message).toMatch(/[가-힣]/u);
    expect(message.length).toBeLessThanOrEqual(120);
    expect(api.analyzeEvidence).not.toHaveBeenCalled();

    await user.upload(screen.getByLabelText("증빙 캡처"), pngFile("retry.png"));
    await waitFor(() => expect(analyzeEvidence).toHaveBeenCalledTimes(1));
    message = screen.getByRole("alert").textContent ?? "";
    expect(message).toMatch(/[가-힣]/u);
    expect(message.length).toBeLessThanOrEqual(120);
    expect(message).not.toContain("REMOTE_TOKEN");
    expect((screen.getByLabelText("증빙 캡처") as HTMLInputElement).disabled).toBe(false);
  });

  test("keeps unreadable evidence behind domain confirmation", async () => {
    const confirmOcrFacts = mock(async () => ({
      status: "ok" as const,
      snapshot: { criminalState: "evidence-review" as const, civilState: "pre-filing" as const },
    }));
    installApi({
      analyzeEvidence: mock(
        async (_request: EvidenceAnalyzeRequest): Promise<EvidenceAnalyzeResponse> => ({
          status: "unreadable",
          evidenceId: "evidence-2",
          sha256: "d".repeat(64),
          reason: "no-text-detected",
          needsManualConfirmation: true,
        }),
      ),
      confirmOcrFacts,
    });
    const user = userEvent.setup();
    render(<App />);
    await startCase(user);
    await user.upload(screen.getByLabelText("증빙 캡처"), pngFile("blank.png"));

    expect(await screen.findByText("캡처에서 문자를 읽지 못했습니다.")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "형사 절차" })).toBeNull();
    expect(
      (screen.getByRole("button", { name: "수동 내용 확인" }) as HTMLButtonElement).disabled,
    ).toBe(true);

    await user.type(screen.getByLabelText("직접 확인한 캡처 내용"), "직접 확인한 송금 내역");
    await user.click(screen.getByRole("button", { name: "수동 내용 확인" }));
    expect(confirmOcrFacts).toHaveBeenCalledWith({
      caseId: "case-1",
      evidenceId: "evidence-2",
      facts: [{ field: "ocr-confirmed-text", value: "직접 확인한 송금 내역" }],
    });
    expect(await screen.findByRole("heading", { name: "형사 절차" })).toBeTruthy();
  });
});
