import { afterEach, describe, expect, test } from "bun:test";
import { readFile, rename, rm } from "node:fs/promises";
import {
  type AgentRepositoryKeyPublicationCheckpoint,
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
type ReplacementPhase = Extract<
  AgentRepositoryKeyPublicationCheckpoint["phase"],
  "after-source-created" | "after-source-written"
>;

async function swapFixedMarker(
  kind: PublicationArtifactKind,
  phase: ReplacementPhase,
): Promise<void> {
  const current = await publicationFixture(`${phase}-${kind}`);
  roots.push(current.root);
  const attacker = await createPublicationArtifact(
    kind,
    current.staged,
    current.root,
    `${phase}-${kind}`,
  );

  const publication = publishAgentRepositoryKeyMarker(current.directory, current.verifier, {
    checkpoint: async (checkpoint) => {
      if (checkpoint.phase !== phase) return;
      await rename(current.marker, current.moved);
      await rename(current.staged, current.marker);
    },
  });

  await expect(publication).rejects.toMatchObject({
    code: "AGENT_REPOSITORY_KEY_MARKER_PUBLICATION_FAILED",
  });
  expect(await artifactFingerprint(current.marker)).toEqual(attacker);
  expect((await readFile(current.moved)).toString("hex")).toBe(
    serializeAgentRepositoryKeyMarker(current.verifier).toString("hex"),
  );
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Agent repository marker handle-relative identity proof", () => {
  for (const kind of publicationArtifactKinds) {
    test(`preserves a ${kind} replacement after atomic marker creation`, async () => {
      await swapFixedMarker(kind, "after-source-created");
    });

    test(`preserves a ${kind} replacement after marker fsync`, async () => {
      await swapFixedMarker(kind, "after-source-written");
    });
  }
});
