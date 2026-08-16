import { z } from "zod";

import type { OcrBoundingBox } from "../ocr/local-ocr";

const coordinate = z.number().int().min(0).max(16_384);
const observationDigest = z.string().regex(/^[a-f0-9]{64}$/);
const redactionToken = z
  .string()
  .regex(/^\[(?:RRN|PHONE|ADDRESS|ACCOUNT|CASE|EMAIL|PERSON)_[A-Z2-7]{16}\]$/);

export const secureComputerActionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("click"), x: coordinate, y: coordinate, observationDigest }),
  z.strictObject({
    kind: z.literal("type-text"),
    x: coordinate,
    y: coordinate,
    text: z.string().min(1).max(2_000),
    observationDigest,
  }),
  z.strictObject({
    kind: z.literal("type-token"),
    x: coordinate,
    y: coordinate,
    token: redactionToken,
    observationDigest,
  }),
  z.strictObject({
    kind: z.literal("scroll"),
    deltaX: z.number().int().min(-4_000).max(4_000),
    deltaY: z.number().int().min(-4_000).max(4_000),
    observationDigest,
  }),
]);

export type SecureComputerAction = z.infer<typeof secureComputerActionSchema>;

export interface ScreenTextRegion {
  readonly text: string;
  readonly boundingBox: OcrBoundingBox;
}

export interface ScreenMaskRegion {
  readonly label: string;
  readonly boundingBox: OcrBoundingBox;
}

export interface SecureBrowserInspection {
  readonly url: string;
  readonly width: number;
  readonly height: number;
  readonly candidates: readonly ScreenTextRegion[];
}

export interface SecureBrowserTarget {
  readonly text: string;
  readonly tagName: string;
  readonly role?: string;
  readonly inputType?: string;
  readonly ariaLabel?: string;
}

export interface SecureBrowserPort {
  start(url: string): Promise<void>;
  inspect(): Promise<SecureBrowserInspection>;
  captureMasked(regions: readonly ScreenMaskRegion[]): Promise<Uint8Array>;
  targetAt(x: number, y: number): Promise<SecureBrowserTarget | undefined>;
  click(x: number, y: number): Promise<void>;
  typeText(x: number, y: number, text: string): Promise<void>;
  scroll(deltaX: number, deltaY: number): Promise<void>;
  close(): Promise<void>;
}

export type SecureComputerGateDecision =
  | Readonly<{ outcome: "allowed" }>
  | Readonly<{ outcome: "requires-user"; reason: string }>
  | Readonly<{ outcome: "rejected"; reason: string }>;

export type SecureComputerActionResult =
  | Readonly<{ outcome: "executed"; actionCount: number }>
  | Readonly<{ outcome: "requires-user"; reason: string; actionCount: number }>
  | Readonly<{ outcome: "rejected"; reason: string; actionCount: number }>;

export interface SecureComputerObservation {
  readonly url: string;
  readonly width: number;
  readonly height: number;
  readonly imagePng: Uint8Array;
  readonly maskedText: string;
  readonly observationDigest: string;
}
