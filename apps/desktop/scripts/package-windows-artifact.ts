import type { Stats } from "node:fs";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  realpathSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

function sameIdentity(
  left: Readonly<{ dev: number; ino: number }>,
  right: Readonly<{ dev: number; ino: number }>,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertOwned(stat: Stats, label: string): void {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (uid !== undefined && stat.uid !== uid) throw new Error(`${label} is not owned by this user`);
}

export function securePrivateArtifact(path: string, raceProbe?: () => void): void {
  const absolute = resolve(path);
  const parent = dirname(absolute);
  const parentBefore = lstatSync(parent);
  if (!parentBefore.isDirectory() || realpathSync(parent) !== parent) {
    throw new Error("Artifact parent must be a regular non-symlink directory");
  }
  assertOwned(parentBefore, "Artifact parent");
  const pathBefore = lstatSync(absolute);
  if (!pathBefore.isFile() || pathBefore.nlink !== 1) {
    throw new Error("Artifact must be a regular non-symlink file with one link");
  }
  assertOwned(pathBefore, "Artifact");

  const descriptor = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || !sameIdentity(pathBefore, opened)) {
      throw new Error("Artifact identity changed before privacy enforcement");
    }
    raceProbe?.();
    const pathCurrent = lstatSync(absolute);
    const parentCurrent = lstatSync(parent);
    if (!sameIdentity(opened, pathCurrent) || !sameIdentity(parentBefore, parentCurrent)) {
      throw new Error("Artifact identity changed during privacy enforcement");
    }
    fchmodSync(descriptor, 0o600);
    fsyncSync(descriptor);
    const secured = fstatSync(descriptor);
    const finalPath = lstatSync(absolute);
    const finalParent = lstatSync(parent);
    if (
      (secured.mode & 0o777) !== 0o600 ||
      !sameIdentity(secured, finalPath) ||
      !sameIdentity(parentBefore, finalParent)
    ) {
      throw new Error("Artifact identity changed after privacy enforcement");
    }
  } finally {
    closeSync(descriptor);
  }
}
