import { afterEach, describe, expect, test } from "bun:test";
import { readFile, rename, rm, stat } from "node:fs/promises";
import { AgentRunRepository } from "./agent-run-repository";
import {
  publishAgentRepositoryKeyMarker,
  serializeAgentRepositoryKeyMarker,
} from "./agent-run-repository-key-publication";
import {
  artifactFingerprint,
  createPublicationArtifact,
  publicationFixture,
} from "./agent-run-repository-key-publication.fixtures";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Agent repository atomic marker file", () => {
  test("keeps the atomically returned file descriptor bound after pathname replacement", async () => {
    const current = await publicationFixture("atomic-file-replacement");
    roots.push(current.root);
    const attacker = await createPublicationArtifact(
      "file",
      current.staged,
      current.root,
      "atomic-file-replacement",
    );

    const publication = publishAgentRepositoryKeyMarker(current.directory, current.verifier, {
      checkpoint: async (checkpoint) => {
        if (checkpoint.phase !== "after-source-created") return;
        const created = await stat(current.marker);
        expect(created.isFile()).toBe(true);
        expect(created.mode & 0o777).toBe(0o600);
        expect(created.nlink).toBe(1);
        expect(created.size).toBe(0);
        await rename(current.marker, current.moved);
        await rename(current.staged, current.marker);
      },
    });

    await expect(publication).rejects.toMatchObject({
      code: "AGENT_REPOSITORY_KEY_MARKER_PUBLICATION_FAILED",
    });
    expect(await artifactFingerprint(current.marker)).toEqual(attacker);
    expect((await stat(current.moved)).isFile()).toBe(true);
    expect((await readFile(current.moved)).toString("hex")).toBe(
      serializeAgentRepositoryKeyMarker(current.verifier).toString("hex"),
    );

    const repository = new AgentRunRepository({
      directory: current.root,
      encryptionKey: new Uint8Array(32).fill(71),
    });
    await expect(repository.activeRunId("replacement-case")).rejects.toMatchObject({
      code: "AGENT_REPOSITORY_KEY_MARKER_INVALID",
    });
    expect(await artifactFingerprint(current.marker)).toEqual(attacker);
  });
});
