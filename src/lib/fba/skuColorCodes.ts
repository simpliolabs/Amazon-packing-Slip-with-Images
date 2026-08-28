/**
 * SKU color-code decoding — SINGLE source of truth (2026-07-09).
 *
 * Extracted verbatim from the three identical copies in PackingSlipDocument.tsx /
 * PackingSlipModal.tsx / bulkPrintHTML.ts (verified byte-identical, 151 entries, before
 * extraction). Also consumed by the listing-optimizer pipeline's extractColor: the old
 * inline version only stripped a trailing "-FBA", so on an all-FBM family EVERY child
 * returned the literal segment "FBM" as its color — 13 real colors collapsed into one,
 * the color-tail LLM was asked for shade synonyms of a fulfillment channel, and all 91
 * children shipped an identical hallucinated "burgundy maroon wine" tail (B0FRYMM56C,
 * PO-caught 2026-07-09).
 */

export const SKU_COLOR_CODES: Record<string, string> = {
  WH: 'White', WHT: 'White', WT: 'White',
  BK: 'Black', BLK: 'Black',
  NV: 'Navy', NVY: 'Navy',
  RD: 'Red',
  BL: 'Blue', BLU: 'Blue',
  GR: 'Green', GRN: 'Green',
  GY: 'Gray', GRY: 'Gray', GREY: 'Grey',
  PK: 'Pink', PNK: 'Pink',
  PU: 'Purple', PUR: 'Purple',
  OR: 'Orange', ORG: 'Orange',
  YL: 'Yellow', YLW: 'Yellow',
  BR: 'Brown', BRN: 'Brown',
  TL: 'Teal',
  CR: 'Coral',
  MN: 'Maroon', MRN: 'Maroon',
  BG: 'Burgundy',
  RS: 'Rust',
  MOS: 'Moss',
  OLV: 'Olive', OL: 'Olive',
  PPR: 'Pepper',
  SND: 'Sandstone',
  GRN8: 'Granite', GRNT: 'Granite',
  ESP: 'Espresso',
  SFM: 'Seafoam',
  BTR: 'Butter',
  SAG: 'Sage',
  IVY: 'Ivory', IV: 'Ivory',
  CRM: 'Cream',
  KHK: 'Khaki', KH: 'Khaki',
  LAV: 'Lavender',
  PCH: 'Peach',
  AQ: 'Aqua',
  GLD: 'Gold',
  TAN: 'Tan',
  SMK: 'Smoke',
  MID: 'Midnight',
  VIN: 'Vineyard',
  HMP: 'Hemp',
  YAM: 'Yam',
  LAG: 'Lagoon',
  BLS: 'Blue Spruce',
  BLO: 'Blossom',
  BRY: 'Berry',
  CIT: 'Citrus',
  CRI: 'Crimson',
  GPH: 'Graphite',
  SPH: 'Sapphire',
  TRC: 'Terracotta',
  WTR: 'Watermelon',
  BJN: 'Blue Jean',

  FBL: 'Flo Blue',
  ICB: 'Ice Blue',
  MG: 'Military Green', MILG: 'Military Green',
  IRF: 'Island Reef',
  ORC: 'Orchid',
  PRW: 'Periwinkle',
  PBK: 'Pigment Black',
  CSK: 'Coral Silk',
  CMT: 'Chalky Mint',
  CRB: 'Crunchberry',
  BSL: 'Bright Salmon',
  BOR: 'Burnt Orange',
  CPK: 'Candy Pink',
  CHL: 'Chili',
  FDB: 'Faded Blue',
  OGD: 'Old Gold',
  ROR: 'Red Orange',
  BAY: 'Bay',
  BLJN: 'Blue Jean',
  MUS: 'Mustard', MSTD: 'Mustard',
  IVO: 'Ivory',
  VIO: 'Violet',
  VOLT: 'Volt',
  LTG: 'Light Green',
  LTGN: 'Light Green',
  LG: 'Light Green',
  SC: 'Soft Cream',
  SA: 'Sand',
  CHM: 'Chambray',
  BJ: 'Blue Jean',

  // Additional short codes found in live orders
  CS: 'Coral Silk',
  WTM: 'Watermelon', WTML: 'Watermelon',
  TQ: 'Turquoise',
  BLJ: 'Blue Jean',
  DN: 'Denim', DENM: 'Denim',
  LIL: 'Lilac', LI: 'Lilac',
  PP: 'Pepper', PEP: 'Pepper',
  SH: 'Sapphire',
  TP: 'Team Purple',
  // Comfort Colors / Gildan codes found in live orders
  ASH: 'Ash',
  ESPR: 'Espresso',
  BLSM: 'Blossom',
  BLSP: 'Blue Spruce',
  MOSS: 'Moss',
  WML: 'Watermelon',
  MV: 'Mauve',
  CO: 'Coral',
  HE: 'Heather',
  ATH: 'Athletic Heather',
  HGY: 'Heather Grey',
  HNV: 'Heather Navy',
  HBL: 'Heather Blue',
  HRD: 'Heather Red',
  HGR: 'Heather Green',
  HOR: 'Heather Orange',
  HPP: 'Heather Purple',
  HTL: 'Heather Teal',
  HMR: 'Heather Maroon',
  HCH: 'Heather Charcoal',
  CHR: 'Charcoal', CHAR: 'Charcoal',
  SLT: 'Slate', SL: 'Slate',
  STN: 'Stone',
  DKH: 'Dark Heather',
  SPR: 'Spring',
  LMN: 'Lemon',
  LIM: 'Lime',
  SKY: 'Sky Blue',
  CYN: 'Cyan',
  MGT: 'Magenta',
  PLS: 'Plum',
  PLM: 'Plum',
  FRS: 'Forest',
  FOR: 'Forest Green',
  HUN: 'Hunter Green',
  OLG: 'Olive Green',
}

