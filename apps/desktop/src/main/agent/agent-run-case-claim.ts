import { createHmac, randomBytes } from "node:crypto";
import { access, link, open, realpath, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  type AgentCaseClaim,
  parseAgentCaseClaim,
  readAgentCaseClaim,
  serializeAgentCaseClaim,
} from "./agent-case-claim-record";
import {
  AgentClaimTransactionBusyError,
  withClaimTransaction,
} from "./agent-case-claim-transaction";
import {
  type AgentToolLease,
  type AgentToolLeaseIdentity,
  agentToolLeaseSchema,
  sameToolLease,
} from "./agent-case-tool-lease";
import { agentRunIdSchema, caseIdSchema } from "./agent-contracts-core";
import { AgentRepositoryKeyVerifier } from "./agent-run-repository-key";

const claimTails = new Map<string, Promise<void>>();

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export class AgentCaseAlreadyClaimedError extends Error {
  readonly code = "AGENT_CASE_ALREADY_CLAIMED";

  constructor(options?: ErrorOptions) {
    super("An active Agent run already exists for this case", options);
    this.name = "AgentCaseAlreadyClaimedError";
  }
}

export class AgentCaseClaimInvariantError extends Error {
  readonly code = "AGENT_CASE_CLAIM_INVARIANT";

  constructor(message: string) {
    super(message);
    this.name = "AgentCaseClaimInvariantError";
  }
}

export class EncryptedAgentCaseClaimStore {
  readonly #directory: string;
  readonly #key: Uint8Array;
  readonly #verifier: AgentRepositoryKeyVerifier;

  constructor(
    directory: string,
    key: Uint8Array,
    verifier = new AgentRepositoryKeyVerifier(directory, key),
  ) {
    this.#directory = directory;
    this.#key = Uint8Array.from(key);
    this.#verifier = verifier;
  }

