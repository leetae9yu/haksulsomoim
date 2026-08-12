import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import Tesseract from "tesseract.js";

import {
  type LocalOcrRecognizer,
  type OcrBoundingBox,
  type RecognizedCandidate,
  TesseractJsLocalOcrAdapter,
} from "./local-ocr";

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

const candidatesFromBlocks = (blocks: readonly Tesseract.Block[] | null): RecognizedCandidate[] => {
  if (blocks === null) {
    return [];
  }

  return blocks.flatMap((block) =>
    block.paragraphs.flatMap((paragraph) =>
      paragraph.lines.flatMap((line) =>
        line.words.map((word) => ({
          text: word.text,
          confidence: word.confidence,
          boundingBox: toBoundingBox(word.bbox),
        })),
      ),
    ),
  );
};

class TesseractWorkerRecognizer implements LocalOcrRecognizer {
  readonly #worker: Tesseract.Worker;
  readonly #languageDirectory: string;
  #termination: Promise<void> | undefined;

  constructor(worker: Tesseract.Worker, languageDirectory: string) {
    this.#worker = worker;
    this.#languageDirectory = languageDirectory;
  }

  async recognize(imageBytes: Uint8Array): Promise<readonly RecognizedCandidate[]> {
    const result = await this.#worker.recognize(
      Buffer.from(imageBytes),
      {},
      { text: true, blocks: true },
    );
    return candidatesFromBlocks(result.data.blocks);
  }

  terminate(): Promise<void> {
    if (this.#termination === undefined) {
      this.#termination = this.#terminateWorkerAndRemoveLanguages();
    }
    return this.#termination;
  }

  async #terminateWorkerAndRemoveLanguages(): Promise<void> {
    try {
      await this.#worker.terminate();
    } finally {
      await rm(this.#languageDirectory, { recursive: true, force: true });
    }
  }
}

/**
 * Creates a fully local Korean/English OCR adapter. Trained data is copied from
 * installed packages into an isolated local directory, so Tesseract never
 * falls back to its CDN. Call terminate() to stop the worker and remove it.
 */
export const createLocalKorEngOcr = async (): Promise<TesseractJsLocalOcrAdapter> => {
  const languageDirectory = await stageLocalLanguages();
  try {
    const worker = await Tesseract.createWorker(LANGUAGES, Tesseract.OEM.LSTM_ONLY, {
      langPath: languageDirectory,
      cacheMethod: "none",
      gzip: true,
    });
    return new TesseractJsLocalOcrAdapter(new TesseractWorkerRecognizer(worker, languageDirectory));
  } catch (error) {
    await rm(languageDirectory, { recursive: true, force: true });
    throw error;
  }
};
