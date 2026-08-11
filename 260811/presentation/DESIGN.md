# 학술소모임 260811 Presentation Design System

## 0. Research Log

- Embedded references: shortlisted Stripe, Notion, IBM → picked Minimalist + Stripe because the topic needs academic restraint, legal credibility, and technical depth without decorative noise.
- Lazyweb: skipped — this is an offline academic deck, not an app or web interaction surface.
- Imagen drafts: skipped — no image-generation tool is available; all visuals will be editable vector diagrams built from the report.
- Typography probe: `Noto Sans CJK KR` and `Source Code Pro` are installed and will be embedded by reference in the PPTX.

## 1. Atmosphere & Identity

The deck should feel like a calm legal-technology briefing: precise, evidence-led, and sober enough for legal claims, but visually clear enough to present in fifteen minutes. The signature is the **evidence thread** — a thin purple route line that repeatedly connects facts, legal gates, product states, and implementation phases. The visual rhythm alternates warm paper-white analysis slides with deep-indigo decisive slides.

Primary audience: interdisciplinary academic study group members with mixed legal, policy, and technical backgrounds.

Presentation mode: 15-minute briefing plus discussion. Sixteen slides total; slide 16 is a reference appendix and may be skipped during the live talk.

## 2. Color

| Role | Token | Value | Usage |
|---|---|---|---|
| Canvas | `paper` | `#F7F6F3` | Main slide background |
| Surface | `white` | `#FFFFFF` | Cards and diagram nodes |
| Heading | `navy` | `#061B31` | Titles and primary text |
| Body | `slate` | `#526274` | Supporting copy |
| Muted | `fog` | `#8A97A5` | Captions and source IDs |
| Border | `line` | `#DCE5EE` | Dividers and cards |
| Primary accent | `violet` | `#533AFD` | Evidence thread, key terms |
| Accent pale | `lavender` | `#E9E7FF` | Selected states |
| Safe | `green` | `#168A52` | Allowed / verified |
| Caution | `amber` | `#A66712` | Conditional / unresolved |
| Prohibited | `ruby` | `#C73555` | Illegal / banned |
| Dark chapter | `indigo` | `#1C1E54` | Section emphasis slides |

Rules:
- Violet marks sequence, evidence, or the single main claim only.
- Green, amber, and ruby are semantic; never decorative.
- No gradients, stock photography, neon, or ornamental 3D objects.
- Charts and diagrams must remain legible when printed in grayscale through shape, label, and ordering—not color alone.

## 3. Typography

| Role | Font | Size | Weight | Usage |
|---|---|---:|---:|---|
| Cover title | Noto Sans CJK KR | 28–32 pt | 700 | Two-line maximum |
| Slide title | Noto Sans CJK KR | 22–26 pt | 700 | One line preferred |
| Key statement | Noto Sans CJK KR | 20–24 pt | 700 | One memorable sentence |
| Body | Noto Sans CJK KR | 14–17 pt | 400 | Maximum three bullets |
| Label | Noto Sans CJK KR | 11–13 pt | 500 | Diagram nodes |
| Metadata | Source Code Pro | 8–10 pt | 400 | Slide number, S-IDs |

Rules:
- Korean particles, endings, and short clauses must not be orphaned.
- No paragraph longer than three visual lines.
- One slide = one claim. A slide that needs more than 55 Korean words of body copy must be reduced.
- English appears only for established technical/legal labels in parentheses.

## 4. Spacing & Layout

- Format: 16:9 widescreen, 13.333 × 7.5 inches.
- Safe margin: 0.55 inches on all edges.
- Grid: 12 columns; 0.18-inch gutters.
- Title zone: top 0.50–1.20 inches.
- Content zone: 1.35–6.75 inches.
- Footer: slide number left, source IDs right.
- Every slide must preserve at least 20% empty space.

Layout families:
1. **Statement** — one large claim + one proof strip.
2. **Split** — 5/7 or 6/6 explanatory comparison.
3. **Route** — horizontal or stepped evidence thread.
4. **Matrix** — three semantic columns, maximum four rows.
5. **Chapter** — deep indigo field with one white statement.

## 5. Reusable Primitives

### Slide Frame
- Structure: title, optional eyebrow, body region, source footer.
- Variants: paper, dark chapter.
- State: static; no animation required.

### Evidence Thread
- Structure: 2.5 pt violet line, numbered nodes, arrow end.
- Variants: horizontal route, stepped route, circular return.
- Labels must sit above or below the line, never across it.

### Evidence Card
- White surface, 1 pt border, 4 px-equivalent corner radius.
- Optional semantic top rule: violet, green, amber, or ruby.
- No shadow except one featured card with a restrained blue-tinted shadow.

### Gate Node
- Rounded rectangle with gate number, short action label, and one outcome.
- Minimum 0.95-inch width and 0.55-inch height.
- The legal process route always proceeds left-to-right.

### Spectrum Column
- Three columns: 허용 / 조건부 / 금지.
- Columns use icon-free text labels plus green / amber / ruby top rules.
- Equal widths and aligned baselines.

### Metric Tile
- Large tabular number, one noun label, one-line qualification.
- Numbers never appear without scope or denominator warning.

## 6. Motion & Interaction

- Static deck by default.
- Build order may use simple appear transitions only if PowerPoint preserves them reliably.
- No decorative motion, morph gimmicks, or animated charts.
- The evidence thread itself provides narrative continuity without animation.

## 7. Depth & Surface

- Strategy: tonal shift plus borders.
- Cards are flat white on paper; hierarchy comes from spacing and top rules.
- One dark chapter slide after each major narrative turn provides cadence.
- No large rounded containers and no default PowerPoint shadows.

## 8. Accessibility Constraints & Accepted Debt

Constraints:
- Minimum body size 14 pt; source metadata minimum 8 pt.
- Body contrast target at least 4.5:1; large text at least 3:1.
- Meaning is never carried by color alone.
- All diagrams must have direct labels and a reading order.
- Every one of the 16 rendered slides must pass independent visual and CJK review.

Accepted debt:
- Speaker notes are optimized for a 15-minute Korean presentation and may require timing adjustment for a materially different event format.