  async acquire(caseId: string, runId: string): Promise<void> {
    const claim = parseAgentCaseClaim({ caseId, runId, toolLease: null });
    await this.#withCase(claim.caseId, (locator) =>
      this.#mutate(locator, () => this.#publish(claim, locator, true)),
    );
  }

  async owner(caseId: string): Promise<string | undefined> {
    const parsedCaseId = caseIdSchema.parse(caseId);
    return this.#withCase(parsedCaseId, async (locator) => {
      const claim = await this.#read(parsedCaseId, locator);
      return claim?.runId;
    });
  }

  async beginToolLease(lease: AgentToolLease): Promise<void> {
    const parsed = agentToolLeaseSchema.parse(lease);
    await this.#updateLease(parsed.caseId, parsed.runId, (claim) => {
      if (claim.toolLease !== null) throw new AgentCaseAlreadyClaimedError();
      return { ...claim, toolLease: parsed };
    });
  }

  async settleToolLease(expected: AgentToolLeaseIdentity): Promise<void> {
    await this.#updateLease(expected.caseId, expected.runId, (claim) => {
      if (claim.toolLease === null || !sameToolLease(claim.toolLease, expected)) {
        throw new AgentCaseClaimInvariantError("Agent tool lease identity mismatch");
      }
      return { ...claim, toolLease: null };
    });
  }

  async quarantine(
    caseId: string,
    runId: string,
    identity?: AgentToolLeaseIdentity,
  ): Promise<void> {
    const fallback = agentToolLeaseSchema.parse({
      caseId,
      runId,
      stepId: "unresolved-tool",
      toolExecutionToken: "unresolved-tool",
      startedAt: Date.now(),
      deadline: Date.now(),
      state: "quarantined",
    });
    const expected = identity ?? fallback;
    await this.#updateLease(caseId, runId, (claim) => {
      if (claim.toolLease !== null && !sameToolLease(claim.toolLease, expected)) {
        throw new AgentCaseClaimInvariantError("Agent quarantine lease mismatch");
      }
      return {
        ...claim,
        toolLease:
          claim.toolLease === null
            ? {
                ...expected,
                startedAt: Date.now(),
                deadline: Date.now(),
                state: "quarantined" as const,
              }
            : { ...claim.toolLease, state: "quarantined" as const },
      };
    });
  }

  async isQuarantined(caseId: string): Promise<boolean> {
    const parsedCaseId = caseIdSchema.parse(caseId);
    return this.#withCase(parsedCaseId, async (locator) => {
      try {
        await access(join(this.#directory, `${locator}.claim-lock`));
        return true;
      } catch (error) {
        if (!isNodeError(error, "ENOENT")) throw error;
      }
      const claim = await this.#read(parsedCaseId, locator);
      return claim !== undefined && claim.toolLease !== null;
    });
  }

  async release(caseId: string, runId: string): Promise<void> {
    const expected = { caseId: caseIdSchema.parse(caseId), runId: agentRunIdSchema.parse(runId) };
    await this.#withCase(expected.caseId, (locator) =>
      this.#mutate(locator, async () => {
        const claim = await this.#read(expected.caseId, locator);
        if (claim === undefined) return;
        if (claim.runId !== expected.runId) {
          throw new AgentCaseClaimInvariantError("Agent case claim belongs to another run");
        }
        if (claim.toolLease !== null) throw new AgentCaseAlreadyClaimedError();
        await unlink(this.#path(locator));
        await this.#syncDirectory();
      }),
    );
  }

  #locator(caseId: string): string {
    return createHmac("sha256", this.#key)
      .update("haksulsomoim:agent-case-claim:v1\0")
      .update(caseId)
      .digest("hex");
  }

  #path(locator: string): string {
    return join(this.#directory, `${locator}.claim`);
  }

  async #withCase<T>(
    caseId: string,
    operation: (locator: string, lockKey: string) => Promise<T>,
  ): Promise<T> {
    await this.#verifier.verify();
    const locator = this.#locator(caseId);
    const lockKey = `${await realpath(this.#directory)}\0${locator}`;
    const previous = claimTails.get(lockKey) ?? Promise.resolve();
    let release = (): void => undefined;
    const turn = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => turn);
    claimTails.set(lockKey, tail);
    await previous;
    try {
      return await operation(locator, lockKey);
    } finally {
      release();
      if (claimTails.get(lockKey) === tail) claimTails.delete(lockKey);
    }
  }

  async #updateLease(
    caseId: string,
    runId: string,
    update: (claim: AgentCaseClaim) => AgentCaseClaim,
  ): Promise<void> {
    const parsedCaseId = caseIdSchema.parse(caseId);
    const parsedRunId = agentRunIdSchema.parse(runId);
    await this.#withCase(parsedCaseId, (locator) =>
      this.#mutate(locator, async () => {
        const claim = await this.#read(parsedCaseId, locator);
        if (claim?.runId !== parsedRunId) {
          throw new AgentCaseClaimInvariantError("Agent tool lease owner mismatch");
        }
        await this.#publish(parseAgentCaseClaim(update(claim)), locator, false);
      }),
    );
  }

  async #mutate<T>(locator: string, operation: () => Promise<T>): Promise<T> {
    try {
      return await withClaimTransaction(this.#directory, locator, operation);
    } catch (error) {
      if (error instanceof AgentClaimTransactionBusyError) {
        throw new AgentCaseAlreadyClaimedError({ cause: error });
      }
      throw error;
    }
  }

  async #read(caseId: string, locator: string): Promise<AgentCaseClaim | undefined> {
    const claim = await readAgentCaseClaim(this.#path(locator), this.#key, locator);
    if (claim !== undefined && claim.caseId !== caseId) {
      throw new AgentCaseClaimInvariantError("Agent case claim locator mismatch");
    }
    return claim;
  }

  async #publish(claim: AgentCaseClaim, locator: string, exclusive: boolean): Promise<void> {
    const serialized = serializeAgentCaseClaim(claim, this.#key, locator);
    const temporaryPath = join(this.#directory, `.${randomBytes(12).toString("hex")}.tmp`);
    try {
      const file = await open(temporaryPath, "wx", 0o600);
      try {
        await file.writeFile(serialized, "utf8");
        await file.sync();
      } finally {
        await file.close();
      }
      if (exclusive) {
        await link(temporaryPath, this.#path(locator));
        await unlink(temporaryPath);
      } else {
        await rename(temporaryPath, this.#path(locator));
      }
      await this.#syncDirectory();
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      if (exclusive && isNodeError(error, "EEXIST")) {
        throw new AgentCaseAlreadyClaimedError({ cause: error });
      }
      throw error;
    }
  }

  async #syncDirectory(): Promise<void> {
    const directory = await open(this.#directory, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
}
