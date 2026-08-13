import { useCallback, useEffect, useRef, useState } from "react";
import {
  type AgentProviderState,
  providerFromResponse,
  trustedLoginUrl,
} from "./agent-workspace-state";

export function useAgentProvider() {
  const [state, setState] = useState<AgentProviderState>({ status: "checking" });
  const [busy, setBusy] = useState(false);
  const current = useRef(true);

  useEffect(() => {
    current.current = true;
    const status = window.haksul.codexStatus;
    if (status === undefined) {
      setState({ status: "manual" });
      return () => {
        current.current = false;
      };
    }
    void status({})
      .then((response) => {
        if (current.current) setState(providerFromResponse(response));
      })
      .catch(() => {
        if (current.current) setState({ status: "error" });
      });
    return () => {
      current.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    const status = window.haksul.codexStatus;
    if (status === undefined) return;
    setBusy(true);
    try {
      const response = await status({});
      if (current.current) setState(providerFromResponse(response));
    } catch {
      if (current.current) setState({ status: "error" });
    } finally {
      if (current.current) setBusy(false);
    }
  }, []);

  const login = useCallback(async () => {
    const begin = window.haksul.codexLogin;
    if (begin === undefined) {
      setState({ status: "manual" });
      return;
    }
    setBusy(true);
    try {
      const result = await begin({});
      const authorizationUrl = trustedLoginUrl(result.authorizationUrl);
      setState(
        authorizationUrl === undefined
          ? { status: "error" }
          : { status: "login-ready", authorizationUrl },
      );
    } catch {
      setState({ status: "error" });
    } finally {
      if (current.current) setBusy(false);
    }
  }, []);

  const openLogin = useCallback(async () => {
    if (state.status !== "login-ready") return;
    const open = window.haksul.openTrustedAuthentication;
    if (open === undefined) {
      setState({ status: "error" });
      return;
    }
    setBusy(true);
    try {
      await open({ url: state.authorizationUrl });
    } catch {
      setState({ status: "error" });
    } finally {
      if (current.current) setBusy(false);
    }
  }, [state]);

  return { state, busy, login, openLogin, refresh };
}

export function AgentProviderStatus({
  busy,
  onLogin,
  onOpenLogin,
  onRefresh,
  state,
}: {
  readonly busy: boolean;
  readonly onLogin: () => void;
  readonly onOpenLogin: () => void;
  readonly onRefresh: () => void;
  readonly state: AgentProviderState;
}) {
  if (state.status === "checking") return <p className="agent-provider-copy">연결 확인 중…</p>;
  if (state.status === "manual" || state.status === "error") {
    return (
      <div className="agent-provider-copy" data-agent-provider-notice="manual">
        <strong>로컬 수동 모드</strong>
        <span>Agent 연결을 사용할 수 없습니다. 수동 절차는 계속 사용할 수 있습니다.</span>
      </div>
    );
  }
  if (state.status === "sign-in-required") {
    return (
      <div className="agent-provider-copy">
        <strong>ChatGPT 로그인 필요</strong>
        <span>자격 증명은 앱에 입력하지 않고 공식 OpenAI 인증 화면에서만 처리합니다.</span>
        <button disabled={busy} onClick={onLogin} type="button">
          ChatGPT로 로그인
        </button>
      </div>
    );
  }
  if (state.status === "login-ready") {
    return (
      <div className="agent-provider-copy">
        <strong>공식 로그인 주소 준비됨</strong>
        <button disabled={busy} onClick={onOpenLogin} type="button">
          OpenAI 로그인 주소 열기
        </button>
        <button className="button-secondary" disabled={busy} onClick={onRefresh} type="button">
          로그인 상태 다시 확인
        </button>
      </div>
    );
  }
  return (
    <div className="agent-provider-copy" data-agent-provider-notice="authenticated">
      <strong>안전한 Agent 연결</strong>
      <span>ChatGPT 구독 연결됨 · {state.planType || "확인됨"}</span>
    </div>
  );
}
