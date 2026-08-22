import type { ScreenMaskRegion, ScreenTextRegion } from "../contracts/secure-computer";
import type { RedactionResult } from "./redaction";

interface TextSegment {
  readonly candidate: ScreenTextRegion;
  readonly start: number;
  readonly end: number;
}

interface TextRun {
  readonly text: string;
  readonly segments: readonly TextSegment[];
}

interface SensitiveRegion {
  readonly boundingBox: ScreenMaskRegion["boundingBox"];
  readonly group: string;
  readonly token: string;
}

export interface ScreenRedaction {
  readonly maskedText: readonly string[];
  readonly regions: readonly ScreenMaskRegion[];
}

const verticalCenter = (candidate: ScreenTextRegion): number =>
  candidate.boundingBox.y + candidate.boundingBox.height / 2;

const isSameRow = (left: ScreenTextRegion, right: ScreenTextRegion): boolean => {
  const minimumHeight = Math.min(left.boundingBox.height, right.boundingBox.height);
  return Math.abs(verticalCenter(left) - verticalCenter(right)) <= Math.max(4, minimumHeight / 2);
};

const groupRows = (
  candidates: readonly ScreenTextRegion[],
): readonly (readonly ScreenTextRegion[])[] => {
  const rows: ScreenTextRegion[][] = [];
  const topToBottom = [...candidates].sort(
    (left, right) =>
      verticalCenter(left) - verticalCenter(right) || left.boundingBox.x - right.boundingBox.x,
  );
  for (const candidate of topToBottom) {
    const row = rows.find((current) => current.some((existing) => isSameRow(existing, candidate)));
    if (row === undefined) rows.push([candidate]);
    else row.push(candidate);
  }
  return rows;
};

const buildRun = (candidates: readonly ScreenTextRegion[]): TextRun => {
  let text = "";
  const segments: TextSegment[] = [];
  for (const candidate of candidates) {
    if (text.length > 0) text += " ";
    const start = text.length;
    text += candidate.text;
    segments.push({ candidate, start, end: text.length });
  }
  return { text, segments };
};

const groupRuns = (candidates: readonly ScreenTextRegion[]): readonly TextRun[] => {
  const runs: ScreenTextRegion[][] = [];
  for (const candidate of [...candidates].sort(
    (left, right) => left.boundingBox.x - right.boundingBox.x,
  )) {
    const current = runs.at(-1);
    const previous = current?.at(-1);
    if (current === undefined || previous === undefined) {
      runs.push([candidate]);
      continue;
    }
    const gap = candidate.boundingBox.x - (previous.boundingBox.x + previous.boundingBox.width);
    const maximumGap = Math.max(
      24,
      Math.max(candidate.boundingBox.height, previous.boundingBox.height) * 1.5,
    );
    const sharesContext = candidate.context !== undefined && candidate.context === previous.context;
    if (gap > maximumGap && !sharesContext) runs.push([candidate]);
    else current.push(candidate);
  }
  return runs.map(buildRun);
};

const collectRuns = (candidates: readonly ScreenTextRegion[]): readonly TextRun[] => {
  const contextual = new Map<string, ScreenTextRegion[]>();
  const spatial: ScreenTextRegion[] = [];
  for (const candidate of candidates) {
    if (candidate.context === undefined) {
      spatial.push(candidate);
      continue;
    }
    const group = contextual.get(candidate.context);
    if (group === undefined) contextual.set(candidate.context, [candidate]);
    else group.push(candidate);
  }
  const contextualRuns = [...contextual.values()].map(buildRun);
  const spatialRuns = groupRows(spatial).flatMap(groupRuns);
  return [...contextualRuns, ...spatialRuns];
};

const findOccurrences = (text: string, value: string): readonly number[] => {
  const starts: number[] = [];
  let offset = 0;
  while (offset <= text.length - value.length) {
    const start = text.indexOf(value, offset);
    if (start < 0) break;
    starts.push(start);
    offset = start + value.length;
  }
  return starts;
};

const mapSegmentRegion = (
  segment: TextSegment,
  sensitiveStart: number,
  sensitiveEnd: number,
): ScreenMaskRegion["boundingBox"] | undefined => {
  const overlapStart = Math.max(segment.start, sensitiveStart);
  const overlapEnd = Math.min(segment.end, sensitiveEnd);
  if (overlapStart >= overlapEnd || segment.candidate.text.length === 0) return undefined;
  const localStart = overlapStart - segment.start;
  const localEnd = overlapEnd - segment.start;
  const box = segment.candidate.boundingBox;
  const startRatio = localStart / segment.candidate.text.length;
  const endRatio = localEnd / segment.candidate.text.length;
  const left = Math.max(0, Math.floor(box.x + box.width * startRatio) - 1);
  const top = Math.max(0, Math.floor(box.y) - 1);
  const right = Math.ceil(box.x + box.width * endRatio) + 1;
  const bottom = Math.ceil(box.y + box.height) + 1;
  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
  };
};

const intersectionCoverage = (
  left: SensitiveRegion["boundingBox"],
  right: SensitiveRegion["boundingBox"],
): number => {
  const width = Math.max(
    0,
    Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x),
  );
  const height = Math.max(
    0,
    Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y),
  );
  const smallerArea = Math.min(left.width * left.height, right.width * right.height);
  return smallerArea === 0 ? 0 : (width * height) / smallerArea;
};

const deduplicateRegions = (regions: readonly SensitiveRegion[]): readonly SensitiveRegion[] => {
  const precise: SensitiveRegion[] = [];
  const smallestFirst = [...regions].sort(
    (left, right) =>
      left.boundingBox.width * left.boundingBox.height -
      right.boundingBox.width * right.boundingBox.height,
  );
  for (const region of smallestFirst) {
    if (
      !precise.some(
        (existing) =>
          existing.token === region.token &&
          intersectionCoverage(existing.boundingBox, region.boundingBox) >= 0.8,
      )
    ) {
      precise.push(region);
    }
  }
  return precise;
};

export const redactScreenCandidates = (
  candidates: readonly ScreenTextRegion[],
  redact: (text: string) => RedactionResult,
): ScreenRedaction => {
  const maskedText: string[] = [];
  const sensitiveRegions: SensitiveRegion[] = [];
  let runIndex = 0;
  for (const run of collectRuns(candidates)) {
    const result = redact(run.text);
    maskedText.push(result.text);
    for (const [mappingIndex, mapping] of result.mappings.entries()) {
      for (const start of findOccurrences(run.text, mapping.value)) {
        const end = start + mapping.value.length;
        const group = `${runIndex}:${mappingIndex}:${start}`;
        for (const segment of run.segments) {
          const boundingBox = mapSegmentRegion(segment, start, end);
          if (boundingBox !== undefined) {
            sensitiveRegions.push({ boundingBox, group, token: mapping.token });
          }
        }
      }
    }
    runIndex += 1;
  }
  const labelledGroups = new Set<string>();
  const regions = [...deduplicateRegions(sensitiveRegions)]
    .sort(
      (left, right) =>
        left.boundingBox.y - right.boundingBox.y || left.boundingBox.x - right.boundingBox.x,
    )
    .map(({ boundingBox, group, token }) => {
      const label = labelledGroups.has(group) ? "" : token;
      labelledGroups.add(group);
      return { boundingBox, label };
    });
  return { maskedText, regions };
};
