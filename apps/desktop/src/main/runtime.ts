import { randomBytes } from "node:crypto";
import { join } from "node:path";
import {
  type CodexAgentDecisionProvider,
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
import { EncryptedAgentArtifactStore } from "./agent/agent-artifact-store";
import { AgentLifecycleRuntime } from "./agent/agent-lifecycle-runtime";
import { AgentRunRepository } from "./agent/agent-run-repository";
import { ComposedAgentRuntime, type DesktopAgentRuntime } from "./agent/agent-runtime";
import { createAgentLoopDependencies } from "./agent/agent-runtime-composition";
import type { AgentExecutionTimer } from "./agent/agent-tool-execution";
import {
  type AgentLifecycleService,
  createDesktopHandlers,
  type DesktopHandlers,
} from "./ipc-handlers";
import { RuntimeCaseMutationQueue } from "./runtime-case-mutation-queue";
import { EncryptedRuntimeCaseRepository } from "./runtime-case-repository";
import { CaseRuntimeService } from "./runtime-case-service";
import { awaitRuntimeDeadline, type RuntimeDeadlineTimer } from "./runtime-deadline";
import { LazyRuntimeIntegration } from "./runtime-integration-lifecycle";

export interface DesktopRuntime {
  readonly handlers: DesktopHandlers;
  readonly agent: DesktopAgentRuntime;
  readonly agentLifecycle: AgentLifecycleService;
  dispose(): Promise<void>;
}

export interface DesktopRuntimeFactories {
  readonly loadKey?: (userDataPath: string) => Promise<Uint8Array>;
  readonly createLaw?: () => KoreanLawMcpAdapter;
  readonly createOcr?: (signal?: AbortSignal) => Promise<LocalOcrPort>;
  readonly createProvider?: (signal?: AbortSignal) => Promise<CodexAgentProvider>;
  readonly lifecycle?: Readonly<{
    timer?: RuntimeDeadlineTimer | undefined;
    initializationDeadlineMs?: number;
    disposalDeadlineMs?: number;
  }>;
  readonly agentExecution?: Readonly<{
    timer?: AgentExecutionTimer;
    toolTimeoutMs?: number;
    toolSettlementGraceMs?: number;
  }>;
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
  const agentRuns = new AgentRunRepository({
    directory: join(userDataPath, "case-vault", "agent-runs"),
    encryptionKey: masterKey,
  });
  const agentArtifacts = new EncryptedAgentArtifactStore(
    join(userDataPath, "case-vault", "agent-artifacts"),
    masterKey,
  );
  const law = (factories.createLaw ?? createKoreanLawMcpAdapter)();
  const redactor = new Redactor(masterKey);
  const mutations = new RuntimeCaseMutationQueue();

  const lifecycleAbort = new AbortController();
  const initializationDeadlineMs = factories.lifecycle?.initializationDeadlineMs ?? 30_000;
  const disposalDeadlineMs = factories.lifecycle?.disposalDeadlineMs ?? 500;
  const timer = factories.lifecycle?.timer;
  const ocr = new LazyRuntimeIntegration({
    factory: factories.createOcr ?? (() => createLocalKorEngOcr()),
    cleanup: (resource: LocalOcrPort) => resource.terminate(),
    signal: lifecycleAbort.signal,
    timer,
    deadlineMs: initializationDeadlineMs,
  });
  const provider = new LazyRuntimeIntegration({
    factory:
      factories.createProvider ?? (() => createCodexAgentProvider(() => launchCodexAppServer())),
    cleanup: (resource: CodexAgentProvider) => resource.dispose(),
    signal: lifecycleAbort.signal,
    timer,
    deadlineMs: initializationDeadlineMs,
  });
  const getOcr = () => ocr.get();
  const getProvider = () => provider.get();

  const service = new CaseRuntimeService({
    repository,
    nextCaseId: () => randomBytes(16).toString("hex"),
    storeEvidence: (bytes) => store.writeEvidence(bytes),
    analyzeEvidence: async (bytes) => (await getOcr()).recognize(bytes),
    redactor,
    law,
    provider: getProvider,
    mutations,
  });
  const external = {
    law,
    provider: async () => (await getProvider()) as CodexAgentDecisionProvider,
  };
  const agent = new ComposedAgentRuntime(
    createAgentLoopDependencies({
      runs: agentRuns,
      cases: repository,
      redactor,
      external,
      drafts: agentArtifacts,
      mutations,
      ...factories.agentExecution,
    }),
    external,
    agentRuns,
    factories.lifecycle,
  );
  const agentLifecycle = new AgentLifecycleRuntime(agent, agentRuns, agentArtifacts, mutations);
  let disposal: Promise<void> | undefined;

  return {
    handlers: createDesktopHandlers(service, agentLifecycle),
    agent,
    agentLifecycle,
    dispose() {
      disposal ??= (async () => {
        lifecycleAbort.abort();
        const operations = [agent.dispose(), law.close(), ocr.dispose(), provider.dispose()];
        const bounded = operations.map((operation) =>
          awaitRuntimeDeadline(operation, {
            phase: "desktop-disposal",
            deadlineMs: disposalDeadlineMs,
            timer,
          }),
        );
        const results = await Promise.allSettled(bounded);
        const failures = results
          .filter((result): result is PromiseRejectedResult => result.status === "rejected")
          .map((result) => result.reason);
        if (failures.length > 0) {
          throw new AggregateError(failures, "Desktop runtime disposal failed");
        }
      })();
      return disposal;
    },
  };
}
