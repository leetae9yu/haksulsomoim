import { awaitRuntimeDeadline, type RuntimeDeadlineTimer } from "../runtime-deadline";
import type { AgentRuntimeExternalDependencies } from "./agent-runtime-composition";
import type { AgentUnavailableReason } from "./agent-runtime-types";

export async function initializeAgentIntegrations(
  external: AgentRuntimeExternalDependencies,
  options: Readonly<{
    signal: AbortSignal;
    deadlineMs: number;
    timer?: RuntimeDeadlineTimer | undefined;
  }>,
): Promise<AgentUnavailableReason | undefined> {
  const deadline = Date.now() + options.deadlineMs;
  const initialization = Promise.allSettled([
    external.law.discover({ signal: options.signal, deadline }),
    external.provider(options.signal),
  ]);
  const [mcp, provider] = await awaitRuntimeDeadline(initialization, {
    phase: "agent-initialization",
    deadlineMs: options.deadlineMs,
    timer: options.timer,
    signal: options.signal,
  });
  if (provider.status === "rejected") return "provider-initialization";
  if (mcp.status === "rejected" || mcp.value.length === 0) return "mcp-initialization";
  if (typeof provider.value.nextDecision !== "function") return "provider-initialization";
  return undefined;
}
