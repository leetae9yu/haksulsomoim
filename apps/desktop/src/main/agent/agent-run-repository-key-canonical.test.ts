import { afterEach, describe, expect, test } from "bun:test";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readlink,
  rename,
  rm,
  stat,
  symlink,
  unlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRunRepository } from "./agent-run-repository";
import { agentRepositoryKeyMarkerPath } from "./agent-run-repository-key-path";

const MARKER = ".agent-repository-key";
const roots: string[] = [];
const key = new Uint8Array(32).fill(101);

type CrossDeviceFixture = Readonly<{
  alias: string;
  aliasParent: string;
  sourceDevice: number;
  target: string;
  targetDevice: number;
  targetParent: string;
}>;

async function crossDeviceFixture(): Promise<CrossDeviceFixture | undefined> {
  const sourceDevice = (await stat(tmpdir())).dev;
  let targetDevice: number;
  try {
    targetDevice = (await stat("/dev/shm")).dev;
  } catch {
    console.info(JSON.stringify({ status: "SKIP", reason: "/dev/shm unavailable", sourceDevice }));
    return undefined;
  }
  if (sourceDevice === targetDevice) {
    console.info(
      JSON.stringify({ status: "SKIP", reason: "single filesystem", sourceDevice, targetDevice }),
    );
    return undefined;
  }
  const aliasParent = await mkdtemp(join(tmpdir(), "haksul-key-canonical-alias-"));
  const targetParent = await mkdtemp("/dev/shm/haksul-key-canonical-target-");
  roots.push(aliasParent, targetParent);
  const alias = join(aliasParent, "repository");
  const target = join(targetParent, "repository");
  await mkdir(target, { mode: 0o700 });
  await symlink(target, alias, "dir");
  return { alias, aliasParent, sourceDevice, target, targetDevice, targetParent };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Agent repository canonical key-marker paths", () => {
  test("publishes first marker through a cross-device canonical symlink", async () => {
    const fixture = await crossDeviceFixture();
    if (fixture === undefined) {
      const canonical = "/mock-device/target/repository";
      expect(agentRepositoryKeyMarkerPath(canonical)).toBe(`${canonical}/${MARKER}`);
      return;
    }
    console.info(
      JSON.stringify({
        status: "CROSS_DEVICE",
        sourceDevice: fixture.sourceDevice,
        targetDevice: fixture.targetDevice,
      }),
    );
    const repository = new AgentRunRepository({ directory: fixture.alias, encryptionKey: key });

    expect(await repository.activeRunId("canonical-case")).toBeUndefined();
    expect(await readdir(fixture.target)).toEqual([MARKER]);
    expect(await readdir(fixture.aliasParent)).toEqual(["repository"]);
    expect(await readdir(fixture.targetParent)).toEqual(["repository"]);
    expect((await lstat(join(fixture.target, MARKER))).dev).toBe(fixture.targetDevice);
  });

  test("serializes canonical and symlink first opens to one marker", async () => {
    const fixture = await crossDeviceFixture();
    if (fixture === undefined) return;
    const alias = new AgentRunRepository({ directory: fixture.alias, encryptionKey: key });
    const canonical = new AgentRunRepository({ directory: fixture.target, encryptionKey: key });

    const settled = await Promise.allSettled([
      alias.activeRunId("alias-case"),
      canonical.activeRunId("canonical-case"),
    ]);

    expect(settled.every((result) => result.status === "fulfilled")).toBe(true);
    expect(await readdir(fixture.target)).toEqual([MARKER]);
    expect(await readdir(fixture.aliasParent)).toEqual(["repository"]);
    expect(await readdir(fixture.targetParent)).toEqual(["repository"]);
  });

  test("rejects a symlink target swap after pinning the canonical directory", async () => {
    const fixture = await crossDeviceFixture();
    if (fixture === undefined) return;
    const replacement = await mkdtemp("/dev/shm/haksul-key-canonical-replacement-");
    roots.push(replacement);
    const repository = new AgentRunRepository({ directory: fixture.alias, encryptionKey: key });
    expect(await repository.activeRunId("before-swap")).toBeUndefined();

    await unlink(fixture.alias);
    await symlink(replacement, fixture.alias, "dir");

    await expect(repository.activeRunId("after-swap")).rejects.toMatchObject({
      code: "AGENT_REPOSITORY_KEY_MARKER_INVALID",
    });
    expect(await readdir(replacement)).toEqual([]);
    expect(await readlink(fixture.alias)).toBe(replacement);
  });

  test("rejects canonical directory inode substitution after pinning", async () => {
    const parent = await mkdtemp(join(tmpdir(), "haksul-key-canonical-substitution-"));
    roots.push(parent);
    const directory = join(parent, "repository");
    const original = join(parent, "original");
    await mkdir(directory, { mode: 0o700 });
    const repository = new AgentRunRepository({ directory, encryptionKey: key });
    expect(await repository.activeRunId("before-substitution")).toBeUndefined();

    await rename(directory, original);
    await mkdir(directory, { mode: 0o700 });

    await expect(repository.activeRunId("after-substitution")).rejects.toMatchObject({
      code: "AGENT_REPOSITORY_KEY_MARKER_INVALID",
    });
    expect(await readdir(directory)).toEqual([]);
    expect(await readdir(original)).toEqual([MARKER]);
  });

  test("does not follow a fixed marker symlink inside the repository", async () => {
    const donor = await mkdtemp(join(tmpdir(), "haksul-key-marker-donor-"));
    const target = await mkdtemp(join(tmpdir(), "haksul-key-marker-symlink-"));
    roots.push(donor, target);
    const donorRepository = new AgentRunRepository({ directory: donor, encryptionKey: key });
    await donorRepository.activeRunId("donor-case");
    const markerLink = join(target, MARKER);
    await symlink(join(donor, MARKER), markerLink);
    const before = await readlink(markerLink);
    const repository = new AgentRunRepository({ directory: target, encryptionKey: key });

    await expect(repository.activeRunId("attacker-case")).rejects.toMatchObject({
      code: "AGENT_REPOSITORY_KEY_MARKER_INVALID",
    });
    expect(await readlink(markerLink)).toBe(before);
    expect((await lstat(join(donor, MARKER))).isFile()).toBe(true);
  });
});
