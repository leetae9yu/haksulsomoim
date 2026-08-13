import { afterEach, describe, expect, test } from "bun:test";
import { readdir, rm } from "node:fs/promises";
import {
  AgentRepositoryKeyPublicationError,
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

async function insertBeforeCapture(kind: PublicationArtifactKind): Promise<void> {
  const current = await publicationFixture(`pre-capture-${kind}`);
  roots.push(current.root);
  let attacker: Awaited<ReturnType<typeof createPublicationArtifact>> | undefined;

  const result = await publishAgentRepositoryKeyMarker(current.directory, current.verifier, {
    checkpoint: async (checkpoint) => {
      if (checkpoint.phase !== "before-source-capture") return;
      attacker = await createPublicationArtifact(
        kind,
        checkpoint.sourcePath,
        current.root,
        `pre-capture-${kind}`,
      );
    },
  });
  if (attacker === undefined) throw new Error("source capture checkpoint not reached");

  expect(result).toBe("contended");
  expect(await artifactFingerprint(current.marker)).toEqual(attacker);
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Agent repository marker adversarial capture", () => {
  for (const kind of publicationArtifactKinds) {
    test(`preserves a pre-capture marker ${kind}`, async () => {
      await insertBeforeCapture(kind);
    });
  }

  for (const verifier of [
    "A".repeat(64),
    "a".repeat(63),
    `${"a".repeat(63)}/`,
    `${"a".repeat(63)}:`,
    "한".repeat(64),
  ]) {
    test(`rejects a non-portable verifier ${JSON.stringify(verifier.slice(-2))}`, async () => {
      const current = await publicationFixture("invalid-verifier");
      roots.push(current.root);

      expect(() => serializeAgentRepositoryKeyMarker(verifier)).toThrow(
        AgentRepositoryKeyPublicationError,
      );
      expect(await readdir(current.root)).toEqual([]);
    });
  }

  test("serializes one fixed Windows-safe versioned marker", () => {
    const marker = serializeAgentRepositoryKeyMarker("a".repeat(64));
    expect(marker.toString("ascii")).toBe(
      `haksulsomoim-agent-repository-key:v1:${"a".repeat(64)}\n`,
    );
  });
});
