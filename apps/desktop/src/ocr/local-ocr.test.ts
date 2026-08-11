import { type LocalOcrRecognizer, TesseractJsLocalOcrAdapter } from "./local-ocr";

type TestBody = () => void | Promise<void>;

declare const describe: (name: string, body: TestBody) => void;
declare const test: (name: string, body: TestBody) => void;
declare const expect: (actual: unknown) => {
  toBe(expected: unknown): void;
  toEqual(expected: unknown): void;
  toThrow(expected?: string): void;
};

const IMAGE = new Uint8Array([137, 80, 78, 71]);

describe("TesseractJsLocalOcrAdapter", () => {
  test("returns only unconfirmed readable candidates with confidence and bounding boxes", async () => {
    const recognizer: LocalOcrRecognizer = {
      recognize: async () => [
        {
          text: "학술 모임",
          confidence: 93.5,
          boundingBox: { x: 12, y: 24, width: 120, height: 30 },
        },
        {
          text: "Research Group",
          confidence: 88,
          boundingBox: { x: 12, y: 60, width: 180, height: 28 },
        },
      ],
      terminate: async () => undefined,
    };
    const ocr = new TesseractJsLocalOcrAdapter(recognizer);

    const result = await ocr.recognize(IMAGE);

    expect(result).toEqual({
      status: "readable",
      candidates: [
        {
          text: "학술 모임",
          confidence: 93.5,
          boundingBox: { x: 12, y: 24, width: 120, height: 30 },
          confirmation: "unconfirmed",
        },
        {
          text: "Research Group",
          confidence: 88,
          boundingBox: { x: 12, y: 60, width: 180, height: 28 },
          confirmation: "unconfirmed",
        },
      ],
      needsManualConfirmation: true,
    });
  });

  test("returns a typed unreadable result for empty bytes without invoking OCR", async () => {
    let recognitionCalls = 0;
    const recognizer: LocalOcrRecognizer = {
      recognize: async () => {
        recognitionCalls += 1;
        return [];
      },
      terminate: async () => undefined,
    };
    const ocr = new TesseractJsLocalOcrAdapter(recognizer);

    const result = await ocr.recognize(new Uint8Array());

    expect(result).toEqual({
      status: "unreadable",
      reason: "empty-input",
      candidates: [],
      needsManualConfirmation: true,
    });
    expect(recognitionCalls).toBe(0);
  });

  test("does not invent facts when OCR yields blank or invalid candidates", async () => {
    const recognizer: LocalOcrRecognizer = {
      recognize: async () => [
        {
          text: "   ",
          confidence: 99,
          boundingBox: { x: 0, y: 0, width: 20, height: 10 },
        },
        {
          text: "phantom",
          confidence: Number.NaN,
          boundingBox: { x: 0, y: 0, width: 20, height: 10 },
        },
      ],
      terminate: async () => undefined,
    };
    const ocr = new TesseractJsLocalOcrAdapter(recognizer);

    const result = await ocr.recognize(IMAGE);

    expect(result).toEqual({
      status: "unreadable",
      reason: "no-text-detected",
      candidates: [],
      needsManualConfirmation: true,
    });
  });

  test("turns recognition failure into an unreadable result without guessed candidates", async () => {
    const recognizer: LocalOcrRecognizer = {
      recognize: async () => {
        throw new Error("cannot decode image");
      },
      terminate: async () => undefined,
    };
    const ocr = new TesseractJsLocalOcrAdapter(recognizer);

    const result = await ocr.recognize(IMAGE);

    expect(result).toEqual({
      status: "unreadable",
      reason: "recognition-failed",
      candidates: [],
      needsManualConfirmation: true,
    });
  });

  test("queues recognition jobs and explicitly terminates after pending work", async () => {
    let activeJobs = 0;
    let maxActiveJobs = 0;
    let releaseFirst: (() => void) | undefined;
    let signalFirstStarted: (() => void) | undefined;
    const firstStarted = new Promise<void>((resolve) => {
      signalFirstStarted = resolve;
    });
    const firstCanFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const events: string[] = [];
    let call = 0;
    const recognizer: LocalOcrRecognizer = {
      recognize: async () => {
        call += 1;
        const currentCall = call;
        activeJobs += 1;
        maxActiveJobs = Math.max(maxActiveJobs, activeJobs);
        events.push(`start-${currentCall}`);
        if (currentCall === 1) {
          signalFirstStarted?.();
          await firstCanFinish;
        }
        events.push(`end-${currentCall}`);
        activeJobs -= 1;
        return [
          {
            text: `candidate-${currentCall}`,
            confidence: 90,
            boundingBox: { x: 0, y: 0, width: 10, height: 10 },
          },
        ];
      },
      terminate: async () => {
        events.push("terminate");
      },
    };
    const ocr = new TesseractJsLocalOcrAdapter(recognizer);

    const first = ocr.recognize(IMAGE);
    await firstStarted;
    const second = ocr.recognize(IMAGE);
    const terminated = ocr.terminate();
    releaseFirst?.();

    await Promise.all([first, second, terminated]);

    expect(maxActiveJobs).toBe(1);
    expect(events).toEqual(["start-1", "end-1", "start-2", "end-2", "terminate"]);
    expect(() => ocr.recognize(IMAGE)).toThrow("OCR adapter is terminated");
  });
});