// Same size-token shape pushFields.stripVariantSuffix uses — for the title-segment fallback.
const SIZE_TOKEN_RE = "(?:XS|S|M|L|XL|XXL|XXXL|[2-5]XL|[2-6]X-?Large|X-?Small|XX?X?-?Large|Small|Medium|Large|One[ -]?Size)"

/**
 * Decode a child SKU's color NAME. Strips trailing fulfillment-channel suffixes (FBA and FBM —
 * the FBM miss was the collapse), decodes the last segment via SKU_COLOR_CODES, and falls back
 * to the child's OWN title's trailing " - Color - Size" segment. Returns null when no color can
 * be determined — callers must treat null as "unknown", never as a shared bucket.
 *
 * NOT the entry point for resolving a variant's colour (2026-08-28, migration 072). This function
 * is TEXT PARSING — it can never read a colour Amazon never wrote into the SKU/title, and an
 * Amazon-generated opaque SKU (B0DP5H8QBT-class: "1V-C6WM-US5T") has no colour-bearing segment for
 * it to find, no matter how many more heuristics are added here. Every caller resolving a VARIANT's
 * colour must go through resolveChildColor (childColorResolver.ts), which reads Amazon's own stored
 * catalog colour FIRST and calls this function only as the fallback. This function's own logic is
 * intentionally left untouched by that change — it stays exactly what it was.
 */
export function decodeSkuColor(sku: string, title?: string | null): string | null {
  const parts = sku.toUpperCase().split('-').filter(Boolean)
  while (parts.length > 1 && (parts[parts.length - 1] === 'FBA' || parts[parts.length - 1] === 'FBM')) parts.pop()
  // The LAST segment is the canonical color position (AQS-TMB-{SIZE}-{COLOR}) — prefer it.
  const code = parts[parts.length - 1] ?? ''
  if (SKU_COLOR_CODES[code]) return SKU_COLOR_CODES[code]
  // Some SKUs carry the color in a MIDDLE segment: {STYLE+SIZE}-{COLOR}-{DESIGN…} (live 2026-07-15,
  // B0H7L6KNNX: "64000M-WH-Spain-World-Champ" → the color WH sits at index 1, not last, so the last-segment
  // read returned "CHAMP" → null → EVERY child decoded to no-color → the per-color backend collapsed to one
  // string and the degradation gate then preserved stale keywords forever. Scan all segments, but accept
  // ONLY when exactly ONE distinct color is present, so a design word that happens to be a code (Sky, Sage,
  // Bay, Tan) can never be mis-read as the variant color — ambiguity falls through to the title/None path.
  const scanned = [...new Set(parts.map((p) => SKU_COLOR_CODES[p]).filter(Boolean))]
  if (scanned.length === 1) return scanned[0]
  const m = (title ?? '').match(new RegExp(`[-–—|]\\s*([A-Za-z0-9][\\w /&'-]*?)\\s*[-–—|]\\s*${SIZE_TOKEN_RE}\\s*$`, 'i'))
  if (m?.[1]?.trim()) return m[1].trim()
  return null
}
