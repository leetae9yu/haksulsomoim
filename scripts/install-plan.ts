export interface InstallPlan {
  readonly claude: readonly string[];
  readonly codex: readonly (readonly string[])[];
}

export function createInstallPlan(marketplaceRoot: string, pluginRoot: string): InstallPlan {
  return {
    claude: ["claude", "--plugin-dir", pluginRoot],
    codex: [
      ["codex", "plugin", "marketplace", "add", marketplaceRoot],
      ["codex", "plugin", "add", "haksulsomoim-small-fraud@haksulsomoim-local"],
    ],
  };
}
