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
  useEffect(() => {
    void caseId;
    void projection?.runId;
    request.current += 1;
    setView(undefined);
    setBusy(false);
    setError("");
  }, [caseId, projection?.runId]);

  return {
    busy,
    error,
    view,
    open(artifactId) {
      const command = window.haksul.openAgentArtifact;
      if (command === undefined || projection === undefined || contextDigest === undefined) {
        setError("암호화 초안을 안전하게 열 수 없습니다.");
        return;
      }
      const requestId = ++request.current;
      setBusy(true);
      setError("");
      void command({ caseId, runId: projection.runId, contextDigest, artifactId })
        .then((opened) => {
          if (request.current === requestId) setView(opened);
        })
        .catch(() => {
          if (request.current === requestId) {
            setError("암호화 초안을 안전하게 열 수 없습니다.");
          }
        })
        .finally(() => {
          if (request.current === requestId) setBusy(false);
        });
    },
  };
}
