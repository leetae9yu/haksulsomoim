import type { ChangeEvent } from "react";
import type { EvidenceAnalyzeResponse } from "../../../contracts/desktop-api";
import { MAX_CONFIRMED_TEXT } from "../renderer-state";

interface EvidencePanelProps {
  readonly evidence: EvidenceAnalyzeResponse | undefined;
  readonly fileName: string;
  readonly busy: boolean;
  readonly confirmBusy: boolean;
  readonly error: string;
  readonly manualText: string;
  readonly onFile: (file: File | undefined) => void;
  readonly onManualText: (value: string) => void;
  readonly onConfirm: (value: string) => void;
}

function confidence(value: number): number {
  return Math.round(Math.min(100, Math.max(0, value)));
}

export function EvidencePanel({
  evidence,
  fileName,
  busy,
  confirmBusy,
  error,
  manualText,
  onFile,
  onManualText,
  onConfirm,
}: EvidencePanelProps) {
  function selectFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    onFile(file);
  }

  return (
    <section className="evidence-card reveal" aria-labelledby="evidence-title" aria-busy={busy}>
      <div className="section-heading">
        <span className="section-number">02</span>
        <div>
          <h2 id="evidence-title">증빙 캡처 확인</h2>
          <p>은행 이체내역, 대화, 경찰·법원 안내 화면을 PNG·JPG·WebP로 넣으세요.</p>
        </div>
      </div>
      <label aria-disabled={busy} className="upload-zone" htmlFor="evidence-file">
        <strong className="upload-title">{fileName || "증빙 캡처 선택"}</strong>
        <span className="upload-note">
          {busy ? "로컬 OCR 분석 중…" : "원본 파일은 외부로 전송되지 않습니다."}
        </span>
        <input
          accept="image/png,image/jpeg,image/webp"
          aria-label="증빙 캡처"
          disabled={busy}
          id="evidence-file"
          onChange={selectFile}
          type="file"
        />
      </label>

      {error.length > 0 && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}

      {evidence?.status === "candidates" && (
        <div className="ocr-result reveal">
          <span className="result-label">
            로컬 OCR 후보 · 신뢰도 {confidence(evidence.confidence)}%
          </span>
          <p>{evidence.text}</p>
          <button
            disabled={confirmBusy || evidence.text.trim().length === 0}
            onClick={() => onConfirm(evidence.text)}
            type="button"
          >
            추출 내용 확인
          </button>
        </div>
      )}

      {evidence?.status === "unreadable" && (
        <div className="ocr-result unreadable reveal">
          <span className="result-label">수동 확인 필요</span>
          <p>캡처에서 문자를 읽지 못했습니다.</p>
          <label htmlFor="manual-evidence">직접 확인한 캡처 내용</label>
          <textarea
            id="manual-evidence"
            maxLength={MAX_CONFIRMED_TEXT}
            onChange={(event) => onManualText(event.target.value)}
            value={manualText}
          />
          <button
            disabled={confirmBusy || manualText.trim().length === 0}
            onClick={() => onConfirm(manualText)}
            type="button"
          >
            수동 내용 확인
          </button>
        </div>
      )}
    </section>
  );
}
