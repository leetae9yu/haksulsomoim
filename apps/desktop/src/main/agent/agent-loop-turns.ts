import type { parseApprovedDecisionContext } from "../../integrations/agent-provider/agent-decision-contracts";
import { type AgentRun, type AgentToolCall, agentDecisionSchema } from "./agent-contracts";
import { pauseAgentDecisionForContext, pauseIdleAgentRun } from "./agent-loop-boundary-reducer";
import {
  classifyToolCall,
  type ReboundAgentDecision,
  resolveToolCorrelation,
  toolResults,
} from "./agent-loop-decisions";
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
      citationIds: readonly string[];
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
  rebound: ReboundAgentDecision | undefined,
): Promise<AcceptedAgentTurn> {
  return dependencies.mutations.run(control.caseId, async () => {
    const current = control.snapshot.run;
    if (current.state.kind !== "active") return { kind: "stop", run: current };
    const duration = remainingDuration(dependencies, control, current);
    if (rebound === undefined) {
      const run = policyFailure(dependencies, current, decisionId, duration);
      await commitControlRun(dependencies, control, run, true);
      return { kind: "stop", run };
    }
    let safeDecision =
      rebound.decision.kind === "tool"
        ? agentDecisionSchema.parse({
            ...rebound.decision,
            toolCall: dependencies.tools.sanitize(control.caseId, rebound.decision.toolCall),
          })
        : rebound.decision;
    const projection = await loadAgentProjection(dependencies, control.caseId);
    if (projection.contextDigest !== control.approvedContextDigest) {
      const run = pauseAgentDecisionForContext(
        current,
        decisionId,
        dependencies.identifiers.nextStepId(),
        duration,
      );
      await commitControlRun(dependencies, control, run, true);
      return { kind: "stop", run };
    }
    let sourceCitationIds: readonly string[] = [];
    if (safeDecision.kind === "tool") {
      if (rebound.toolCorrelation === undefined) {
        const run = policyFailure(dependencies, current, decisionId, duration);
        await commitControlRun(dependencies, control, run, true);
        return { kind: "stop", run };
      }
      const resolution = resolveToolCorrelation(
        control.toolCorrelations,
        rebound.toolCorrelation,
        safeDecision.toolCall,
      );
      if (resolution.kind === "collision") {
        const run = policyFailure(dependencies, current, decisionId, duration);
        await commitControlRun(dependencies, control, run, true);
        return { kind: "stop", run };
      }
      safeDecision = agentDecisionSchema.parse({
        ...safeDecision,
        toolCall: resolution.call,
      });
      try {
        sourceCitationIds = dependencies.tools.validate(
          resolution.call,
          [...control.citationIds],
          toolResults(current),
        );
      } catch (error) {
        if (!(error instanceof AgentToolPolicyError)) throw error;
        const run = policyFailure(dependencies, current, decisionId, duration);
        await commitControlRun(dependencies, control, run, true);
        return { kind: "stop", run };
      }
      const history = classifyToolCall(current, resolution.call);
      if (history.kind === "collision") {
        const run = policyFailure(dependencies, current, decisionId, duration);
        await commitControlRun(dependencies, control, run, true);
        return { kind: "stop", run };
      }
      if (resolution.kind === "new") {
        control.toolCorrelations.set(rebound.toolCorrelation.key, resolution.binding);
      }
      if (history.kind === "duplicate-result") {
        const reduction = recordAgentDecision(
          current,
          safeDecision,
          dependencies.identifiers.nextStepId(),
          dependencies.identifiers.nextStepId(),
          duration,
        );
        await commitControlRun(dependencies, control, reduction.run, true);
        return { kind: "continue", run: reduction.run };
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
    const started = beginAgentTool(
      reduction.run,
      decisionId,
      reduction.toolCall,
      dependencies.identifiers.nextStepId(),
    );
    await commitControlRun(dependencies, control, started, false);
    return {
      kind: "execute",
      run: started,
      call: reduction.toolCall,
      projection,
      citationIds: sourceCitationIds,
    };
  });
}
