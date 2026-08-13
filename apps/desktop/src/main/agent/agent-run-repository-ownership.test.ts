import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRunRepository } from "./agent-run-repository";
import { activeRun, decisionStarted, withSteps } from "./agent-run-repository.fixtures";
import { EncryptedAgentRunRecordStore } from "./agent-run-repository-record";

const roots: string[] = [];
const key = new Uint8Array(32).fill(43);

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve = (_value: T): void => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function fixture(): Promise<{ root: string; repository: AgentRunRepository }> {
  const root = await mkdtemp(join(tmpdir(), "haksul-agent-ownership-"));
  roots.push(root);
  return {
    root,
    repository: new AgentRunRepository({ directory: root, encryptionKey: key }),
  };
}

async function conflictingSaves(
  leftRepository: AgentRunRepository,
  rightRepository: AgentRunRepository,
  runId: string,
  caseId: string,
): Promise<PromiseSettledResult<void>[]> {
  const initial = activeRun(runId, caseId);
  await leftRepository.create(initial);
  const originalWrite = EncryptedAgentRunRecordStore.prototype.write;
  const bothWritesArrived = deferred<void>();
  const releaseWrites = deferred<void>();
  let arrivals = 0;
  EncryptedAgentRunRecordStore.prototype.write = async function (
    ...args: Parameters<typeof originalWrite>
  ): Promise<void> {
    if (!args[1]) {
      arrivals += 1;
      if (arrivals === 2) bothWritesArrived.resolve();
      await releaseWrites.promise;
    }
    return originalWrite.apply(this, args);
  };
  const left = withSteps(initial, [decisionStarted("left-step", "left-decision")]);
  const right = withSteps(initial, [decisionStarted("right-step", "right-decision")]);
  try {
    const saves = [
      leftRepository.save({ run: left, cursor: 0 }),
      rightRepository.save({ run: right, cursor: 0 }),
    ];
    await bothWritesArrived.promise;
    releaseWrites.resolve();
    return await Promise.allSettled(saves);
  } finally {
    releaseWrites.resolve();
    EncryptedAgentRunRecordStore.prototype.write = originalWrite;
  }
}

function expectOneWinner(settled: PromiseSettledResult<void>[]): void {
  expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(settled.filter((result) => result.status === "rejected")).toHaveLength(1);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Agent run repository same-process ownership", () => {
  test("prevents one repository instance from committing conflicting saves", async () => {
    const { repository } = await fixture();
    expectOneWinner(await conflictingSaves(repository, repository, "single-run", "single-case"));
  });

  test("prevents two repository instances in one process from both committing", async () => {
    const { root, repository: left } = await fixture();
    const right = new AgentRunRepository({ directory: root, encryptionKey: key });
    const settled = await conflictingSaves(left, right, "shared-run", "shared-case");

    expectOneWinner(settled);
    const committed = await left.load("shared-run");
    expect(committed.run.steps).toHaveLength(2);
    expect(["left-step", "right-step"]).toContain(committed.run.steps[0]?.stepId ?? "");
    expect(committed.run.steps[1]).toMatchObject({ kind: "interrupted" });
  });
});
