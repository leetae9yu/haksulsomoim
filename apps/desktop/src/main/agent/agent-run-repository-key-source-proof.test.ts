import { afterEach, describe, expect, test } from "bun:test";
import { readdir, rename, rm } from "node:fs/promises";
import {
  agentRepositoryKeyVerifierEntry,
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

async function swapMarkerAfterProof(kind: PublicationArtifactKind): Promise<void> {
  const current = await publicationFixture(`post-proof-${kind}`);
  roots.push(current.root);
  const attacker = await createPublicationArtifact(
    kind,
    current.staged,
    current.root,
    `post-proof-${kind}`,
  );

  expect(
    await publishAgentRepositoryKeyMarker(current.marker, current.verifier, {
      checkpoint: async (checkpoint) => {
        if (checkpoint.phase !== "after-source-proof") return;
        await rename(current.marker, current.moved);
        await rename(current.staged, current.marker);
      },
    }),
  ).toBe("published");

  expect(await artifactFingerprint(current.marker)).toEqual(attacker);
  expect(await readdir(current.moved)).toEqual([agentRepositoryKeyVerifierEntry(current.verifier)]);
}

async function swapVerifierAfterCapture(kind: PublicationArtifactKind): Promise<void> {
  const current = await publicationFixture(`post-verifier-${kind}`);
  roots.push(current.root);
  const attacker = await createPublicationArtifact(
    kind,
    current.staged,
    current.root,
    `post-verifier-${kind}`,
  );
  let verifierPath = "";

  expect(
    await publishAgentRepositoryKeyMarker(current.marker, current.verifier, {
      checkpoint: async (checkpoint) => {
        if (checkpoint.phase !== "after-verifier-captured") return;
        verifierPath = checkpoint.verifierPath;
        await rename(verifierPath, current.moved);
        await rename(current.staged, verifierPath);
      },
    }),
  ).toBe("published");

  expect(verifierPath).not.toBe("");
  expect(await artifactFingerprint(verifierPath)).toEqual(attacker);
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Agent repository marker handle-relative source proof", () => {
  for (const kind of publicationArtifactKinds) {
    test(`preserves a ${kind} marker replacement after source proof`, async () => {
      await swapMarkerAfterProof(kind);
    });

    test(`preserves a ${kind} verifier replacement after capture`, async () => {
      await swapVerifierAfterCapture(kind);
    });
  }
});
