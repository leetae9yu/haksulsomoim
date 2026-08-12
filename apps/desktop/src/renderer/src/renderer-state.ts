import type { EvidenceAnalyzeRequest, WorkflowSnapshot } from "../../contracts/desktop-api";

export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_CONFIRMED_TEXT = 4096;

const supportedMimeTypes = new Set<EvidenceAnalyzeRequest["mimeType"]>([
  "image/png",
  "image/jpeg",
  "image/webp",
]);

export const messages = Object.freeze({
  invalidAmount: "피해금은 1원 이상 3,000만 원 이하의 숫자로 입력해 주세요.",
  caseFailed: "사건을 시작하지 못했습니다. 입력을 확인하고 다시 시도해 주세요.",
  outOfScope: "현재는 국내 계좌이체 피해금 3,000만 원 이하 사건만 지원합니다.",
  invalidMime: "PNG, JPG, WebP 이미지 파일만 선택할 수 있습니다. 다른 파일로 다시 시도해 주세요.",
  invalidSize: "1바이트 이상 20MB 이하의 이미지 파일을 선택해 주세요.",
  ocrFailed: "이미지를 읽지 못했습니다. 파일을 다시 선택하거나 다른 캡처로 시도해 주세요.",
  factTooLong: "확인 내용은 4,096자 이하로 정리해 주세요.",
  confirmationUnavailable: "현재 OCR 확인 기능을 사용할 수 없습니다. 잠시 후 다시 시도해 주세요.",
  confirmationFailed: "확인 내용을 저장하지 못했습니다. 내용을 검토한 뒤 다시 시도해 주세요.",
  transitionUnavailable:
    "현재 단계에서는 이 작업을 진행할 수 없습니다. 앞 단계를 먼저 확인해 주세요.",
  transitionFailed: "절차 상태를 저장하지 못했습니다. 잠시 후 다시 시도해 주세요.",
  enforcementUnavailable:
    "집행 선택지를 불러올 수 없습니다. 확정 상태를 확인하고 다시 시도해 주세요.",
  guidanceUnavailable: "공식 근거 조회를 사용할 수 없어 수동 확인이 필요합니다.",
  guidanceFailed: "공식 근거를 불러오지 못했습니다. 공식 사이트에서 직접 확인해 주세요.",
  officialSourceFailed: "공식 원문을 열지 못했습니다. 링크 주소를 확인해 주세요.",
  providerManual: "Codex 연결을 사용할 수 없어 이 단계는 수동 작성 모드로 유지됩니다.",
  providerFailed: "Codex 연결 상태를 확인하지 못했습니다. 수동으로 작성해 주세요.",
  loginFailed: "로그인을 시작하지 못했습니다. 연결 상태를 확인하고 다시 시도해 주세요.",
  suggestionFailed: "제안을 만들지 못했습니다. 승인 범위를 확인하고 다시 시도해 주세요.",
});

export type EvidenceMime = EvidenceAnalyzeRequest["mimeType"];

export function isSupportedMime(value: string): value is EvidenceMime {
  return supportedMimeTypes.has(value as EvidenceMime);
}

export function validateEvidenceFile(file: File): string | undefined {
  if (!isSupportedMime(file.type)) return messages.invalidMime;
  if (file.size < 1 || file.size > MAX_FILE_BYTES) return messages.invalidSize;
  return undefined;
}

export function workflowStep(
  workflow: WorkflowSnapshot | undefined,
  hasEvidence: boolean,
  hasConfirmation: boolean,
): number {
  if (hasConfirmation && workflow?.civilState === "enforceable-title-confirmed") return 3;
  if (hasConfirmation) return 2;
  if (hasEvidence) return 1;
  return 0;
}

export function safeHost(value: string): string {
  try {
    return new URL(value).hostname;
  } catch {
    return "공식 출처";
  }
}

export function boundedMetadata(value: string): string {
  return value.slice(0, 48);
}
