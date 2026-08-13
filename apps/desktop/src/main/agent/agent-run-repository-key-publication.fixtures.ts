import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENT_REPOSITORY_KEY_MARKER,
  type CanonicalAgentRepositoryDirectory,
} from "./agent-run-repository-key-path";

export const publicationArtifactKinds = ["file", "hardlink", "symlink", "directory"] as const;

export type PublicationArtifactKind = (typeof publicationArtifactKinds)[number];

export type PublicationFixture = Readonly<{
  directory: CanonicalAgentRepositoryDirectory;
  marker: string;
  moved: string;
  root: string;
  staged: string;
  verifier: string;
}>;

export type ArtifactFingerprint = Readonly<{
  dev: number;
  ino: number;
  kind: "directory" | "file" | "symlink";
  value: string;
}>;

export async function publicationFixture(label: string): Promise<PublicationFixture> {
  const root = await mkdtemp(join(tmpdir(), `haksul-source-unlink-${label}-`));
  const metadata = await stat(root);
  return {
    directory: { path: root, dev: metadata.dev, ino: metadata.ino },
    marker: join(root, AGENT_REPOSITORY_KEY_MARKER),
    moved: join(root, "owned-marker-moved"),
    root,
    staged: join(root, "attacker-staged"),
    verifier: label
      .padEnd(64, "a")
      .slice(0, 64)
      .replaceAll(/[^a-f0-9]/gu, "a"),
  };
}

export async function createPublicationArtifact(
  kind: PublicationArtifactKind,
  path: string,
  parent: string,
  label: string,
): Promise<ArtifactFingerprint> {
  if (kind === "directory") {
    await mkdir(path, { mode: 0o700 });
    await writeFile(join(path, "payload"), `attacker-${label}`, { mode: 0o600 });
  } else if (kind === "symlink") {
    const target = join(parent, `attacker-target-${label}`);
    await writeFile(target, `attacker-${label}`, { mode: 0o600 });
    await symlink(target, path);
  } else if (kind === "hardlink") {
    const target = join(parent, `attacker-target-${label}`);
    await writeFile(target, `attacker-${label}`, { mode: 0o600 });
    await link(target, path);
  } else {
    await writeFile(path, `attacker-${label}`, { mode: 0o600 });
  }
  return artifactFingerprint(path);
}

export async function artifactFingerprint(path: string): Promise<ArtifactFingerprint> {
  const metadata = await lstat(path);
  if (metadata.isDirectory()) {
    return {
      dev: metadata.dev,
      ino: metadata.ino,
      kind: "directory",
      value: await readFile(join(path, "payload"), "utf8"),
    };
  }
  if (metadata.isSymbolicLink()) {
    return {
      dev: metadata.dev,
      ino: metadata.ino,
      kind: "symlink",
      value: await readlink(path),
    };
  }
  return {
    dev: metadata.dev,
    ino: metadata.ino,
    kind: "file",
    value: await readFile(path, "utf8"),
  };
}
