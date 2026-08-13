import type { AgentRun } from "./agent-contracts";
import type { AgentRunStore } from "./agent-loop-types";
import type { AgentRunSnapshot } from "./agent-run-repository";

export async function commitAgentRun(
  store: AgentRunStore,
  snapshot: AgentRunSnapshot,
  run: AgentRun,
  settled: boolean,
): Promise<AgentRunSnapshot> {
  const checkpoint = { run, cursor: snapshot.cursor };
  await store.save(checkpoint);
  if (!settled || snapshot.cursor === run.steps.length) return checkpoint;
  const advanced = { run, cursor: run.steps.length };
  await store.save(advanced);
  return advanced;
}
