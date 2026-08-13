import type { AgentLoopRunner } from "./agent-loop-runner";

export function afterAuthoritativeToolSettlement(
  runner: AgentLoopRunner,
  release: () => Promise<void>,
): void {
  void runner.authoritativeSettlement?.then(release).catch(() => undefined);
}
