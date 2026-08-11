# Apple-Inspired Product Research Design Contract

## 0. Reference log

- Required installation: `npx getdesign@latest add apple` produced `/DESIGN.md`.
- Brand reference: Apple design analysis from getdesign and the bundled `apple.md`.
- Execution reference: premium utilitarian minimalism for editorial hierarchy and restrained chrome.
- Product constraint: borrow layout grammar and tokens only; do not copy Apple logos, product photography, or branded copy.

## 1. Narrative and audience

The report and presentation describe a usable legal-tech product, not a legal memorandum.
The primary audience is an interdisciplinary academic group that needs to understand the user journey,
the concrete product functions, and the legal limits in that order.

The single narrative is:

> 피해 발생 → 정보 1회 입력 → 공식 통지 기반 사건 추적 → 형사·민사 트랙 분기 →
> 증거·서류 준비 → 강제집행 후속 관리

Existing legal, evidence, privacy, and public-system research appears at the point where it validates or
constrains a product function. It does not lead the story.

## 2. Atmosphere

- Product editorial: quiet, exact, low-density, and confident.
- Alternating scene rhythm: white or Apple Gray product explanation, then black decisive chapter.
- One slide or report section makes one claim.
- The user journey is the visual focal object: route lines, official-message mockups, evidence packets,
  track switches, and enforcement status panels.
- No decorative gradients, stock photos, glass cards, neon, or ornamental 3D.

## 3. Tokens

### Color

| Role | Value | Use |
|---|---|---|
| Absolute black | `#000000` | Cover and decisive chapter scenes |
| Apple gray | `#F5F5F7` | Main product scenes and report background bands |
| Canvas | `#FFFFFF` | Cards, report pages, dense utility scenes |
| Ink | `#1D1D1F` | Primary copy |
| Secondary | `#6E6E73` | Supporting copy and qualifications |
| Hairline | `#D2D2D7` | Borders and dividers |
| Action blue | `#0071E3` | The only strong accent |
| Link blue | `#0066CC` | Citations and supporting links |
| Blue on dark | `#2997FF` | Labels on black scenes |

Legal warning states use text labels and line styles first. A restrained red may appear only for a
specific prohibited action; it is not part of the general palette.

### Typography

Korean substitutes for SF Pro:

- Display: `Noto Sans CJK KR`, weight 600.
- Body: `Noto Sans CJK KR`, weight 400.
- Metadata: `Source Code Pro`, weight 400.

Presentation:

| Role | Size | Weight |
|---|---:|---:|
| Cover display | 30–34 pt | 600 |
| Slide display | 24–28 pt | 600 |
| Product statement | 18–22 pt | 400–600 |
| Body | 14–17 pt | 400 |
| Label | 11–13 pt | 600 |
| Source metadata | 9–10 pt | 400 |

Report:

| Role | Size |
|---|---:|
| Cover title | 25–29 pt |
| Section title | 18–21 pt |
| Subsection title | 13–15 pt |
| Body | 9.8–10.5 pt |
| Caption/source | 7.5–8.5 pt |

Korean phrases use `word-break: keep-all`. No one-character orphan lines, detached particles,
or split parenthetical source labels.

## 4. Layout

### Presentation

- 16:9 canvas, 13.333 × 7.5 inches.
- Safe margin: 0.58 inches.
- 12-column conceptual grid.
- A full scene is rectangular and edge-to-edge; do not round the slide canvas.
- Utility cards use 12–18 px-equivalent radii and 1 pt hairlines.
- At least 25% of every slide remains empty.
- A slide contains at most one large diagram or four compact utility modules.

### Report

- A4 portrait with 16–18 mm margins.
- Reading width is narrow; paragraphs do not exceed approximately 42 Korean characters per line.
- Major sections start with a high-whitespace statement band.
- Product-flow diagrams and evidence tables are fixed-width and must not split across pages.
- References use a compact appendix rather than dominating the main narrative.

## 5. Reusable primitives

### Product scene

Large headline, one sentence, one dominant product-flow visual. Variants: light, gray, black.

### Message analyzer

An official-message facsimile on the left and extracted, user-confirmed fields on the right.
It must visually distinguish source text, machine extraction, and human confirmation.

### Route strip

Four numbered stages with a single blue route line:
`접수·추적 → 증거·서류 → 배상명령·별도 민사 준비 → 강제집행`.

### Track switch

Two parallel lanes: `Track A 배상명령` and `Track B 민사`.
The switch represents data reuse and screen routing, never automatic legal conversion.

### Evidence packet

Original files, OCR extraction, user confirmation, and export preview. The original remains visibly
separate from derived output.

### Enforcement status panel

`집행권원 → 재산명시·조회 → 압류·추심 → 미회수·시효관리`.
No step implies guaranteed recovery.

### Boundary spectrum

Three columns: `지원`, `사용자 확인`, `금지`. Color is secondary to direct text labels.

## 6. Copy rules

- Product action precedes legal explanation.
- Prefer `재사용`, `확인`, `안내`, `추적` over broad `자동화`.
- Never claim direct KICS, court, ECRM, or TheCheat API integration.
- Never claim automatic filing, automatic legal transition, fraud determination, victory probability,
  recovery probability, or guaranteed collection.
- `원클릭 전환` means reuse of confirmed data into the next preparation screen.
- The deck contains 15 slides and is paced for 15 minutes.
- Substantive report and slide prose is written by DeepSeek; omo owns structure, evidence constraints,
  design, assembly, and verification.

## 7. Accessibility and accepted debt

- Body contrast meets 4.5:1 and large text meets 3:1.
- Information is not encoded by color alone.
- Minimum presentation body size is 14 pt; minimum visible source size is 9 pt.
- Every rendered report page and all 15 slides require independent design and Korean/CJK review.
- Accepted debt: SF Pro is unavailable on this Linux build, so Noto Sans CJK KR is the metric-safe
  Korean substitute.
