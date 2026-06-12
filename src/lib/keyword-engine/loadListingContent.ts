/**
 * Twin-safe listing_content loaders for keyword presence checks.
 * ─────────────────────────────────────────────────────────────────────────────
 * ROOT-CAUSE (B0FK8NM9RT, 2026-06-12): listing_content has MULTIPLE rows per ASIN —
 * the FBA SKU and its FBM twin both resolve to the same ASIN. Every caller did
 * `.eq('asin', asin).single()`, and PostgREST's .single() ERRORS when 2+ rows match,
 * so `listing` came back null and the engine ran checkPresence against {} — flagging
 * EVERY keyword "nowhere" while the live title literally contained the phrases.
 *
 * Live-verify then caught the v1 "most-populated row" repair picking the FBM twin
 * whose STALE title ("…Comfort Colors Shirt … Blue Spruce") shadowed the FBA row's
 * real title ("…Tshirt Comfort Colors Graphic Tee for Men & Women") — a twin lottery
 * whenever the rows diverge (i.e. until a broadcast push converges them). So presence
 * callers now get ALL rows and OR per row via checkPresenceAny — a keyword present in
 * EITHER twin's field is genuinely in the seller's listing data.
 */

import type { ListingContent } from './checkPresence'

/** ALL of the ASIN's listing_content rows (FBA + FBM twins) — feed to checkPresenceAny /
 *  runKeywordEngine, which OR presence per row (never against concatenated text). */
export async function loadListingRowsForPresence(
  // Accepts any supabase client (admin server client or service client) — the generated
  // types don't constrain this read.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  asin: string,
): Promise<ListingContent[]> {
  const { data } = await supabase
    .from('listing_content')
    .select('title, bullet_1, bullet_2, bullet_3, bullet_4, bullet_5, description, backend_keywords')
    .eq('asin', asin)
    .limit(10)
  return (data ?? []) as ListingContent[]
}

/**
 * ONE representative row for single-value uses (e.g. the research title seed, which must
 * be ONE title, not twins concatenated). Returns the most-populated row.
 */
export async function loadRepresentativeListingRow(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  asin: string,
): Promise<ListingContent | null> {
  const rows = await loadListingRowsForPresence(supabase, asin)
  if (rows.length === 0) return null
  const weight = (r: ListingContent) =>
    [r.title, r.bullet_1, r.bullet_2, r.bullet_3, r.bullet_4, r.bullet_5, r.description, r.backend_keywords]
      .reduce((n, s) => n + (s?.length ?? 0), 0)
  return rows.reduce((best, r) => (weight(r) > weight(best) ? r : best), rows[0])
}
