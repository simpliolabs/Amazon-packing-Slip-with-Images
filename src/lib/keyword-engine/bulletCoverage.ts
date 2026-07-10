/**
 * Shared bullet-coverage predicate — the SINGLE source of truth for "do the bullets cover this keyword?",
 * imported by BOTH the scorer (syncListingContent) and the bullet validator/backstop (listingPipeline), so
 * the generator covers EXACTLY what the scorer penalizes for (the root cause of bullets stuck at 9/18 was
 * three different rulebooks). Pure + dependency-free (no I/O) to avoid any scorer↔pipeline import cycle.
 *
 * Token-based (not exact-substring): every significant token of the keyword must appear somewhere across
 * the joined bullets, so a natural paraphrase counts — "see you later alligator vibe" covers "see you
 * later alligator shirt". Byte-identical to the scorer's previous inline rule (the ONLY home for BKW_STOP).
 */

export const BKW_STOP = new Set([
  'for', 'the', 'a', 'an', 'and', 'with', 'of', 'to', 'in', 'on', 'your', 'you', 'that', 'this',
])

/** Naive plural fold, applied to BOTH sides symmetrically (2026-07-09): Amazon's index stems, and
 *  a listing whose title says "TShirt … Shirt for Women" genuinely ranks for "t shirts for women".
 *  Without this the scorer required the exact plural form and docked listings for keywords they
 *  already cover ("shirt" ≠ "shirts", "tee" ≠ "tees"). Guards: >3 chars, not a double-s ("dress",
 *  "less"), not "…ss"/"…us"/"…is" endings that are not plurals. */
export const foldPlural = (t: string): string =>
  t.length > 3 && t.endsWith('s') && !/(?:ss|us|is)$/.test(t) ? t.slice(0, -1) : t

/** Significant tokens of a string: lowercase, DELETE apostrophes ("he's" → "hes" — matching the
 *  backend generator's normalization, 2026-07-08: space-splitting made the scorer require "he"
 *  while the generator writes "hes", a permanent false -4 dock), strip other punctuation, split
 *  digit-letter pairs ("128gb" → 128, gb — so solid and spaced forms match each other, same
 *  bridge as checkPresence), fold plurals, drop 1-char tokens + stopwords. */
export const bulletTokens = (s: string): string[] =>
  (s || '').toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
    .flatMap((t) => {
      const m = t.match(/^(\d+)([a-z]+)$/) || t.match(/^([a-z]+)(\d+)$/)
      return m ? [m[1], m[2]] : [t]
    })
    .map(foldPlural)
    .filter((t) => t.length > 1 && !BKW_STOP.has(t))

/** Keywords from `oppKw` whose significant tokens are NOT all present across the joined bullets. */
export function missingBulletKeywords(bullets: string[], oppKw: string[]): string[] {
  const have = new Set(bulletTokens(bullets.join(' ')))
  return oppKw.filter((k) => {
    const t = bulletTokens(k)
    return t.length === 0 || !t.every((x) => have.has(x))
  })
}
