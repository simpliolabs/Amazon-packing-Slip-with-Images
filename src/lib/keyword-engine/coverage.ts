/**
 * Shared TOKEN-based keyword coverage — single source of truth.
 * ─────────────────────────────────────────────────────────────────────────────
 * Extracted verbatim from the scorer (syncListingContent.ts) so the scorer AND the rank analysis
 * judge "does the listing cover this keyword?" identically. Amazon ranks a listing for a query when
 * the copy contains the query's WORDS, not the verbatim phrase — so a keyword counts as COVERED when
 * every significant token (minus stopwords) appears somewhere in the haystack. (The old exact-substring
 * check is why a genuinely keyword-rich title never scored well: no realistic title contains a
 * long-tail phrase like "sd card for camera 64gb" verbatim.)
 */
export const KW_STOP = new Set(['for', 'the', 'a', 'an', 'and', 'with', 'of', 'to', 'in', 'on', 'your', 'you', 'that', 'this', '&'])

// Apostrophe-deletion bridge (2026-07-08): matches the backend generator's normalization
// ("valentine's" → "valentines") — symmetric on both haystack and keyword, so drop-in safe.
export const kwToks = (s: string): string[] =>
  (s || '').toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((t) => t && !KW_STOP.has(t))

/** Build a coverage checker bound to a haystack (the listing family's concatenated live copy).
 *  Returns true when every significant token of the keyword appears in the haystack. */
export function makeCoverageChecker(haystack: string): (kw: string) => boolean {
  const haystackTokens = new Set(kwToks(haystack))
  return (kw: string): boolean => {
    const t = kwToks(kw)
    return t.length > 0 && t.every((x) => haystackTokens.has(x))
  }
}
