/**
 * Title idiom expander (PO 2026-07-22). Converts a truncated pun/idiom design tag to the FULL spoken
 * source phrase before the title council writes anything.
 *
 * Precipitating incident: B0GML74MJQ (Later Gator LS Comfort Colors) shipped
 *   "THE CEO Later Gator Comfort Colors Long Sleeve Shirt for Women"
 * (62 chars, generic wall-of-words), when the PO's gold pattern is
 *   "THE CEO See You Later Alligator Shirt | Long Sleeve Comfort Colors Shirt"
 * (72 chars, source phrase expanded). "Later Gator" is a truncation of the everyday farewell
 * "See you later, alligator" — shoppers type BOTH forms, and the source phrase indexes the fuller
 * category ("alligator shirt") for free.
 *
 * The expander runs BEFORE the title council so the council writes with the source phrase as the
 * design identity, not the truncated tag. If the design tag is not in the curated table, we leave it
 * verbatim (safe fallback — legacy behavior).
 *
 * Meta (PO 2026-07-22, "we went through about 100 council training on naming"): this table is a small
 * seed, meant to grow. Any future PO correction that maps <short_tag> → <spoken phrase> extends this
 * list. A future step (task #104-adjacent) may auto-mine such mappings from listing_change_log title
 * edits, but the seed is enough to fix the current class today.
 *
 * Behavior: exact case-insensitive match of the WHOLE trimmed design name (e.g. "Later Gator" or
 * "later gator" → "See You Later Alligator"). No fuzzy match — this is a safety-first module and a
 * wrong expansion changes the shipped title.
 */

/** Curated {truncated_design_tag → full_spoken_source_phrase}. Extend with every PO correction.
 *  Case-insensitive lookup; the value is returned Title-Case verbatim. Keep ~50 chars max — the
 *  expansion has to still fit inside the 75-char title budget with brand + garment + variant. */
const IDIOM_SOURCE_PHRASES: Record<string, string> = {
  // Farewell / going-away class
  'later gator': 'See You Later Alligator',
  'later alligator': 'See You Later Alligator',
  'awhile croc': 'In a While Crocodile',
  'awhile crocodile': 'In a While Crocodile',

  // Encouragement / feel-good
  'over the moon': 'Over the Moon',
  'out of this world': 'Out of This World',
  'to the moon': 'To the Moon and Back',
  'feeling good': 'Feeling Good Today',
  'do not quit': 'Don’t Quit',
  'dont quit': 'Don’t Quit',
  'don’t quit': 'Don’t Quit',
  "don't quit": 'Don’t Quit',

  // Retirement / farewell variants
  'peace out': 'Peace Out',
  'catch you later': 'Catch You Later',
  'ttyl': 'Talk to You Later',
  'brb': 'Be Right Back',

  // Statement / motivational shorthand
  'grind mode': 'In Grind Mode',
  'boss mode': 'In Boss Mode',
  'ceo mode': 'CEO Mode Activated',
  'cashflow': 'Cashflow',
  'i could be meaner': 'I Could Be Meaner',
}

/** Returns the expanded source phrase if the design name matches a curated idiom; else the original
 *  design name unchanged. Case-insensitive; whitespace-trimmed. Never returns empty on a non-empty
 *  input — falls back to the verbatim name. */
export function expandIdiomDesignName(designName: string | null | undefined): string {
  const raw = (designName || '').trim()
  if (!raw) return ''
  const key = raw.toLowerCase().replace(/\s+/g, ' ')
  const hit = IDIOM_SOURCE_PHRASES[key]
  return hit || raw
}

/** True when the design name mapped to a curated idiom (i.e. expansion is a real change, not a pass-through).
 *  The title council can use this signal to decide whether to lean on the source phrase in the title. */
export function isIdiomDesign(designName: string | null | undefined): boolean {
  const raw = (designName || '').trim().toLowerCase().replace(/\s+/g, ' ')
  return raw in IDIOM_SOURCE_PHRASES
}
