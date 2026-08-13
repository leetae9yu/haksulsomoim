import { readdirSync, rmSync } from "node:fs";
import { join, relative } from "node:path";

export function pruneDependencyMetadata(root: string): void {
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      const relativePath = relative(root, absolute).replaceAll("\\", "/");
      if (entry.isDirectory()) visit(absolute);
      else if (
        /\.(?:map|d\.[cm]?ts)$/u.test(entry.name) ||
        /^(?:node_modules\/)?kordoc\/dist\/(?:cli|mcp)\.js$/u.test(relativePath)
      ) {
        rmSync(absolute, { force: true });
      }
    }
  };
  visit(root);
}
