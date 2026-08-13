import { afterEach, describe, expect, test } from "bun:test";
import { readdir, rename, rm, stat } from "node:fs/promises";
import {
  agentRepositoryKeyVerifierEntry,
  publishAgentRepositoryKeyMarker,
} from "./agent-run-repository-key-cleanup";
import {
  artifactFingerprint,
  createPublicationArtifact,
  publicationFixture,
} from "./agent-run-repository-key-publication.fixtures";

const roots: string[] = [];

async function postProofSwapRound(round: number): Promise<void> {
  const current = await publicationFixture(`round-${round}`);
  roots.push(current.root);
  const attacker = await createPublicationArtifact(
    "file",
    current.staged,
    current.root,
    `round-${round}`,
  );

  const result = await publishAgentRepositoryKeyMarker(current.marker, current.verifier, {
    checkpoint: async (checkpoint) => {
      if (checkpoint.phase !== "after-source-proof") return;
      await rename(current.marker, current.moved);
      await rename(current.staged, current.marker);
    },
  });

  expect(result).toBe("published");
  expect(await artifactFingerprint(current.marker)).toEqual(attacker);
  expect(await readdir(current.moved)).toEqual([agentRepositoryKeyVerifierEntry(current.verifier)]);
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Agent repository key marker source lifecycle", () => {
  test("preserves an attacker swapped after exact source identity proof", async () => {
    await postProofSwapRound(0);
  });

  test("binds publication to the proved directory handle across 64 rounds", async () => {
    for (let round = 1; round <= 64; round += 1) await postProofSwapRound(round);
  }, 30_000);

  test("leaves no owned staging or cleanup residue after normal publication", async () => {
    const current = await publicationFixture("normal-zero-residue");
    roots.push(current.root);

    expect(await publishAgentRepositoryKeyMarker(current.marker, current.verifier)).toBe(
      "published",
    );

    const entry = agentRepositoryKeyVerifierEntry(current.verifier);
    expect(await readdir(current.root)).toEqual([".agent-repository-key"]);
    expect(await readdir(current.marker)).toEqual([entry]);
    expect((await stat(current.marker)).mode & 0o777).toBe(0o700);
    expect((await stat(`${current.marker}/${entry}`)).mode & 0o777).toBe(0o600);
  });
});
