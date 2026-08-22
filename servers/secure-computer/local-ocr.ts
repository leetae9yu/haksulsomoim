import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import Tesseract from "tesseract.js";

import type { LocalOcrPort, OcrBoundingBox, OcrCandidate } from "../contracts/ocr";

const moduleRequire = createRequire(import.meta.url);
const LANGUAGES = "kor+eng";

const trainedDataPath = (languagePackage: string, language: string): string =>
  join(
    dirname(moduleRequire.resolve(`${languagePackage}/package.json`)),
    "4.0.0_best_int",
    `${language}.traineddata.gz`,
  );

const stageLocalLanguages = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "haksulsomoim-ocr-"));
  try {
    await Promise.all([
      copyFile(
        trainedDataPath("@tesseract.js-data/kor", "kor"),
        join(directory, "kor.traineddata.gz"),
      ),
      copyFile(
        trainedDataPath("@tesseract.js-data/eng", "eng"),
        join(directory, "eng.traineddata.gz"),
      ),
    ]);
    return directory;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
};

const toBoundingBox = (bbox: Tesseract.Bbox): OcrBoundingBox => ({
  x: bbox.x0,
  y: bbox.y0,
  width: bbox.x1 - bbox.x0,
  height: bbox.y1 - bbox.y0,
});

const candidatesFromBlocks = (blocks: readonly Tesseract.Block[] | null): readonly OcrCandidate[] =>
  (blocks ?? []).flatMap((block) =>
    block.paragraphs.flatMap((paragraph) =>
      paragraph.lines.flatMap((line) =>
        line.words
          .filter(
            (word) => word.text.trim().length > 0 && word.confidence >= 0 && word.confidence <= 100,
          )
          .map((word) => ({
            text: word.text.trim(),
            confidence: word.confidence,
            boundingBox: toBoundingBox(word.bbox),
          })),
      ),
    ),
  );

class LocalKorEngOcr implements LocalOcrPort {
  readonly #worker: Tesseract.Worker;
  readonly #languageDirectory: string;
  #queue: Promise<void> = Promise.resolve();
  #disposed = false;
  #disposal: Promise<void> | undefined;

  constructor(worker: Tesseract.Worker, languageDirectory: string) {
    this.#worker = worker;
    this.#languageDirectory = languageDirectory;
  }

  recognize(image: Uint8Array): Promise<readonly OcrCandidate[]> {
    if (this.#disposed) throw new Error("OCR recognizer is disposed");
    if (image.byteLength === 0) return Promise.resolve([]);
    const ownedImage = image.slice();
    return this.#enqueue(async () => {
      const result = await this.#worker.recognize(
        Buffer.from(ownedImage),
        {},
        { text: true, blocks: true },
      );
      return candidatesFromBlocks(result.data.blocks);
    });
  }

  dispose(): Promise<void> {
    if (this.#disposal !== undefined) return this.#disposal;
    this.#disposed = true;
    this.#disposal = this.#enqueue(async () => {
      try {
        await this.#worker.terminate();
      } finally {
        await rm(this.#languageDirectory, { recursive: true, force: true });
      }
    });
    return this.#disposal;
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

export const createLocalKorEngOcr = async (): Promise<LocalOcrPort> => {
  const languageDirectory = await stageLocalLanguages();
  try {
    const worker = await Tesseract.createWorker(LANGUAGES, Tesseract.OEM.LSTM_ONLY, {
      langPath: languageDirectory,
      cacheMethod: "none",
      gzip: true,
    });
    return new LocalKorEngOcr(worker, languageDirectory);
  } catch (error) {
    await rm(languageDirectory, { recursive: true, force: true });
    throw error;
  }
};
