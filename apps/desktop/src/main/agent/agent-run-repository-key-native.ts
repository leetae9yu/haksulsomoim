import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const nativeRequire = createRequire(import.meta.url);

type NativeOpenedFile = Readonly<{ fd: number }>;

export type AgentRepositoryKeyNativeBinding = Readonly<{
  openBeneath(rootFd: number, relativePath: string, flags: number): NativeOpenedFile;
}>;

let loadedBinding: AgentRepositoryKeyNativeBinding | undefined;

function isNativeBinding(value: unknown): value is AgentRepositoryKeyNativeBinding {
  return (
    typeof value === "object" &&
    value !== null &&
    "openBeneath" in value &&
    typeof value.openBeneath === "function"
  );
}

export function agentRepositoryKeyNativeBinding(): AgentRepositoryKeyNativeBinding {
  if (loadedBinding !== undefined) return loadedBinding;
  const packageRoot = dirname(nativeRequire.resolve("@openclaw/fs-safe/package.json"));
  const loader: unknown = nativeRequire(join(packageRoot, "dist/native.js"));
  if (
    typeof loader !== "object" ||
    loader === null ||
    !("requireNativeBinding" in loader) ||
    typeof loader.requireNativeBinding !== "function"
  ) {
    throw new Error("Agent repository native filesystem helper is invalid");
  }
  const binding: unknown = loader.requireNativeBinding();
  if (!isNativeBinding(binding)) {
    throw new Error("Agent repository native filesystem binding is invalid");
  }
  loadedBinding = binding;
  return binding;
}
