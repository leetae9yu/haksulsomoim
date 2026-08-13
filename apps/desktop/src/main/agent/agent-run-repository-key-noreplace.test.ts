import { afterEach, describe, expect, test } from "bun:test";
import { readdir, readFile, rm } from "node:fs/promises";
import {
  AgentRepositoryKeyPublicationError,
  publishAgentRepositoryKeyMarker,
} from "./agent-run-repository-key-cleanup";
import {
  artifactFingerprint,
  createPublicationArtifact,
  type PublicationArtifactKind,
  publicationArtifactKinds,
  publicationFixture,
} from "./agent-run-repository-key-publication.fixtures";

const roots: string[] = [];

async function publicationFailure(
  operation: Promise<unknown>,
): Promise<AgentRepositoryKeyPublicationError> {
  try {
    await operation;
  } catch (error) {
    if (error instanceof AgentRepositoryKeyPublicationError) return error;
    throw error;
  }
  throw new Error("expected typed marker publication failure");
}

async function insertVerifierDestination(
  kind: PublicationArtifactKind,
  label: string,
): Promise<void> {
  const current = await publicationFixture(label);
  roots.push(current.root);
  let attacker: Awaited<ReturnType<typeof createPublicationArtifact>> | undefined;
  let verifierPath = "";

  const error = await publicationFailure(
    publishAgentRepositoryKeyMarker(current.marker, current.verifier, {
      checkpoint: async (checkpoint) => {
        if (checkpoint.phase !== "after-source-proof") return;
        verifierPath = checkpoint.verifierPath;
        attacker = await createPublicationArtifact(kind, verifierPath, current.root, label);
      },
    }),
  );
  if (attacker === undefined) throw new Error("destination insertion checkpoint not reached");

  expect(error.code).toBe("AGENT_REPOSITORY_KEY_MARKER_PUBLICATION_FAILED");
  expect(error.cause).toMatchObject({ code: "EEXIST" });
  expect(await artifactFingerprint(verifierPath)).toEqual(attacker);
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Agent repository marker no-replace verifier capture", () => {
  test("preserves destination insertion across 64 deterministic rounds", async () => {
    for (let round = 1; round <= 64; round += 1) {
      await insertVerifierDestination("file", `destination-round-${round}`);
    }
  }, 30_000);

  for (const kind of publicationArtifactKinds) {
    test(`preserves a colliding verifier ${kind}`, async () => {
      await insertVerifierDestination(kind, `destination-${kind}`);
    });
  }

  test("leaves a completed marker unchanged when publication is contended", async () => {
    const current = await publicationFixture("completed-contention");
    roots.push(current.root);
    await publishAgentRepositoryKeyMarker(current.marker, current.verifier);
    const [entry] = await readdir(current.marker);
    if (entry === undefined) throw new Error("expected verifier entry");

    expect(await publishAgentRepositoryKeyMarker(current.marker, "b".repeat(64))).toBe("contended");
    expect(await readdir(current.marker)).toEqual([entry]);
    expect(await readFile(`${current.marker}/${entry}`, "utf8")).toBe("");
  });
});
