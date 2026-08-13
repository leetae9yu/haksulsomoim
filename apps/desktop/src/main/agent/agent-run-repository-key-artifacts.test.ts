import { afterEach, describe, expect, test } from "bun:test";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRunRepository } from "./agent-run-repository";

const roots: string[] = [];
const key = new Uint8Array(32).fill(51);

async function root(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "haksul-agent-key-artifact-"));
  roots.push(directory);
  return directory;
}

async function artifactFingerprint(path: string): Promise<string> {
  const metadata = await lstat(path);
  let detail: unknown;
  if (metadata.isSymbolicLink()) {
    detail = await readlink(path);
  } else if (metadata.isDirectory()) {
    const names = await readdir(path);
    detail = await Promise.all(
      names.map(async (name) => [name, await readFile(join(path, name), "utf8")]),
    );
  } else {
    detail = await readFile(path, "utf8");
  }
  return JSON.stringify({
    dev: metadata.dev,
    ino: metadata.ino,
    mode: metadata.mode,
    nlink: metadata.nlink,
    size: metadata.size,
    detail,
  });
}

async function createAttackerArtifact(
  kind: string,
  directory: string,
): Promise<Readonly<{ name: string; path: string }>> {
  const suffix = kind === "attacker-format" ? `${"a".repeat(24)}.tmp` : `${kind}.tmp`;
  const name = `.agent-repository-key.${suffix}`;
  const path = join(directory, name);
  if (kind === "directory") {
    await mkdir(path, { mode: 0o700 });
    await writeFile(join(path, "payload"), "attacker-directory", { mode: 0o600 });
  } else if (kind === "symlink" || kind === "hardlink") {
    const external = await root();
    const target = join(external, "attacker-target");
    await writeFile(target, `attacker-${kind}`, { mode: 0o600 });
    if (kind === "symlink") await symlink(target, path);
    else await link(target, path);
  } else {
    await writeFile(path, `attacker-${kind}`, { mode: 0o600 });
  }
  return { name, path };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Agent repository key marker attacker artifacts", () => {
  for (const kind of [
    "stale",
    "malformed",
    "symlink",
    "directory",
    "hardlink",
    "attacker-format",
  ]) {
    test(`rejects a pre-existing ${kind} prefix artifact without mutation`, async () => {
      const directory = await root();
      const artifact = await createAttackerArtifact(kind, directory);
      const before = await artifactFingerprint(artifact.path);
      const repository = new AgentRunRepository({ directory, encryptionKey: key });
      let code = "accepted";
      try {
        await repository.activeRunId("attacker-case");
      } catch (error) {
        code =
          error instanceof Error && "code" in error && typeof error.code === "string"
            ? error.code
            : "UNKNOWN";
      }

      expect(code).toBe("AGENT_REPOSITORY_KEY_MARKER_INVALID");
      expect(await readdir(directory)).toEqual([artifact.name]);
      expect(await artifactFingerprint(artifact.path)).toBe(before);
    });
  }

  test("removes only its owned publication temp and preserves sibling artifacts", async () => {
    const parent = await root();
    const directory = join(parent, "repository");
    await mkdir(directory, { mode: 0o700 });
    const attackerName = ".haksulsomoim-agent-repository-key.attacker.tmp";
    const attackerPath = join(parent, attackerName);
    await writeFile(attackerPath, "attacker-parent-temp", { mode: 0o600 });
    const before = await artifactFingerprint(attackerPath);

    const repository = new AgentRunRepository({ directory, encryptionKey: key });
    expect(await repository.activeRunId("safe-case")).toBeUndefined();
    expect(await readdir(directory)).toEqual([".agent-repository-key"]);
    expect((await readdir(parent)).sort()).toEqual([attackerName, "repository"]);
    expect(await artifactFingerprint(attackerPath)).toBe(before);
  });
});
