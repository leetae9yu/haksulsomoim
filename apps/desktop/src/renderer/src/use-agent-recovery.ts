import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  type AgentRecoveryIssue,
  classifyAgentRecoveryFailure,
} from "../../contracts/agent-lifecycle-failure";
import type { AgentRunProjection } from "../../contracts/desktop-api";

export type AgentRecoveryControl = Readonly<{
  issue: AgentRecoveryIssue | undefined;
  checking: boolean;
  denied: boolean;
  recheck: () => void;
}>;

export function useAgentRecovery(
  caseId: string,
  setProjection: Dispatch<SetStateAction<AgentRunProjection | undefined>>,
  resetCase: () => void,
) {
  const caseRef = useRef(caseId);
  const requestRef = useRef(0);
  const resetRef = useRef(resetCase);
  const [issue, setIssue] = useState<AgentRecoveryIssue>();
  const [checking, setChecking] = useState(false);
  const [denied, setDenied] = useState(false);
  caseRef.current = caseId;
  resetRef.current = resetCase;
  const isCurrentCase = useCallback((expected: string) => caseRef.current === expected, []);

  const recover = useCallback(
    async (userInitiated: boolean) => {
      const requestId = ++requestRef.current;
      const list = window.haksul.listAgentRuns;
      setDenied(false);
      if (userInitiated) setChecking(true);
      try {
        if (list === undefined) throw new Error("Agent lifecycle unavailable");
        const runs = await list({ caseId });
        if (requestId !== requestRef.current || caseRef.current !== caseId) return;
        setProjection(runs.at(-1));
        setIssue(undefined);
      } catch (error) {
        if (requestId !== requestRef.current || caseRef.current !== caseId) return;
        const failure = classifyAgentRecoveryFailure(error);
        setIssue(failure);
        setDenied(userInitiated && failure === "unresolved-tool");
      } finally {
        if (requestId === requestRef.current && caseRef.current === caseId) setChecking(false);
      }
    },
    [caseId, setProjection],
  );

  useEffect(() => {
    resetRef.current();
    setProjection(undefined);
    setIssue(undefined);
    setDenied(false);
    void recover(false);
    return () => {
      requestRef.current += 1;
    };
  }, [recover, setProjection]);

  return {
    caseRef,
    requestRef,
    issue,
    checking,
    denied,
    recheck: () => void recover(true),
    isCurrentCase,
  } satisfies AgentRecoveryControl &
    Readonly<{
      caseRef: typeof caseRef;
      requestRef: typeof requestRef;
      isCurrentCase: typeof isCurrentCase;
    }>;
}
