import { createHash } from "node:crypto";

import type {
  ScreenMaskRegion,
  SecureBrowserPort,
  SecureComputerAction,
  SecureComputerActionResult,
  SecureComputerObservation,
} from "../contracts/secure-computer";
import { secureComputerActionSchema } from "../contracts/secure-computer";
import { SecureComputerActionGate } from "./action-gate";
import type { Redactor } from "./redaction";
import { SecureComputerRedactionSession } from "./redaction-session";

export const MAX_MASKED_IMAGE_BYTES = 3_000_000;

interface SecureComputerServiceOptions {
  readonly browser: SecureBrowserPort;
  readonly caseId: string;
  readonly redactor: Redactor;
  readonly allowedHosts: readonly string[];
  readonly maxActions: number;
}

const rejected = (reason: string, actionCount: number): SecureComputerActionResult => ({
  outcome: "rejected",
  reason,
  actionCount,
});

const overlaps = (
  left: ScreenMaskRegion["boundingBox"],
  right: ScreenMaskRegion["boundingBox"],
): boolean =>
  left.x < right.x + right.width &&
  left.x + left.width > right.x &&
  left.y < right.y + right.height &&
  left.y + left.height > right.y;

const contains = (
  outer: ScreenMaskRegion["boundingBox"],
  inner: ScreenMaskRegion["boundingBox"],
): boolean =>
  outer.x <= inner.x &&
  outer.y <= inner.y &&
  outer.x + outer.width >= inner.x + inner.width &&
  outer.y + outer.height >= inner.y + inner.height;

const collapseMaskRegions = (regions: readonly ScreenMaskRegion[]): readonly ScreenMaskRegion[] => {
  const collapsed: ScreenMaskRegion[] = [];
  const largestFirst = [...regions].sort(
    (left, right) =>
      right.boundingBox.width * right.boundingBox.height -
      left.boundingBox.width * left.boundingBox.height,
  );
  for (const region of largestFirst) {
    if (!collapsed.some((outer) => contains(outer.boundingBox, region.boundingBox)))
      collapsed.push(region);
  }
  return collapsed;
};

export class SecureComputerService {
  readonly #browser: SecureBrowserPort;
  readonly #redaction: SecureComputerRedactionSession;
  readonly #gate: SecureComputerActionGate;
  readonly #maxActions: number;
  #actionCount = 0;
  #latestObservation: SecureComputerObservation | undefined;
  #operationQueue: Promise<void> = Promise.resolve();
  #started = false;

  constructor(options: SecureComputerServiceOptions) {
    if (!Number.isSafeInteger(options.maxActions) || options.maxActions < 1) {
      throw new RangeError("maxActions must be a positive safe integer");
    }
    this.#browser = options.browser;
    this.#redaction = new SecureComputerRedactionSession(options.caseId, options.redactor);
    this.#gate = new SecureComputerActionGate(options.allowedHosts);
    this.#maxActions = options.maxActions;
  }

  start(url: string): Promise<void> {
    return this.#enqueue(async () => {
      const probe = this.#gate.evaluate({
        url,
        action: { kind: "scroll", deltaX: 0, deltaY: 0, observationDigest: "0".repeat(64) },
      });
      if (probe.outcome !== "allowed") throw new Error(probe.reason);
      await this.#browser.start(url);
      this.#started = true;
    });
  }

  observe(): Promise<SecureComputerObservation> {
    return this.#enqueue(async () => {
      this.#assertStarted();
      this.#latestObservation = undefined;
      const inspection = await this.#browser.inspect();
      const origin = this.#gate.evaluate({
        url: inspection.url,
        action: { kind: "scroll", deltaX: 0, deltaY: 0, observationDigest: "0".repeat(64) },
      });
      if (origin.outcome !== "allowed") throw new Error(origin.reason);
      const analyzed = inspection.candidates.map((candidate) => ({
        candidate,
        redacted: this.#redaction.redact(candidate.text),
      }));
      const regions = collapseMaskRegions(
        analyzed
          .filter(({ candidate, redacted }) => redacted.text !== candidate.text)
          .map(({ candidate, redacted }) => ({
            label: redacted.text,
            boundingBox: candidate.boundingBox,
          })),
      );
      const maskedText = analyzed.map(({ candidate, redacted }) =>
        redacted.text !== candidate.text
          ? redacted.text
          : (regions.find((region) => overlaps(region.boundingBox, candidate.boundingBox))?.label ??
            redacted.text),
      );
      const imagePng = await this.#browser.captureMasked(regions);
      if (imagePng.byteLength > MAX_MASKED_IMAGE_BYTES) {
        throw new RangeError(
          `Masked screenshot exceeds the byte limit of ${MAX_MASKED_IMAGE_BYTES}`,
        );
      }
      const text = [...new Set(maskedText)].join("\n").slice(0, 20_000);
      const observation = Object.freeze({
        url: inspection.url,
        width: inspection.width,
        height: inspection.height,
        imagePng: imagePng.slice(),
        maskedText: text,
        observationDigest: createHash("sha256")
          .update(inspection.url, "utf8")
          .update("\0")
          .update(imagePng)
          .update("\0")
          .update(text, "utf8")
          .digest("hex"),
      });
      this.#latestObservation = observation;
      return observation;
    });
  }

  act(input: SecureComputerAction): Promise<SecureComputerActionResult> {
    return this.#enqueue(async () => {
      this.#assertStarted();
      const action = secureComputerActionSchema.parse(input);
      if (this.#latestObservation?.observationDigest !== action.observationDigest)
        return rejected("stale-observation", this.#actionCount);
      if (this.#actionCount >= this.#maxActions)
        return rejected("action-budget-exhausted", this.#actionCount);
      const target =
        action.kind === "scroll" ? undefined : await this.#browser.targetAt(action.x, action.y);
      const decision = this.#gate.evaluate(
        target === undefined
          ? { url: this.#latestObservation.url, action }
          : { url: this.#latestObservation.url, action, target },
      );
      if (decision.outcome !== "allowed") return { ...decision, actionCount: this.#actionCount };
      await this.#execute(action);
      this.#actionCount += 1;
      this.#latestObservation = undefined;
      return { outcome: "executed", actionCount: this.#actionCount };
    });
  }

  close(): Promise<void> {
    return this.#enqueue(async () => {
      this.#latestObservation = undefined;
      this.#started = false;
      this.#redaction.dispose();
      await this.#browser.close();
    });
  }

  async #execute(action: SecureComputerAction): Promise<void> {
    switch (action.kind) {
      case "click":
        return this.#browser.click(action.x, action.y);
      case "type-text":
        return this.#browser.typeText(action.x, action.y, action.text);
      case "type-token":
        return this.#browser.typeText(action.x, action.y, this.#redaction.rehydrate(action.token));
      case "scroll":
        return this.#browser.scroll(action.deltaX, action.deltaY);
    }
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operationQueue.then(operation, operation);
    this.#operationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  #assertStarted(): void {
    if (!this.#started) throw new Error("Secure computer session is not started");
  }
}
