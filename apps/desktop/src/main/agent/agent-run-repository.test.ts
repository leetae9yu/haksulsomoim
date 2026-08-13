import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentStepSchema } from "./agent-contracts";
import { AgentRunRepository } from "./agent-run-repository";
import {
  activeRun,
  alternateDigest,
  decisionRecorded,
  decisionStarted,
  toolFinished,
  toolStarted,
  withSteps,
} from "./agent-run-repository.fixtures";

const roots: string[] = [];
const key = new Uint8Array(32).fill(7);

function runRecordName(names: readonly string[]): string {
  const name = names.find((candidate) => candidate.endsWith(".json"));
  if (name === undefined) throw new Error("missing encrypted Agent run record");
  return name;
}

async function fixture(): Promise<{
  root: string;
  repository: AgentRunRepository;
}> {
  const root = await mkdtemp(join(tmpdir(), "haksul-agent-run-"));
  roots.push(root);
  return {
    root,
    repository: new AgentRunRepository({ directory: root, encryptionKey: key }),
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("encrypted Agent run repository", () => {
  test("round-trips an encrypted ordered run without plaintext facts decisions or errors", async () => {
    const { root, repository } = await fixture();
    const initial = activeRun("private-run", "private-case");
    await repository.create(initial);
    const steps = [decisionStarted(), decisionRecorded()];
    await repository.save({ run: withSteps(initial, steps), cursor: 0 });
    await repository.save({ run: withSteps(initial, steps), cursor: 2 });

    const reopened = new AgentRunRepository({ directory: root, encryptionKey: key });
    expect(await reopened.load("private-run")).toEqual({
      run: withSteps(initial, steps),
      cursor: 2,
    });
    const names = await readdir(root);
    expect(names).toHaveLength(2);
    expect(names.every((name) => /^[a-f0-9]{64}\.(?:claim|json)$/u.test(name))).toBe(true);
    for (const name of names) {
      const path = join(root, name);
      const bytes = await readFile(path, "utf8");
      for (const sentinel of [
        "private-run",
        "private-case",
        "search-official-law",
        "masked payment order requirements",
        "provider secret failure",
      ]) {
        expect(bytes).not.toContain(sentinel);
      }
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
  });

  test("resumes from the last committed observation without duplicate execution", async () => {
    const { repository } = await fixture();
    const initial = activeRun();
    await repository.create(initial);
    const started = [decisionStarted(), decisionRecorded(), toolStarted()];
    await repository.save({ run: withSteps(initial, started), cursor: 0 });
    await repository.save({ run: withSteps(initial, started), cursor: 2 });
    const completed = [...started, toolFinished()];
    await repository.save({ run: withSteps(initial, completed), cursor: 2 });
    await repository.save({ run: withSteps(initial, completed), cursor: 4 });

    await repository.save({ run: withSteps(initial, completed), cursor: 4 });
    expect(await repository.load(initial.runId)).toEqual({
      run: withSteps(initial, completed),
      cursor: 4,
    });
    await repository.save({
      run: withSteps(initial, [...completed, toolFinished("step-5")]),
      cursor: 4,
    });
    expect((await repository.load(initial.runId)).run.steps).toHaveLength(4);
    await expect(
      repository.save({
        run: withSteps(initial, [...completed, toolFinished("step-5", alternateDigest)]),
        cursor: 4,
      }),
    ).rejects.toThrow("completed tool result");
  });

  test("converts an ambiguous in-flight step to typed interrupted on restart", async () => {
    const { root, repository } = await fixture();
    const initial = activeRun("restart-run");
    const inFlight = withSteps(initial, [decisionStarted()]);
    await repository.create(initial);
    await repository.save({ run: inFlight, cursor: 0 });

    const reopened = new AgentRunRepository({ directory: root, encryptionKey: key });
    const recovered = await reopened.load(initial.runId);
    expect(recovered.run.state).toEqual({
      kind: "interrupted",
      interruption: { kind: "application-restarted" },
    });
    expect(recovered.run.steps).toEqual([
      decisionStarted(),
      expect.objectContaining({
        kind: "interrupted",
        interruption: { kind: "application-restarted" },
      }),
    ]);
    expect(recovered.cursor).toBe(0);
    expect(await reopened.load(initial.runId)).toEqual(recovered);
  });

  test("publishes atomically and rejects duplicate runs while cleaning temporary files", async () => {
    const { root, repository } = await fixture();
    const initial = activeRun("duplicate-run");
    await repository.create(initial);

    await expect(repository.create(initial)).rejects.toThrow("already exists");
    const names = await readdir(root);
    expect(names).toHaveLength(2);
    expect(names.every((name) => /^[a-f0-9]{64}\.(?:claim|json)$/u.test(name))).toBe(true);
  });

  test("rejects plaintext, corrupt records, and duplicate publication", async () => {
    const { root, repository } = await fixture();
    const unsafe = activeRun("unsafe-run");
    const unsafeDecision = decisionRecorded();
    if (
      unsafeDecision.kind !== "decision-recorded" ||
      unsafeDecision.decision.kind !== "tool" ||
      unsafeDecision.decision.toolCall.toolName !== "search-official-law"
    ) {
      throw new Error("fixture mismatch");
    }
    await repository.create(unsafe);
    await expect(repository.create(unsafe)).rejects.toThrow("already exists");
    await expect(
      repository.save({
        run: withSteps(unsafe, [
          decisionStarted(),
          {
            ...unsafeDecision,
            decision: {
              ...unsafeDecision.decision,
              toolCall: { ...unsafeDecision.decision.toolCall, query: "010-1234-5678" },
            },
          },
        ]),
        cursor: 0,
      }),
    ).rejects.toThrow("redacted");

    await expect(
      repository.create(withSteps(activeRun("malformed-run"), [decisionRecorded()])),
    ).rejects.toThrow("start checkpoint");
    const names = await readdir(root);
    const path = join(root, runRecordName(names));
    await chmod(path, 0o600);
    await writeFile(path, JSON.stringify({ version: 1, nonce: "malformed" }), "utf8");
    await expect(repository.load(unsafe.runId)).rejects.toThrow();
    await writeFile(path, "not encrypted", "utf8");
    await expect(repository.load(unsafe.runId)).rejects.toThrow();
  });

  test("rejects a tool result whose tool name differs from its committed start", async () => {
    const { repository } = await fixture();
    const initial = activeRun("mismatched-tool-run");
    const started = [decisionStarted(), decisionRecorded(), toolStarted()];
    const finished = toolFinished();
    if (finished.kind !== "tool-finished" || finished.result.toolName !== "search-official-law") {
      throw new Error("fixture mismatch");
    }
    const mismatched = agentStepSchema.parse({
      ...finished,
      result: { ...finished.result, toolName: "inspect-masked-case" },
    });
    await repository.create(initial);
    await repository.save({ run: withSteps(initial, started), cursor: 0 });

    await expect(
      repository.save({ run: withSteps(initial, [...started, mismatched]), cursor: 0 }),
    ).rejects.toThrow("tool name");
  });

  test("requires result persistence before cursor advance and preserves immutable history", async () => {
    const { repository } = await fixture();
    const initial = activeRun("ordered-run");
    await repository.create(initial);
    const started = withSteps(initial, [decisionStarted()]);

    await expect(
      repository.save({ run: withSteps(initial, [decisionRecorded()]), cursor: 0 }),
    ).rejects.toThrow("start checkpoint");
    await expect(
      repository.save({ run: withSteps(initial, [toolFinished()]), cursor: 0 }),
    ).rejects.toThrow("start checkpoint");
    await expect(repository.save({ run: started, cursor: 1 })).rejects.toThrow("separate commit");
    await repository.save({ run: started, cursor: 0 });
    await expect(repository.save({ run: started, cursor: 1 })).rejects.toThrow("in-flight");
    await expect(
      repository.save({ run: withSteps(initial, [decisionRecorded()]), cursor: 0 }),
    ).rejects.toThrow("immutable");
  });
});
