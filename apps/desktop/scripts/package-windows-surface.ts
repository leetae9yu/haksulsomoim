import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const forbiddenPath =
  /(?:^|\/)(?:readme(?:[-_.][^/]*)?|docs?|examples?|specs?|tests?|src|source|skills?)(?:\/|$)|(?:\.map|\.d\.[cm]?ts)$|(?:^|\/)(?:cli|mcp)\.(?:js|cjs|mjs)$/iu;
const forbiddenTopLevelDocumentation =
  /(?:\/node_modules\/(?:@[^/]+\/)?[^/]+\/)(?:readme|changelog|change[-_]log|history|contributing|security)(?:\.[^/]*)?$/iu;
const forbiddenTargetedSurface =
  /(?:^|\/)korean-law-mcp\/build\/(?:setup\.js|server\/)|(?:^|\/)@kordoc\/core\/dist\/(?:commands\/|mcp\/server\.js$)|(?:^|\/)openai\/(?:bin\/cli|client\/websocket|internal\/qs|server\/(?:http|sse))/iu;
const forbiddenGeneral =
  /(^|\/)(?:\.omo|evidence|secrets?|test|tests|__tests__)(?:\/|$)|(^|\/)(?:qa(?:[-_.]|$)|[^/]+\.(?:test|spec)\.[cm]?[jt]sx?|\.env(?:\.[^/]+)?)(?:$|\/)/iu;
const advertisedCommands = [
  "codex - universal",
  "codex - login",
  "kordoc init",
  "kordoc validate",
] as const;
const forbiddenManifestFields = ["bin", "scripts", "devDependencies"] as const;

export function isForbiddenReleasePath(path: string): boolean {
  return (
    forbiddenPath.test(path) ||
    forbiddenTopLevelDocumentation.test(path) ||
    forbiddenTargetedSurface.test(path) ||
    forbiddenGeneral.test(path)
  );
}

export function assertReleaseSurface(root: string, paths: readonly string[]): void {
  const forbidden = paths.filter(isForbiddenReleasePath);
  if (forbidden.length > 0) throw new Error(`Forbidden release paths: ${forbidden.join(", ")}`);

  for (const path of paths) {
    const absolute = join(root, path);
    if (
      !existsSync(absolute) ||
      !statSync(absolute).isFile() ||
      !/\.(?:cjs|mjs|js|json|md|txt)$/iu.test(path)
    )
      continue;
    const contents = readFileSync(absolute, "utf8");
    const command = advertisedCommands.find((candidate) =>
      contents.toLowerCase().includes(candidate),
    );
    if (command !== undefined) throw new Error(`Advertised command remains in ${path}: ${command}`);
    if (!path.endsWith("package.json")) continue;
    const manifest: unknown = JSON.parse(contents);
    if (typeof manifest !== "object" || manifest === null) {
      throw new Error(`Invalid packaged manifest: ${path}`);
    }
    const field = forbiddenManifestFields.find(
      (candidate) => candidate in (manifest as Record<string, unknown>),
    );
    if (field !== undefined)
      throw new Error(`Non-runtime manifest field ${field} remains: ${path}`);
  }
}
