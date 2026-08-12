import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { installApi, reachTracks, startCase, uploadEvidence } from "./renderer-test-utils";

afterEach(cleanup);

describe("domain-backed desktop case workflow", () => {
  test("passes explicit case IDs and confirms OCR before rendering separate tracks", async () => {
    const api = installApi();
    const user = userEvent.setup();
    render(<App />);

    await startCase(user);
    await uploadEvidence(user);

    expect(api.analyzeEvidence).toHaveBeenCalledWith({
      caseId: "case-1",
      filename: "transfer.png",
      mimeType: "image/png",
      bytes: [137, 80, 78, 71],
    });
    expect(screen.queryByRole("heading", { name: "형사 절차" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "추출 내용 확인" }));
    expect(api.confirmOcrFacts).toHaveBeenCalledWith({
      caseId: "case-1",
      evidenceId: "evidence-1",
      facts: [{ field: "ocr-confirmed-text", value: "5,380,000원 송금 완료" }],
    });
    expect(await screen.findByRole("heading", { name: "형사 절차" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "민사 절차" })).toBeTruthy();
    expect(screen.getByTestId("criminal-state").dataset.state).toBe("evidence-review");
    expect(screen.getByTestId("civil-state").dataset.state).toBe("pre-filing");
  });

  test("advances criminal and civil attestations before exposing enforcement", async () => {
    const api = installApi();
    const user = userEvent.setup();
    render(<App />);
    await reachTracks(user);

    expect(screen.queryByText("재산조회")).toBeNull();
    expect(screen.getByTestId("progress-step-4").getAttribute("aria-current")).toBeNull();

    await user.click(screen.getByRole("button", { name: "고소장 준비 시작" }));
    expect(api.advanceCriminal).toHaveBeenLastCalledWith({
      caseId: "case-1",
      command: "prepare-complaint",
    });
    await user.click(await screen.findByRole("button", { name: "고소장 제출 완료를 직접 확인" }));
    expect(api.advanceCriminal).toHaveBeenLastCalledWith({
      caseId: "case-1",
      command: "file-complaint",
    });

    await user.click(screen.getByRole("button", { name: "지급명령 신청 완료를 직접 확인" }));
    expect(api.advanceCivil).toHaveBeenLastCalledWith({
      caseId: "case-1",
      command: "apply-payment-order",
      userAttested: true,
    });
    await user.click(await screen.findByRole("button", { name: "송달 완료를 직접 확인" }));
    await user.click(await screen.findByRole("button", { name: "판결·결정문 수령을 직접 확인" }));
    expect(api.enforcementChoices).not.toHaveBeenCalled();
    expect(screen.queryByText("압류·추심")).toBeNull();

    await user.click(await screen.findByRole("button", { name: "집행권원 확보로 표시" }));
    expect(api.advanceCivil).toHaveBeenLastCalledWith({
      caseId: "case-1",
      command: "attest-finality",
      userAttested: true,
    });
    await waitFor(() => expect(api.enforcementChoices).toHaveBeenCalledWith({ caseId: "case-1" }));

    expect(await screen.findByText("재산조회")).toBeTruthy();
    expect(screen.getByText("압류·추심")).toBeTruthy();
    expect(screen.getByText("채무불이행자명부")).toBeTruthy();
    expect(screen.getByRole("link", { name: "민사집행법 근거 보기" })).toBeTruthy();
    expect(screen.getByTestId("progress-step-4").getAttribute("aria-current")).toBe("step");
  });

  test("rejects amounts over thirty million won before IPC", async () => {
    const api = installApi();
    const user = userEvent.setup();
    render(<App />);

    await user.type(screen.getByLabelText("피해금액"), "30000001");
    await user.click(screen.getByRole("button", { name: "사건 시작" }));

    expect(screen.getByRole("alert")).toBeTruthy();
    expect(api.createCase).not.toHaveBeenCalled();
  });
});
