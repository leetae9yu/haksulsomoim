import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { publishAgentRepositoryKeyMarker } from "./agent-run-repository-key-publication";
import {
  artifactFingerprint,
  createPublicationArtifact,
  publicationFixture,
} from "./agent-run-repository-key-publication.fixtures";

const roots: string[] = [];

async function postWriteSwapRound(round: number): Promise<void> {
  const current = await publicationFixture(`round-${round}`);
  roots.push(current.root);
  const attacker = await createPublicationArtifact(
    "file",
    current.staged,
    current.root,
    `round-${round}`,
  );

  const publication = publishAgentRepositoryKeyMarker(current.directory, current.verifier, {
    checkpoint: async (checkpoint) => {
      if (checkpoint.phase !== "after-source-written") return;
      await rename(current.marker, current.moved);
      await rename(current.staged, current.marker);
    },
  });

  await expect(publication).rejects.toMatchObject({
    code: "AGENT_REPOSITORY_KEY_MARKER_PUBLICATION_FAILED",
  });
  expect(await artifactFingerprint(current.marker)).toEqual(attacker);
  expect(await readFile(current.moved, "utf8")).toContain(current.verifier);
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Agent repository key marker source lifecycle", () => {
  test("keeps creation beneath the pinned parent descriptor after a parent swap", async () => {
    const current = await publicationFixture("parent-swap");
    const replacement = `${current.root}-replacement`;
    const movedParent = `${current.root}-moved`;
    roots.push(current.root, replacement, movedParent);
    await mkdir(replacement, { mode: 0o700 });

    expect(
      await publishAgentRepositoryKeyMarker(current.directory, current.verifier, {
        checkpoint: async (checkpoint) => {
          if (checkpoint.phase !== "before-source-capture") return;
          await rename(current.root, movedParent);
          await rename(replacement, current.root);
        },
      }),
    ).toBe("published");

    expect(await readdir(current.root)).toEqual([]);
    const movedMarker = `${movedParent}/.agent-repository-key`;
    expect((await stat(movedMarker)).isFile()).toBe(true);
    expect(await readFile(movedMarker, "utf8")).toContain(current.verifier);
  });

  test("fails closed on a post-write pathname replacement", async () => {
    await postWriteSwapRound(0);
  });

  test("fences the fixed marker pathname across 64 deterministic rounds", async () => {
    for (let round = 1; round <= 64; round += 1) await postWriteSwapRound(round);
  }, 30_000);

  test("leaves only the fixed marker after normal publication", async () => {
    const current = await publicationFixture("normal-zero-residue");
    roots.push(current.root);

    expect(await publishAgentRepositoryKeyMarker(current.directory, current.verifier)).toBe(
      "published",
    );

    expect(await readdir(current.root)).toEqual([".agent-repository-key"]);
    const metadata = await stat(current.marker);
    expect(metadata.isFile()).toBe(true);
    expect(metadata.mode & 0o777).toBe(0o600);
    expect(metadata.nlink).toBe(1);
    expect(await readFile(current.marker, "utf8")).toContain(current.verifier);
  });
});
