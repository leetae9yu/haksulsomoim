declare module "app-builder-lib/out/toolsets/7zip.js" {
  export function getPath7za(): Promise<string>;
}

declare module "app-builder-lib/out/toolsets/windows.js" {
  export function getMakeNsisPath(
    version: "1.2.1",
  ): Promise<Readonly<{ path: string; env?: NodeJS.ProcessEnv }>>;
}
