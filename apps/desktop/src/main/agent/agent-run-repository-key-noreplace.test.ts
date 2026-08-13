import { afterEach, describe, expect, test } from "bun:test";
import { readFile, rm } from "node:fs/promises";
import {
  publishAgentRepositoryKeyMarker,
  serializeAgentRepositoryKeyMarker,
} from "./agent-run-repository-key-publication";
import {
  artifactFingerprint,
  createPublicationArtifact,
  type PublicationArtifactKind,
  publicationArtifactKinds,
  publicationFixture,
} from "./agent-run-repository-key-publication.fixtures";

const roots: string[] = [];

async function insertMarkerDestination(
  kind: PublicationArtifactKind,
  label: string,
): Promise<void> {
  const current = await publicationFixture(label);
  roots.push(current.root);
  let attacker: Awaited<ReturnType<typeof createPublicationArtifact>> | undefined;

  const result = await publishAgentRepositoryKeyMarker(current.directory, current.verifier, {
    checkpoint: async (checkpoint) => {
      if (checkpoint.phase !== "before-source-capture") return;
      attacker = await createPublicationArtifact(kind, checkpoint.sourcePath, current.root, label);
    },
  });
  if (attacker === undefined) throw new Error("destination insertion checkpoint not reached");

  expect(result).toBe("contended");
  expect(await artifactFingerprint(current.marker)).toEqual(attacker);
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Agent repository marker exclusive file capture", () => {
  test("preserves destination insertion across 64 deterministic rounds", async () => {
    for (let round = 1; round <= 64; round += 1) {
      await insertMarkerDestination("file", `destination-round-${round}`);
    }
  }, 30_000);

  for (const kind of publicationArtifactKinds) {
    test(`preserves a colliding marker ${kind}`, async () => {
      await insertMarkerDestination(kind, `destination-${kind}`);
    });
  }

  test("leaves a completed marker unchanged when publication is contended", async () => {
    const current = await publicationFixture("completed-contention");
    roots.push(current.root);
    await publishAgentRepositoryKeyMarker(current.directory, current.verifier);
    const before = await readFile(current.marker);

    expect(await publishAgentRepositoryKeyMarker(current.directory, "b".repeat(64))).toBe(
      "contended",
    );
    expect((await readFile(current.marker)).toString("hex")).toBe(before.toString("hex"));
    expect(before.toString("hex")).toBe(
      serializeAgentRepositoryKeyMarker(current.verifier).toString("hex"),
    );
  });
});
