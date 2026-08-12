import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  CodexStatusResponse,
  CodexSuggestionRequest,
  CodexSuggestionResponse,
  EmptyRequest,
  GuidanceRequest,
  GuidanceResponse,
} from "../../contracts/desktop-api";
import { App } from "./App";
import { installApi, reachTracks } from "./renderer-test-utils";

afterEach(cleanup);

describe("official guidance and optional Codex provider", () => {
  test("renders checkable official citations and opens them through the trusted bridge", async () => {
    const openOfficialSource = mock(async () => undefined);
    const guidance = mock(
      async (_request: GuidanceRequest): Promise<GuidanceResponse> => ({
        status: "ok",
        content: { ignored: true },
        citations: [
          {
            id: "law-2026",
            sourceUrl: "https://law.go.kr/법령/민사집행법",
            law: "민사집행법",
            versionDate: "2026-01-01",
            retrievedAt: "2026-08-11T00:00:00.000Z",
          },
        ],
      }),
    );
    installApi({ guidance, openOfficialSource });
    const user = userEvent.setup();
    render(<App />);
    await reachTracks(user);

    await waitFor(() => expect(guidance).toHaveBeenCalledTimes(1));
    expect(guidance.mock.calls[0]?.[0]).toMatchObject({ caseId: "case-1" });
    const citation = await screen.findByTestId("citation-law-2026");
    expect(citation.dataset.source).toBe("law.go.kr");
    expect(citation.dataset.checked).toBe("2026-08-11T00:00:00.000Z");
    await user.click(screen.getByRole("link", { name: "민사집행법 공식 원문 열기" }));
    expect(openOfficialSource).toHaveBeenCalledWith({
      url: "https://law.go.kr/법령/민사집행법",
    });
  });

  test("requires explicit approval and sends only case and citation identifiers to Codex", async () => {
    const codexSuggestion = mock(
      async (_request: CodexSuggestionRequest): Promise<CodexSuggestionResponse> => ({
        text: "공식 근거를 바탕으로 제출 전 점검 항목을 정리했습니다.",
        citationIds: ["law-1"],
      }),
    );
    installApi({
      codexStatus: mock(
        async (_request: EmptyRequest): Promise<CodexStatusResponse> => ({
          status: "authenticated",
          account: { type: "chatgpt", email: "private@example.com", planType: "plus" },
        }),
      ),
      codexSuggestion,
    });
    const user = userEvent.setup();
    render(<App />);
    await reachTracks(user);

    const panel = await screen.findByTestId("provider-panel");
    await waitFor(() => expect(panel.dataset.providerState).toBe("authenticated"));
    const suggestionButton = screen.getByRole("button", { name: "Codex 제안 받기" });
    expect((suggestionButton as HTMLButtonElement).disabled).toBe(true);
    expect(document.querySelector('input[type="password"]')).toBeNull();
    expect(document.querySelector('input[type="email"]')).toBeNull();
    expect(screen.queryByText("private@example.com")).toBeNull();

    await user.click(screen.getByLabelText("마스킹된 사실과 근거 ID 전송을 승인합니다"));
    await user.click(suggestionButton);
    expect(codexSuggestion).toHaveBeenCalledWith({
      caseId: "case-1",
      approval: "user-approved",
      citationIds: ["law-1"],
    });
    expect(JSON.stringify(codexSuggestion.mock.calls[0]?.[0])).not.toContain("5,380,000원");
    expect(await screen.findByTestId("codex-suggestion")).toBeTruthy();
  });

  test("renders typed sign-in and offline/manual states without credential fields", async () => {
    const codexLogin = mock(async () => ({
      loginId: "login-1",
      authorizationUrl: "https://auth.openai.com/authorize?client=haksul",
    }));
    const openTrustedAuthentication = mock(async () => undefined);
    installApi({
      codexStatus: mock(
        async (_request: EmptyRequest): Promise<CodexStatusResponse> => ({
          status: "sign-in-required",
          action: "sign-in-with-chatgpt",
        }),
      ),
      codexLogin,
      openTrustedAuthentication,
    });
    const user = userEvent.setup();
    render(<App />);
    await reachTracks(user);

    const panel = await screen.findByTestId("provider-panel");
    await waitFor(() => expect(panel.dataset.providerState).toBe("sign-in-required"));
    await user.click(screen.getByRole("button", { name: "ChatGPT로 로그인" }));
    expect(codexLogin).toHaveBeenCalledWith({});
    await waitFor(() => expect(panel.dataset.providerState).toBe("login-ready"));
    await user.click(screen.getByRole("button", { name: "OpenAI 로그인 주소 열기" }));
    expect(openTrustedAuthentication).toHaveBeenCalledWith({
      url: "https://auth.openai.com/authorize?client=haksul",
    });
    expect(screen.queryByRole("link", { name: "OpenAI 로그인 주소 열기" })).toBeNull();
    expect(document.querySelector('input[type="password"]')).toBeNull();
  });

  test("falls back to a typed manual mode when the provider is offline", async () => {
    installApi({
      codexStatus: mock(
        async (_request: EmptyRequest): Promise<CodexStatusResponse> => ({
          status: "offline",
          mode: "manual",
          reason: "SECRET",
        }),
      ),
    });
    const user = userEvent.setup();
    render(<App />);
    await reachTracks(user);

    const panel = await screen.findByTestId("provider-panel");
    await waitFor(() => expect(panel.dataset.providerState).toBe("manual"));
    expect(panel.textContent).not.toContain("SECRET");
    expect(screen.queryByRole("button", { name: "Codex 제안 받기" })).toBeNull();
  });
});
