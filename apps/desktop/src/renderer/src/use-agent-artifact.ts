import { useEffect, useRef, useState } from "react";
import type { AgentArtifactView, AgentRunProjection } from "../../contracts/desktop-api";

export type AgentArtifactControl = Readonly<{
  busy: boolean;
  error: string;
  view: AgentArtifactView | undefined;
  open(artifactId: string): void;
}>;

export function useAgentArtifact(
  caseId: string,
  projection: AgentRunProjection | undefined,
  contextDigest: string | undefined,
): AgentArtifactControl {
  const [view, setView] = useState<AgentArtifactView>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const request = useRef(0);
  const mounted = useRef(true);
  const authority = JSON.stringify([
    caseId,
    projection?.runId,
    projection?.revision,
    contextDigest,
  ]);
  const authorityRef = useRef(authority);
  authorityRef.current = authority;
  useEffect(() => {
    void authority;
    request.current += 1;
    setView(undefined);
    setBusy(false);
    setError("");
  }, [authority]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      request.current += 1;
    };
  }, []);

  return {
    busy,
    error,
    view,
    open(artifactId) {
      const command = window.haksul.openAgentArtifact;
      const captured = authority;
      const runId = projection?.runId;
      const revision = projection?.revision;
      const requestId = ++request.current;
      setView(undefined);
      setError("");
      if (
        command === undefined ||
        runId === undefined ||
        revision === undefined ||
        contextDigest === undefined
      ) {
        setBusy(false);
        setError("암호화 초안을 안전하게 열 수 없습니다.");
        return;
      }
      setBusy(true);
      void command({ caseId, runId, contextDigest, artifactId })
        .then((opened) => {
          if (
            mounted.current &&
            request.current === requestId &&
            authorityRef.current === captured &&
            opened.artifactId === artifactId
          ) {
            setView(opened);
          }
        })
        .catch(() => {
          if (
            mounted.current &&
            request.current === requestId &&
            authorityRef.current === captured
          ) {
            setView(undefined);
            setError("암호화 초안을 안전하게 열 수 없습니다.");
          }
        })
        .finally(() => {
          if (
            mounted.current &&
            request.current === requestId &&
            authorityRef.current === captured
          ) {
            setBusy(false);
          }
        });
    },
  };
}
