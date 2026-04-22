# Architecture Plan — Packing Slip 4-Bug Fix

## 1. Component Inventory

| # | Component | Type | Path | Purpose | New/Modified |
|---|-----------|------|------|---------|-------------|
| 1 | PackingSlipModal | React Component | `src/components/pdf/PackingSlipModal.tsx` | Single-order preview + print | Modified |
| 2 | PackingSlipDocument | React-PDF Component | `src/lib/pdf/PackingSlipDocument.tsx` | PDF generation (react-pdf) | Modified |
| 3 | bulkPrintHTML | Module | `src/lib/pdf/bulkPrintHTML.ts` | Bulk print HTML generation | Modified |
| 4 | generatePDF | Module | `src/lib/pdf/generatePDF.ts` | PDF download filename | Modified |

## 2. Data Flow

### Issue 1: Size extraction (all 3 rendering files)
```
SKU string (e.g., "BC30012XL-MV-I'm-Retired-TS")
  → parseSkuCodes() splits by "-", checks segments for size/color codes
  → FALLBACK: embedded size regex on first segment
  → BUG: regex /(\d+)(2XL|XL|...)$/ is greedy — \d+ eats "30012" leaving "XL"
  → FIX: match size suffix directly without greedy digit prefix: /(6XL|5XL|4XL|3XL|2XL|XXL|XXXL|XL|XS)$/i
  → parseAttrs() uses SKU result (priority) or title (fallback)
  → Rendered in SIZE column of packing slip
```

### Issue 2: PDF filename
```
User clicks "Packing Slip" → PackingSlipModal opens → User clicks "Print" (browser)
  → handlePrint() creates iframe, calls iframe.contentWindow.print()
  → Browser save dialog uses iframe <title> as filename
  → FIX: set iframe <title> to order ID so browser uses it as filename

User clicks download (if using generatePDF path):
  → link.download = `packing-slip-${order.id}.pdf` ← already has order ID, but prefix is wrong
  → FIX: change to `${order.id}.pdf`
```

### Issue 3 & 4: Print header/footer
```
Browser print adds header (date + URL) and footer (URL + page number) by default
  → These are browser-controlled, not HTML content
  → FIX: Set @page margin to 0, add padding on body instead
  → This eliminates the margin-box space where browsers place headers/footers
```

## 3. Dependency Map

| Component | Depends On | Type | Notes |
|-----------|-----------|------|-------|
| PackingSlipModal | parseSkuCodes, parseAttrs | internal | Size/color extraction |
| PackingSlipDocument | parseSkuCodes, parseProductAttributes | internal | Size/color extraction |
| bulkPrintHTML | parseSkuCodes, parseAttrs | internal | Size/color extraction |
| generatePDF | PackingSlipDocument, @react-pdf/renderer | internal + npm | PDF blob generation |
| handlePrint (in Modal) | iframe + window.print() | browser API | Print dialog |

## 4. Technology Decisions

**Decision:** Fix embedded size regex by matching suffix only (no greedy digit prefix)
**Context:** `(\d+)(2XL|XL)$` is greedy — `\d+` consumes `30012` leaving only `XL` for `BC30012XL`
**Options Considered:**
  - (a) Non-greedy `(\d+?)` — won't help, still ambiguous
  - (b) Remove `\d+` entirely, match `(6XL|5XL|4XL|3XL|2XL|XXL|XXXL|XL|XS)$` — clean, unambiguous
  - (c) Named style prefixes like `BC3001` — too fragile, new styles would break
**Chosen:** Option (b) — match size suffix at end of segment without digit prefix
**Consequences:** Simple, correct for all Bella Canvas / Gildan style numbers. No false positives since size codes are checked at segment end only.

**Decision:** Eliminate print header/footer via `@page { margin: 0 }`
**Context:** Browsers place date/URL in @page margin boxes. Setting margin to 0 removes the space.
**Options Considered:**
  - (a) `@page { margin: 0 }` + body padding — standard approach
  - (b) CSS `@top-center { content: none }` — not supported in all browsers
**Chosen:** Option (a) — universal browser support
**Consequences:** Content padding must be handled by body/container instead of @page margin.

## 5. Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| Size regex change breaks other SKU formats | Low | High | Test with known SKUs: BC3001XL, BC30012XL, 64000XL, TCEO-Later-Gator-LS-L-MOS |
| @page margin:0 clips content | Low | Medium | Add equivalent padding to body element |
| Browser ignores @page margin:0 | Low | Low | Some browsers still show headers; this is a best-effort CSS approach |
