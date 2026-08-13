import { lstat, mkdir, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";

export const AGENT_REPOSITORY_KEY_MARKER = ".agent-repository-key";
const TEMPORARY_MARKER_PREFIX = ".haksulsomoim-agent-repository-key.";

export type CanonicalAgentRepositoryDirectory = Readonly<{
  path: string;
  dev: number;
  ino: number;
}>;

export function agentRepositoryKeyPublicationPaths(
  canonicalDirectory: string,
  token: string,
): Readonly<{ marker: string; temporary: string }> {
  return {
    marker: join(canonicalDirectory, AGENT_REPOSITORY_KEY_MARKER),
    temporary: join(dirname(canonicalDirectory), `${TEMPORARY_MARKER_PREFIX}${token}.tmp`),
  };
}

export class AgentRepositoryDirectoryPin {
  readonly #requestedPath: string;
  #resolved?: Promise<CanonicalAgentRepositoryDirectory>;

  constructor(requestedPath: string) {
    this.#requestedPath = requestedPath;
  }

  resolve(): Promise<CanonicalAgentRepositoryDirectory> {
    this.#resolved ??= this.#resolve();
    return this.#resolved;
  }

  async matches(directory: CanonicalAgentRepositoryDirectory): Promise<boolean> {
    try {
      const [resolved, metadata] = await Promise.all([
        realpath(this.#requestedPath),
        lstat(directory.path),
      ]);
      return (
        resolved === directory.path &&
        metadata.isDirectory() &&
        metadata.dev === directory.dev &&
        metadata.ino === directory.ino
      );
    } catch {
      return false;
    }
  }

  async #resolve(): Promise<CanonicalAgentRepositoryDirectory> {
    await mkdir(this.#requestedPath, { recursive: true, mode: 0o700 });
    const path = await realpath(this.#requestedPath);
    const metadata = await lstat(path);
    const confirmed = await realpath(this.#requestedPath);
    if (!metadata.isDirectory() || confirmed !== path) {
      throw new Error("Agent repository directory changed during canonicalization");
    }
    return { path, dev: metadata.dev, ino: metadata.ino };
  }
}
