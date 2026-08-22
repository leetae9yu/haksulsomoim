export interface OcrBoundingBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface OcrCandidate {
  readonly text: string;
  readonly confidence: number;
  readonly boundingBox: OcrBoundingBox;
}

export interface LocalOcrPort {
  recognize(image: Uint8Array): Promise<readonly OcrCandidate[]>;
  dispose(): Promise<void>;
}
