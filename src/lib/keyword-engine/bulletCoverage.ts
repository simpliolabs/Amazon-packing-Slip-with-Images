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

/** Significant tokens of a string: lowercase, strip punctuation, drop 1-char tokens + stopwords. */
export const bulletTokens = (s: string): string[] =>
  (s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((t) => t.length > 1 && !BKW_STOP.has(t))

/** Keywords from `oppKw` whose significant tokens are NOT all present across the joined bullets. */
export function missingBulletKeywords(bullets: string[], oppKw: string[]): string[] {
  const have = new Set(bulletTokens(bullets.join(' ')))
  return oppKw.filter((k) => {
    const t = bulletTokens(k)
    return t.length === 0 || !t.every((x) => have.has(x))
  })
}
