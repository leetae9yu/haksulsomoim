import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  AgentRunStartIpcRequest,
  CodexStatusResponse,
  EmptyRequest,
  GuidanceRequest,
  GuidanceResponse,
} from "../../contracts/desktop-api";
import { App } from "./App";
import { completedProjection } from "./agent-workspace-test-fixtures";
import { installApi, reachTracks } from "./renderer-test-utils";

afterEach(cleanup);

describe("official guidance and autonomous Agent workspace", () => {
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

  test("replaces the optional suggestion with digest-bound Agent start", async () => {
    const startAgentRun = mock(async (request: AgentRunStartIpcRequest) =>
      completedProjection(request.caseId, request.goal),
    );
    installApi({
      codexStatus: mock(
        async (_request: EmptyRequest): Promise<CodexStatusResponse> => ({
          status: "authenticated",
          account: { type: "chatgpt", email: "private@example.com", planType: "plus" },
        }),
      ),
      startAgentRun,
    });
    const user = userEvent.setup();
    render(<App />);
    await reachTracks(user);

    const workspace = await screen.findByTestId("agent-workspace");
    await waitFor(() => expect(workspace.dataset.agentProvider).toBe("authenticated"));
    expect(screen.queryByText("OPTIONAL CODEX")).toBeNull();
    expect(screen.queryByText("문안 점검 제안")).toBeNull();
    expect(screen.getByTestId("agent-start")).toHaveProperty("disabled", true);
    await user.click(screen.getByLabelText("민사 회수"));
    await user.click(screen.getByLabelText(/마스킹된 사건 컨텍스트 전송을 승인/));
    await user.click(screen.getByTestId("agent-start"));

    expect(startAgentRun).toHaveBeenCalledWith({
      caseId: "case-1",
      contextDigest: "a".repeat(64),
      goal: {
        kind: "civil-recovery",
        caseId: "case-1",
        objective: "prepare-civil-demand",
      },
    });
    await waitFor(() => expect(workspace.dataset.agentStatus).toBe("completed"));
    expect(screen.queryByText("private@example.com")).toBeNull();
  });

  test("uses only the trusted external authentication control", async () => {
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

    const workspace = await screen.findByTestId("agent-workspace");
    await waitFor(() => expect(workspace.dataset.agentProvider).toBe("sign-in-required"));
    await user.click(screen.getByRole("button", { name: "ChatGPT로 로그인" }));
    expect(codexLogin).toHaveBeenCalledWith({});
    await waitFor(() => expect(workspace.dataset.agentProvider).toBe("login-ready"));
    await user.click(screen.getByRole("button", { name: "OpenAI 로그인 주소 열기" }));
    expect(openTrustedAuthentication).toHaveBeenCalledWith({
      url: "https://auth.openai.com/authorize?client=haksul",
    });
    expect(document.querySelector('input[type="password"]')).toBeNull();
  });

  test("falls back to typed manual mode without leaking provider errors", async () => {
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

    const workspace = await screen.findByTestId("agent-workspace");
    await waitFor(() => expect(workspace.dataset.agentStatus).toBe("manual"));
    expect(workspace.textContent).not.toContain("SECRET");
    expect(workspace.textContent).toContain("수동 절차는 계속 사용할 수 있습니다");
  });
});
