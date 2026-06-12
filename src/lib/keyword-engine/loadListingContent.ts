/**
 * loadListingContentForPresence — fetch the content row the presence check should run against.
 * ─────────────────────────────────────────────────────────────────────────────
 * ROOT-CAUSE FIX (B0FK8NM9RT, 2026-06-12): listing_content has MULTIPLE rows per ASIN —
 * the FBA SKU and its FBM twin both resolve to the same ASIN. Every caller did
 * `.eq('asin', asin).single()`, and PostgREST's .single() ERRORS when 2+ rows match,
 * so `listing` came back null and the engine ran checkPresence against {} — flagging
 * EVERY keyword "nowhere" while the live title literally contained the phrases
 * ("THE CEO I Could Be Meaner Tshirt Comfort Colors Graphic Tee for Men & Women").
 *
 * Fix: fetch ALL rows for the ASIN and use the most-populated one (twins share title /
 * bullets / description; backend occasionally differs — the fullest row is the honest
 * representative, mirroring representativeContent in the scorer).
 */

import type { ListingContent } from './checkPresence'

export async function loadListingContentForPresence(
  // Accepts any supabase client (admin server client or service client) — the generated
  // types don't constrain this read.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  asin: string,
): Promise<ListingContent | null> {
  const { data } = await supabase
    .from('listing_content')
    .select('title, bullet_1, bullet_2, bullet_3, bullet_4, bullet_5, description, backend_keywords')
    .eq('asin', asin)
    .limit(10)
  const rows = (data ?? []) as ListingContent[]
  if (rows.length === 0) return null
  const weight = (r: ListingContent) =>
    [r.title, r.bullet_1, r.bullet_2, r.bullet_3, r.bullet_4, r.bullet_5, r.description, r.backend_keywords]
      .reduce((n, s) => n + (s?.length ?? 0), 0)
  return rows.reduce((best, r) => (weight(r) > weight(best) ? r : best), rows[0])
}
