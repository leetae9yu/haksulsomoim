export interface OcrBoundingBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface RecognizedCandidate {
  readonly text: string;
  readonly confidence: number;
  readonly boundingBox: OcrBoundingBox;
}

export interface OcrCandidate extends RecognizedCandidate {
  readonly confirmation: "unconfirmed";
}

export type UnreadableReason = "empty-input" | "no-text-detected" | "recognition-failed";

export interface ReadableOcrResult {
  readonly status: "readable";
  readonly candidates: readonly OcrCandidate[];
  readonly needsManualConfirmation: true;
}

export interface UnreadableOcrResult {
  readonly status: "unreadable";
  readonly reason: UnreadableReason;
  readonly candidates: readonly [];
  readonly needsManualConfirmation: true;
}

export type LocalOcrResult = ReadableOcrResult | UnreadableOcrResult;

export interface LocalOcrPort {
  recognize(imageBytes: Uint8Array): Promise<LocalOcrResult>;
  terminate(): Promise<void>;
}

/** The narrow seam between the queue/safety policy and an OCR engine. */
export interface LocalOcrRecognizer {
  recognize(imageBytes: Uint8Array): Promise<readonly RecognizedCandidate[]>;
  terminate(): Promise<void>;
}

const unreadable = (reason: UnreadableReason): UnreadableOcrResult => ({
  status: "unreadable",
  reason,
  candidates: [],
  needsManualConfirmation: true,
});

const isFiniteBoundingBox = (box: OcrBoundingBox): boolean =>
  Number.isFinite(box.x) &&
  Number.isFinite(box.y) &&
  Number.isFinite(box.width) &&
  Number.isFinite(box.height) &&
  box.width > 0 &&
  box.height > 0;

const toUnconfirmedCandidate = (candidate: RecognizedCandidate): OcrCandidate | undefined => {
  const text = candidate.text.trim();
  if (
    text.length === 0 ||
    !Number.isFinite(candidate.confidence) ||
    candidate.confidence < 0 ||
    candidate.confidence > 100 ||
    !isFiniteBoundingBox(candidate.boundingBox)
  ) {
    return undefined;
  }

  return {
    text,
    confidence: candidate.confidence,
    boundingBox: { ...candidate.boundingBox },
    confirmation: "unconfirmed",
  };
};

/**
 * Serializes access to a local recognizer and applies the no-invention safety
 * contract. Every extracted value remains unconfirmed for human review.
 */
export class TesseractJsLocalOcrAdapter implements LocalOcrPort {
  readonly #recognizer: LocalOcrRecognizer;
  #queue: Promise<void> = Promise.resolve();
  #terminated = false;
  #termination: Promise<void> | undefined;

  constructor(recognizer: LocalOcrRecognizer) {
    this.#recognizer = recognizer;
  }

  recognize(imageBytes: Uint8Array): Promise<LocalOcrResult> {
    if (this.#terminated) {
      throw new Error("OCR adapter is terminated");
    }

    if (imageBytes.byteLength === 0) {
      return Promise.resolve(unreadable("empty-input"));
    }

    const ownedImageBytes = imageBytes.slice();
    return this.#enqueue(async () => {
      let recognized: readonly RecognizedCandidate[];
      try {
        recognized = await this.#recognizer.recognize(ownedImageBytes);
      } catch {
        return unreadable("recognition-failed");
      }

      const candidates = recognized
        .map(toUnconfirmedCandidate)
        .filter((candidate): candidate is OcrCandidate => candidate !== undefined);

      if (candidates.length === 0) {
        return unreadable("no-text-detected");
      }

      return {
        status: "readable",
        candidates,
        needsManualConfirmation: true,
      };
    });
  }

  terminate(): Promise<void> {
    if (this.#termination !== undefined) {
      return this.#termination;
    }

    this.#terminated = true;
    this.#termination = this.#enqueue(() => this.#recognizer.terminate());
    return this.#termination;
  }

  #enqueue<Result>(operation: () => Promise<Result>): Promise<Result> {
    const result = this.#queue.then(operation);
    this.#queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
