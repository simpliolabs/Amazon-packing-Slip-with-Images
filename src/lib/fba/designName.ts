// designName.ts — Pure per-design LABEL + garment-color helpers (no React, no I/O).
// ──────────────────────────────────────────────────────────────────────────────
// Hoisted out of perDesign.ts so the listingPipeline group loop (the content ANCHOR
// resolution) and the PerDesignCard share ONE garment-color test and ONE designKey→
// label derivation. perDesign.ts re-exports these so its existing callers (#291) are
// unchanged.
//
// WHY this exists: a multi-design apparel family stores each design's name in Amazon's
// Color attribute, which for many products is the literal SHIRT COLOR ("Blue Spruce").
// Anchoring per-design content on the color generates a title ABOUT the shirt color
// instead of the design ("Rude Potato"). isGarmentColor() gates the color out of the
// anchor; deriveDesignLabel() recovers the real design name from the SKU designKey.

// Known garment-color WORDS. Extended beyond the original BASIC_COLOR_RE word set to
// catch the compound colorways Amazon's Color attribute carries ("Blue Spruce",
// "Heather Forest"). Single-word match anchor used by BASIC_COLOR_RE; the multi-token
// compound test in isGarmentColor() reuses the same word list.
// THE BASE list — the 28 words that can only be a garment color in running apparel copy. This is
// the ONE vocabulary the "no color word in shared/broadcast copy" rule (SELLER_PROFILE §5) is
// measured against, at every site: the title candidate/money-keyword filters and the fill guards in
// listingPipeline, the bullet-cohesion dock in syncListingContent, and the terminal title net
// `stripVariantColorWords` (titleBand.ts). It used to exist as three byte-identical literals in
// three files, each carrying a "KEEP IN SYNC" comment — which is how a shared rule drifts
// (INVARIANT 5: one source per rule). Exported below as BASIC_COLOR_WORDS / BASIC_COLOR_WORD_RE.
export const BASIC_COLOR_WORDS: readonly string[] = [
  'black', 'white', 'navy', 'red', 'blue', 'green', 'grey', 'gray', 'pink', 'purple',
  'yellow', 'orange', 'brown', 'tan', 'teal', 'maroon', 'burgundy', 'charcoal', 'ivory',
  'beige', 'olive', 'mint', 'coral', 'lavender', 'mustard', 'rust', 'sage', 'cream',
]

// Compound-colorway extensions (each is a real garment-color token). DELIBERATELY NOT in the base
// list: 'forest' / 'sky' / 'wine' / 'gold' / 'royal' / 'stone' / 'natural' are ordinary DESIGN
// vocabulary ("Forest Bathing", "Big Sky", "Wine Lover"), so they may gate an Amazon Color ATTRIBUTE
// value (isGarmentColor, where every token must be a color) but must never be stripped out of
// running copy.
const COMPOUND_COLOR_WORDS: readonly string[] = [
  'spruce', 'heather', 'forest', 'sky', 'royal', 'kelly', 'sand', 'stone', 'slate',
  'indigo', 'lilac', 'peach', 'gold', 'silver', 'bone', 'natural', 'ash', 'graphite',
  'denim', 'wine', 'brick', 'clay', 'moss', 'fern', 'aqua', 'turquoise', 'plum',
  'mauve', 'taupe', 'khaki', 'crimson',
]

const COLOR_WORDS = [...BASIC_COLOR_WORDS, ...COMPOUND_COLOR_WORDS]

// Basic single-word garment colors that are USELESS as a per-design label when Amazon's color attr
// is the literal shirt color (the FIFA/soccer families: every child's color attr is 'Black'/'White').
export const BASIC_COLOR_RE = new RegExp(`^(?:${COLOR_WORDS.join('|')})$`, 'i')

/** WORD-BOUNDARY probe for a base garment color inside RUNNING TEXT ("plain black tshirt men").
 *  Non-global (`i` only) so it is stateless and safe to share as a module constant — every caller
 *  uses `.test()`. Callers that need to ENUMERATE matches build their own `gi` regex from
 *  BASIC_COLOR_WORDS per call, because a shared /g/ regex carries `lastIndex` across calls. */
export const BASIC_COLOR_WORD_RE = new RegExp(`\\b(?:${BASIC_COLOR_WORDS.join('|')})\\b`, 'i')

// Per-token garment-color test (the COLOR_WORDS set as a single-token anchor).
const COLOR_WORD_RE = new RegExp(`^(?:${COLOR_WORDS.join('|')})$`, 'i')

/** True when `name` is a GARMENT COLOR — a bare color ("Crimson", "Black") or a compound colorway
 *  whose tokens are ALL color words ("Blue Spruce", "Heather Forest"). A name with ANY non-color
 *  token ("Big Sky", "Pure Gold", "Rolling Stone", "Rude Potato", "Only Fins") is NOT a color, so a
 *  real design is never mistaken for one. We deliberately do NOT use an ends-with-color rule — it
 *  over-fired on real designs ending in a color word (adversarial review). Anchor-gate for content. */
export function isGarmentColor(name: string): boolean {
  const n = (name || '').trim()
  if (!n) return false
  const tokens = n.split(/\s+/).filter(Boolean)
  return tokens.length > 0 && tokens.every((t) => COLOR_WORD_RE.test(t))
}

export function titleCaseToken(tok: string): string {
  return tok.split(/[-_]+/).filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ').trim()
}

/** Longest common prefix across the family's designKeys, SNAPPED back to the last '-'/'_' so we
 *  never cut mid-word (SOCCER-CUP-TS-ARGENTINA/AUSTRALIA share '...TS-A' -> snap to 'SOCCER-CUP-TS-'
 *  so we get 'Argentina'/'Australia', not 'Rgentina'/'Ustralia'). '' if nothing reaches a separator. */
export function commonDesignPrefix(keys: string[]): string {
  if (keys.length < 2) return ''
  let p = keys[0]
  for (const k of keys.slice(1)) {
    let i = 0
    while (i < p.length && i < k.length && p[i] === k[i]) i++
    p = p.slice(0, i)
    if (!p) break
  }
  const lastSep = Math.max(p.lastIndexOf('-'), p.lastIndexOf('_'))
  return lastSep >= 0 ? p.slice(0, lastSep + 1) : ''
}

/** Readable label for ONE designKey given the FULL set of family keys. Deterministic, no I/O. */
export function deriveDesignLabel(designKey: string, allKeysInFamily: string[]): string {
  const key = (designKey || '').trim()
  if (!key) return ''
  const prefix = commonDesignPrefix(allKeysInFamily)
  let remainder = (prefix && key.startsWith(prefix)) ? key.slice(prefix.length) : key
  if (!remainder) remainder = key // prefix == whole key (degenerate) -> keep key
  return titleCaseToken(remainder) || titleCaseToken(key)
}
