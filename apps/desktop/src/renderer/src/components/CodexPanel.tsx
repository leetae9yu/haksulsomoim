import { useEffect, useState } from "react";
import type { CodexStatusResponse } from "../../../contracts/desktop-api";
import { boundedMetadata, messages } from "../renderer-state";

type ProviderState =
  | Readonly<{ status: "checking" }>
  | Readonly<{ status: "manual"; message: string }>
  | Readonly<{ status: "sign-in-required" }>
  | Readonly<{ status: "login-ready"; authorizationUrl: string }>
  | Readonly<{ status: "authenticated"; planType: string }>
  | Readonly<{ status: "error"; message: string }>;

function fromStatus(result: CodexStatusResponse): ProviderState {
  if (result.status === "offline") {
    return { status: "manual", message: messages.providerManual };
  }
  if (result.status === "sign-in-required") return { status: "sign-in-required" };
  return { status: "authenticated", planType: boundedMetadata(result.account.planType) };
}

function officialLoginUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "auth.openai.com" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

export function CodexPanel({
  caseId,
  citationIds,
}: {
  readonly caseId: string;
  readonly citationIds: readonly string[];
}) {
  const [provider, setProvider] = useState<ProviderState>({ status: "checking" });
  const [approved, setApproved] = useState(false);
  const [suggestion, setSuggestion] = useState("");
  const [suggestionError, setSuggestionError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const status = window.haksul.codexStatus;
    if (status === undefined) {
      setProvider({ status: "manual", message: messages.providerManual });
      return;
    }
    let current = true;
    void status({})
      .then((result) => {
        if (current) setProvider(fromStatus(result));
      })
      .catch(() => {
        if (current) setProvider({ status: "error", message: messages.providerFailed });
      });
    return () => {
      current = false;
    };
  }, []);

  async function beginLogin() {
    const login = window.haksul.codexLogin;
    if (login === undefined) {
      setProvider({ status: "manual", message: messages.providerManual });
      return;
    }
    setBusy(true);
    try {
      const result = await login({});
      const authorizationUrl = officialLoginUrl(result.authorizationUrl);
      setProvider(
        authorizationUrl === undefined
          ? { status: "error", message: messages.loginFailed }
          : { status: "login-ready", authorizationUrl },
      );
    } catch {
      setProvider({ status: "error", message: messages.loginFailed });
    } finally {
      setBusy(false);
    }
  }

  async function openLogin() {
    if (provider.status !== "login-ready") return;
    const opener = window.haksul.openTrustedAuthentication;
    if (opener === undefined) {
      setProvider({ status: "error", message: messages.loginFailed });
      return;
    }
    setBusy(true);
    try {
      await opener({ url: provider.authorizationUrl });
    } catch {
      setProvider({ status: "error", message: messages.loginFailed });
    } finally {
      setBusy(false);
    }
  }

  async function refreshStatus() {
    const status = window.haksul.codexStatus;
    if (status === undefined) return;
    setBusy(true);
    try {
      setProvider(fromStatus(await status({})));
    } catch {
      setProvider({ status: "error", message: messages.providerFailed });
    } finally {
      setBusy(false);
    }
  }

  async function requestSuggestion() {
    const suggest = window.haksul.codexSuggestion;
    if (!approved || suggest === undefined) return;
    setBusy(true);
    setSuggestion("");
    setSuggestionError("");
    try {
      const result = await suggest({
        caseId,
        approval: "user-approved",
        citationIds: [...citationIds],
      });
      setSuggestion(result.text.slice(0, 12_000));
    } catch {
      setSuggestionError(messages.suggestionFailed);
    } finally {
      setApproved(false);
      setBusy(false);
    }
  }

  return (
    <section
      className="provider-panel"
      data-provider-state={provider.status}
      data-testid="provider-panel"
    >
      <span className="panel-kicker">OPTIONAL CODEX</span>
      <h3>문안 점검 제안</h3>
      <p className="boundary-note">
        원본과 확인 원문은 이 PC에 남습니다. 승인 시 메인 프로세스가 식별정보를 가린 사실과 공식
        근거 ID만 전송합니다.
      </p>
      <ProviderStatus
        busy={busy}
        onLogin={() => void beginLogin()}
        onOpenLogin={() => void openLogin()}
        onRefresh={() => void refreshStatus()}
        provider={provider}
      />
      {provider.status === "authenticated" && (
        <>
          <label className="checkbox-row">
            <input
              checked={approved}
              onChange={(event) => setApproved(event.target.checked)}
              type="checkbox"
            />
            <span>마스킹된 사실과 근거 ID 전송을 승인합니다</span>
          </label>
          <button
            disabled={!approved || busy}
            onClick={() => void requestSuggestion()}
            type="button"
          >
            Codex 제안 받기
          </button>
        </>
      )}
      {suggestionError.length > 0 && (
        <p className="notice error" role="alert">
          {suggestionError}
        </p>
      )}
      {suggestion.length > 0 && (
        <div className="codex-suggestion" data-testid="codex-suggestion">
          {suggestion}
        </div>
      )}
    </section>
  );
}

function ProviderStatus({
  busy,
  onLogin,
  onOpenLogin,
  onRefresh,
  provider,
}: {
  readonly busy: boolean;
  readonly onLogin: () => void;
  readonly onOpenLogin: () => void;
  readonly onRefresh: () => void;
  readonly provider: ProviderState;
}) {
  if (provider.status === "checking") return <p role="status">연결 상태 확인 중…</p>;
  if (provider.status === "manual" || provider.status === "error") {
    return (
      <div className="provider-status">
        <strong>오프라인 · 수동 작성</strong>
        <p>{provider.message}</p>
      </div>
    );
  }
  if (provider.status === "sign-in-required") {
    return (
      <div className="provider-status">
        <strong>ChatGPT 로그인 필요</strong>
        <p>구독 계정 로그인은 공식 OpenAI 인증 화면에서만 진행합니다.</p>
        <button disabled={busy} onClick={onLogin} type="button">
          ChatGPT로 로그인
        </button>
      </div>
    );
  }
  if (provider.status === "login-ready") {
    return (
      <div className="provider-status">
        <strong>공식 로그인 주소 준비됨</strong>
        <p>
          <button className="login-link" disabled={busy} onClick={onOpenLogin} type="button">
            OpenAI 로그인 주소 열기
          </button>
        </p>
        <button className="button-secondary" disabled={busy} onClick={onRefresh} type="button">
          로그인 상태 다시 확인
        </button>
      </div>
    );
  }
  return (
    <div className="provider-status">
      <strong>ChatGPT 구독 연결됨</strong>
      <p>요금제 유형 · {provider.planType || "확인됨"}</p>
    </div>
  );
}
