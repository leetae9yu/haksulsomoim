import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const nonRuntimeDirectory = /^(?:src|source|docs?|examples?)$/iu;
const nonRuntimeFile = /^(?:readme(?:\.[^/]*)?|notice|third_party(?:\.[^/]*)?)$/iu;

function normalized(root: string, path: string): string {
  return relative(root, path).replaceAll("\\", "/");
}

function kordocRelative(path: string): string | undefined {
  const match = /(?:^|\/)kordoc\/(.*)$/u.exec(path);
  return match?.[1];
}

function trimKordocManifest(path: string): void {
  const manifest: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof manifest !== "object" || manifest === null) throw new Error("Invalid Kordoc manifest");
  const runtime = { ...(manifest as Record<string, unknown>) };
  for (const key of [
    "author",
    "bin",
    "description",
    "devDependencies",
    "files",
    "keywords",
    "repository",
    "scripts",
  ]) {
    delete runtime[key];
  }
  writeFileSync(path, `${JSON.stringify(runtime, null, 2)}\n`);
}

export function pruneDependencyMetadata(root: string): void {
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      const relativePath = normalized(root, absolute);
      const kordocPath = kordocRelative(relativePath);
      if (entry.isDirectory()) {
        if (kordocPath !== undefined && nonRuntimeDirectory.test(entry.name)) {
          rmSync(absolute, { force: true, recursive: true });
        } else {
          visit(absolute);
        }
      } else if (
        /\.(?:map|d\.[cm]?ts)$/u.test(entry.name) ||
        (kordocPath !== undefined &&
          (/^dist\/(?:cli|mcp)\.(?:js|cjs|mjs)$/u.test(kordocPath) ||
            nonRuntimeFile.test(entry.name)))
      ) {
        rmSync(absolute, { force: true });
      } else if (kordocPath === "package.json") {
        trimKordocManifest(absolute);
      }
    }
  };
  visit(root);
}
