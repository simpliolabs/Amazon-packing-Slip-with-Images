/**
 * GET /api/fba/product-image?asin=...
 *
 * ORIGINAL PURPOSE: best-effort fetch of a product's main image from the Amazon Catalog Items API,
 * used when `listing_seo_scores.image_url` wasn't captured during sync. Returns the largest
 * available image link, or `{ image_url: null }` on any failure (the caller falls back to a
 * placeholder).
 *
 * PERSISTENCE (added 2026-08-18). Measured today: 78 of 78 apparel parents scored have
 * `image_url` NULL in both `listing_seo_scores` and `catalog_products` — an ingestion gap that
 * silently disables the vision scanner (`src/lib/keyword-engine/visionScanner.ts:150-175`),
 * because the scanner is DB-only and has nothing to read. Every browser view of a listing
 * already calls this route (`page.tsx:839`), so persisting the URL as a best-effort side effect
 * closes the gap for every listing the seller opens without requiring a backfill sweep.
 *
 * CREDIT-SAFE. Amazon SP-API is rate-limited but NOT credit-metered like Jungle Scout. Populating
 * `image_url` alone does NOT arm a billable re-harvest — the fingerprint chain
 * (`ai-recommendations/route.ts:557`) only trips on `visionSig` changes, and vision only fires
 * on regen. Even THEN the same-session change refactors the fingerprint check so a first-time
 * `visionSig` population does not force JS refresh; see the [KW_FINGERPRINT_STAMP] log there.
 */
import { NextRequest, NextResponse } from 'next/server'
import { getAccessToken } from '@/lib/amazon/auth'
import { createAdminClient } from '@/lib/supabase/server'

const ENDPOINT = process.env.AMAZON_ENDPOINT || 'https://sellingpartnerapi-na.amazon.com'
const MARKETPLACE_ID = process.env.AMAZON_MARKETPLACE_ID || 'ATVPDKIKX0DER'

export async function GET(req: NextRequest) {
  const asin = new URL(req.url).searchParams.get('asin')
  if (!asin) return NextResponse.json({ error: 'asin is required' }, { status: 400 })
  try {
    const token = await getAccessToken()
    const url =
      `${ENDPOINT}/catalog/2022-04-01/items/${encodeURIComponent(asin)}` +
      `?marketplaceIds=${MARKETPLACE_ID}&includedData=images`
    const resp = await fetch(url, { headers: { 'x-amz-access-token': token } })
    if (!resp.ok) return NextResponse.json({ image_url: null })
    const json = (await resp.json()) as {
      images?: { images?: { link: string; height: number; width: number }[] }[]
    }
    const imgs = json.images?.[0]?.images ?? []
    const best = [...imgs].sort((a, b) => b.height * b.width - a.height * a.width)[0]
    const link = best?.link ?? null

    // BEST-EFFORT PERSIST — never affects the browser response. Two guards keep this narrow:
    //   1. `.is('image_url', null)` — only fills a NULL slot; a manually-set or previously-persisted
    //      value is never overwritten (so a real image never regresses to whatever Amazon returns
    //      today, and a re-fetch is idempotent).
    //   2. Fail silent — if createAdminClient or the update throws (e.g. cookies() call in a
    //      streaming context, see [[cookies-scoped-client-in-streams]]), the route still returns
    //      the URL to the browser. The persist is opportunistic, not load-bearing.
    if (link) {
      try {
        const supabase = await createAdminClient()
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const db = supabase as any
        // The passed asin can be a CHILD or a parent. `listing_seo_scores` is keyed by
        // `parent_asin` only, so resolve to the family before the update; when the asin isn't
        // in listing_content (unscored stub, orphan), fall back to using it as the parent.
        const { data: lc } = await db.from('listing_content')
          .select('parent_asin').eq('asin', asin).maybeSingle()
        const parentAsin: string = (lc?.parent_asin as string | undefined) || asin
        await db.from('listing_seo_scores')
          .update({ image_url: link })
          .eq('parent_asin', parentAsin)
          .is('image_url', null)
      } catch {
        // Silent — see comment above. The browser fetch is the primary contract.
      }
    }

    return NextResponse.json({ image_url: link })
  } catch {
    return NextResponse.json({ image_url: null })
  }
}
