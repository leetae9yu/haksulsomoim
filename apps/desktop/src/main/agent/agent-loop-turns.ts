import type { parseApprovedDecisionContext } from "../../integrations/agent-provider/agent-decision-contracts";
import {
  type AgentDecision,
  type AgentRun,
  type AgentToolCall,
  agentDecisionSchema,
} from "./agent-contracts";
import { pauseAgentDecisionForContext, pauseIdleAgentRun } from "./agent-loop-boundary-reducer";
import { classifyToolCall } from "./agent-loop-decisions";
import { AgentToolPolicyError } from "./agent-loop-errors";
import {
  beginAgentDecision,
  beginAgentTool,
  failAgentDecision,
  recordAgentDecision,
} from "./agent-loop-reducer";
import {
  type AgentLoopControl,
  type AgentLoopRuntimeDependencies,
  approvedDecisionContext,
  commitControlRun,
  loadAgentProjection,
  remainingDuration,
} from "./agent-loop-runtime";
import type { AgentCaseProjection } from "./agent-loop-types";

export type PreparedAgentTurn =
  | Readonly<{ kind: "stop"; run: AgentRun }>
  | Readonly<{
      kind: "provider";
      decisionId: string;
      context: ReturnType<typeof parseApprovedDecisionContext>;
    }>;

export type AcceptedAgentTurn =
  | Readonly<{ kind: "stop"; run: AgentRun }>
  | Readonly<{ kind: "continue"; run: AgentRun }>
  | Readonly<{
      kind: "execute";
      run: AgentRun;
      call: AgentToolCall;
      projection: AgentCaseProjection;
    }>;

export async function prepareAgentTurn(
  dependencies: AgentLoopRuntimeDependencies,
  control: AgentLoopControl,
): Promise<PreparedAgentTurn> {
  return dependencies.mutations.run(control.caseId, async () => {
    const current = control.snapshot.run;
    if (current.state.kind !== "active") return { kind: "stop", run: current };
    const duration = remainingDuration(dependencies, control, current);
    const projection = await loadAgentProjection(dependencies, control.caseId);
    if (projection.contextDigest !== control.approvedContextDigest) {
      const run = pauseIdleAgentRun(current, "context-changed", duration);
      await commitControlRun(dependencies, control, run, true);
      return { kind: "stop", run };
    }
    if (control.provider?.state.status !== "authenticated") {
      const run = pauseIdleAgentRun(current, "provider-unavailable", duration);
      await commitControlRun(dependencies, control, run, true);
      return { kind: "stop", run };
    }
    const decisionId = dependencies.identifiers.nextDecisionId();
    const begun = beginAgentDecision(
      current,
      decisionId,
      dependencies.identifiers.nextStepId(),
      dependencies.identifiers.nextStepId(),
      duration,
    );
    await commitControlRun(dependencies, control, begun.run, !begun.started);
    return begun.started
      ? {
          kind: "provider",
          decisionId,
          context: approvedDecisionContext(begun.run, projection, control),
        }
      : { kind: "stop", run: begun.run };
  });
}

function policyFailure(
  dependencies: AgentLoopRuntimeDependencies,
  current: AgentRun,
  decisionId: string,
  duration: number,
): AgentRun {
  return failAgentDecision(
    current,
    decisionId,
    dependencies.identifiers.nextStepId(),
    dependencies.identifiers.nextStepId(),
    duration,
  );
}

export async function acceptAgentDecision(
  dependencies: AgentLoopRuntimeDependencies,
  control: AgentLoopControl,
  decisionId: string,
  decision: AgentDecision | undefined,
): Promise<AcceptedAgentTurn> {
  return dependencies.mutations.run(control.caseId, async () => {
    const current = control.snapshot.run;
    if (current.state.kind !== "active") return { kind: "stop", run: current };
    const duration = remainingDuration(dependencies, control, current);
    if (decision === undefined) {
      const run = policyFailure(dependencies, current, decisionId, duration);
      await commitControlRun(dependencies, control, run, true);
      return { kind: "stop", run };
    }
    const safeDecision =
      decision.kind === "tool"
        ? agentDecisionSchema.parse({
            ...decision,
            toolCall: dependencies.tools.sanitize(control.caseId, decision.toolCall),
          })
        : decision;
    const projection = await loadAgentProjection(dependencies, control.caseId);
    if (projection.contextDigest !== control.approvedContextDigest) {
      const run = pauseAgentDecisionForContext(
        current,
        safeDecision,
        dependencies.identifiers.nextStepId(),
        duration,
      );
      await commitControlRun(dependencies, control, run, true);
      return { kind: "stop", run };
    }
    const history =
      safeDecision.kind === "tool" ? classifyToolCall(current, safeDecision.toolCall) : undefined;
    if (safeDecision.kind === "tool") {
      try {
        dependencies.tools.validate(safeDecision.toolCall, [
          ...new Set([...projection.citationIds, ...control.citationIds]),
        ]);
      } catch (error) {
        if (!(error instanceof AgentToolPolicyError)) throw error;
        const run = policyFailure(dependencies, current, decisionId, duration);
        await commitControlRun(dependencies, control, run, true);
        return { kind: "stop", run };
      }
      if (history?.kind === "collision") {
        const run = policyFailure(dependencies, current, decisionId, duration);
        await commitControlRun(dependencies, control, run, true);
        return { kind: "stop", run };
      }
    }
    const reduction = recordAgentDecision(
      current,
      safeDecision,
      dependencies.identifiers.nextStepId(),
      dependencies.identifiers.nextStepId(),
      duration,
    );
    await commitControlRun(dependencies, control, reduction.run, true);
    if (reduction.toolCall === undefined) return { kind: "stop", run: reduction.run };
    if (history?.kind === "duplicate-result") return { kind: "continue", run: reduction.run };
    const started = beginAgentTool(
      reduction.run,
      decisionId,
      reduction.toolCall,
      dependencies.identifiers.nextStepId(),
    );
    await commitControlRun(dependencies, control, started, false);
    return { kind: "execute", run: started, call: reduction.toolCall, projection };
  });
}
