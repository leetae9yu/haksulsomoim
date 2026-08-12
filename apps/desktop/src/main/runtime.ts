import { randomBytes } from "node:crypto";
import { join } from "node:path";
import {
  type CodexAgentProvider,
  createCodexAgentProvider,
} from "../integrations/agent-provider/agent-provider";
import { launchCodexAppServer } from "../integrations/agent-provider/codex-app-server-launcher";
import {
  createKoreanLawMcpAdapter,
  type KoreanLawMcpAdapter,
} from "../integrations/korean-law-mcp/korean-law-mcp";
import type { LocalOcrPort } from "../ocr/local-ocr";
import { createLocalKorEngOcr } from "../ocr/tesseract-recognizer";
import { Redactor } from "../security/redaction";
import { LocalCaseStore } from "../storage/local-case-store";
import { createDesktopHandlers, type DesktopHandlers } from "./ipc-handlers";
import { EncryptedRuntimeCaseRepository } from "./runtime-case-repository";
import { CaseRuntimeService } from "./runtime-case-service";

export interface DesktopRuntime {
  readonly handlers: DesktopHandlers;
  dispose(): Promise<void>;
}

export interface DesktopRuntimeFactories {
  readonly loadKey?: (userDataPath: string) => Promise<Uint8Array>;
  readonly createLaw?: () => KoreanLawMcpAdapter;
  readonly createOcr?: () => Promise<LocalOcrPort>;
  readonly createProvider?: () => Promise<CodexAgentProvider>;
}

export async function createDesktopRuntime(
  userDataPath: string,
  factories: DesktopRuntimeFactories = {},
): Promise<DesktopRuntime> {
  const loadKey =
    factories.loadKey ??
    (async (path: string) => (await import("./master-key")).loadMasterKey(path));
  const masterKey = await loadKey(userDataPath);
  const store = new LocalCaseStore({
    rootPath: join(userDataPath, "case-vault"),
    encryptionKey: masterKey,
    idGenerator: () => randomBytes(16).toString("hex"),
  });
  await store.initialize();
  const repository = new EncryptedRuntimeCaseRepository(
    join(userDataPath, "case-vault", "runtime-cases"),
    masterKey,
  );
  const law = (factories.createLaw ?? createKoreanLawMcpAdapter)();

  let ocrPromise: Promise<LocalOcrPort> | undefined;
  const getOcr = () => {
    ocrPromise ??= (factories.createOcr ?? createLocalKorEngOcr)();
    return ocrPromise;
  };
  let providerPromise: Promise<CodexAgentProvider> | undefined;
  const getProvider = () => {
    const createProvider =
      factories.createProvider ?? (() => createCodexAgentProvider(() => launchCodexAppServer()));
    providerPromise ??= createProvider();
    return providerPromise;
  };

  const service = new CaseRuntimeService({
    repository,
    nextCaseId: () => randomBytes(16).toString("hex"),
    storeEvidence: (bytes) => store.writeEvidence(bytes),
    analyzeEvidence: async (bytes) => (await getOcr()).recognize(bytes),
    redactor: new Redactor(masterKey),
    law,
    provider: getProvider,
  });

  return {
    handlers: createDesktopHandlers(service),
    async dispose() {
      const disposals: Promise<unknown>[] = [law.close()];
      if (ocrPromise !== undefined) disposals.push(ocrPromise.then((ocr) => ocr.terminate()));
      if (providerPromise !== undefined) {
        disposals.push(providerPromise.then((provider) => provider.dispose()));
      }
      const results = await Promise.allSettled(disposals);
      const failures = results
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason);
      if (failures.length > 0) {
        throw new AggregateError(failures, "Desktop runtime disposal failed");
      }
    },
  };
}
