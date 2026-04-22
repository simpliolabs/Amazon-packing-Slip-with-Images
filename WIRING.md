# Wiring Blueprint — Packing Slip 4-Bug Fix

## 1. Internal Function Connections

These are the exact code-level connections that need to change.

### Fix 1: Size Regex (3 files, same pattern)

| File | Function | Line | Current Code | New Code |
|------|----------|------|-------------|----------|
| `PackingSlipModal.tsx` | `parseSkuCodes()` | ~188 | `firstSeg.match(/(\d+)(6XL\|5XL\|4XL\|3XL\|2XL\|XXL\|XXXL\|XL\|XS\|S\|M\|L)$/i)` | `firstSeg.match(/(6XL\|5XL\|4XL\|3XL\|2XL\|XXL\|XXXL\|XL\|XS)$/i)` |
| `PackingSlipDocument.tsx` | `parseSkuCodes()` | ~same | Same greedy regex | Same fix |
| `bulkPrintHTML.ts` | `parseSkuCodes()` | ~same | Same greedy regex | Same fix |

**Why remove `S`, `M`, `L` from embedded regex:** These single-letter codes would false-match on any segment ending in S/M/L (e.g., style codes). They're already caught by the exact-match `SKU_SIZE_CODES` check earlier in the function. The embedded suffix check should only handle multi-character compound sizes like `2XL`, `3XL`, etc.

### Fix 2: PDF Filename

| File | Function | Line | Current Code | New Code |
|------|----------|------|-------------|----------|
| `generatePDF.ts` | `generateSinglePDF()` | ~111 | `link.download = \`packing-slip-${order.id}.pdf\`` | `link.download = \`${order.id}.pdf\`` |

### Fix 3: Print Filename (iframe title)

| File | Function | Line | Current Code | New Code |
|------|----------|------|-------------|----------|
| `PackingSlipModal.tsx` | `handlePrint()` | ~361 | `<title> </title>` | `<title>${orderId}</title>` |
| `bulkPrintHTML.ts` | print function | ~508 | `<title> </title>` | `<title>packing-slips</title>` |

### Fix 4: Print Header/Footer Removal

| File | Function | Current `@page` | New `@page` |
|------|----------|----------------|-------------|
| `PackingSlipModal.tsx` | `handlePrint()` | `@page { size: letter portrait; margin: 0.5in; }` | `@page { size: letter portrait; margin: 0; }` + `body { padding: 0.4in; }` |
| `bulkPrintHTML.ts` | print function | `@page { size: letter portrait; margin: 0.4in; margin-top: 0.3in; margin-bottom: 0.3in; }` | `@page { size: letter portrait; margin: 0; }` + `.slip-page { padding: 0.4in; }` |

## 2. No API/Database/External Service Changes

These are all client-side rendering fixes. No backend routes, database queries, or external services are affected.

## 3. Environment Variables

No new environment variables needed.

## 4. Test Matrix

| SKU Input | Expected Size | Validates |
|-----------|--------------|-----------|
| `BC30012XL-MV-I'm-Retired-TS` | 2X-Large | Greedy regex fix — `2XL` not eaten by `\d+` |
| `BC3001XL-TP-We-Still-Do-TS` | X-Large | Single `XL` still works |
| `BC3001S-BK-Design-TS` | Small | `S` caught by segment exact match, not embedded regex |
| `BTFFTW64000XL-WH` | X-Large | Gildan-style embedded size still works |
| `TCEO-Later-Gator-LS-L-MOS` | Large | `L` caught by segment exact match |
| `640002XL-WH` | 2X-Large | Numeric prefix + 2XL suffix |
