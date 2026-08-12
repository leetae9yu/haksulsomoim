import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = fileURLToPath(new URL("../../", import.meta.url));

async function source(relativePath: string): Promise<string> {
  return readFile(resolve(desktopRoot, relativePath), "utf8");
}

describe("production lifecycle security regression", () => {
  test("contains no environment-controlled key or user-data override", async () => {
    const [mainSource, keySource] = await Promise.all([
      source("src/main/index.ts"),
      source("src/main/master-key.ts"),
    ]);

    expect(`${mainSource}\n${keySource}`).not.toContain("HAKSUL_QA");
    expect(keySource).not.toContain("process.env");
  });

  test("QA isolates Electron user data without environment backdoors", async () => {
    const qaSource = await source("scripts/qa-desktop.ts");

    expect(qaSource).toContain("--user-data-dir=");
    expect(qaSource).not.toContain("process.env");
    expect(qaSource).not.toContain("HAKSUL_QA_USER_DATA");
  });

  test("builds the deterministic entry explicitly and excludes it from packaging", async () => {
    const [qaSource, packageConfig, builderConfig] = await Promise.all([
      source("src/main/qa.ts"),
      source("package.json"),
      source("electron-builder.yml"),
    ]);

    expect(qaSource).toContain("HAKSUL_QA_ONLY_DETERMINISTIC_KEY_V1");
    expect(packageConfig).toContain('"node": ">=22.18.0"');
    expect(builderConfig).toContain("!out/main/qa.js");
    expect(packageConfig).not.toContain("src/main/qa.ts");
  });
});
