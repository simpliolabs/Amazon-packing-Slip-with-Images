/**
 * competitorSeo.ts — Competitor SEO snapshot (title-council fallback chain, Part 1)
 * ─────────────────────────────────────────────────────────────────────────────
 * The seller names their #1 competitor (listing_seo_scores.competitor_asin). This module pulls
 * that competitor's LIVE customer-facing SEO surface (title / bullets / description) from the
 * Catalog Items API so the multi-design parent-title council can study HOW a top-ranking listing
 * in the same niche spends its title budget — keyword strategy + structure ONLY, never their
 * sentences or brand (the brief states constraints, and buildNicheParentTitle carries a
 * deterministic brand-leak net — prompt-leak history #365/#367).
 *
 * Cached 14 days in keyword_cache (asin, source='competitor_seo') — same table/pattern as
 * keywordResearcher.cacheResearch, one row per competitor ASIN. FAIL-OPEN everywhere: any cache
 * or API failure returns null and the title path proceeds exactly as before.
 *
 * Plain supabase-js SERVICE_ROLE client (syncKeywordIntelligence pattern) — this runs inside the
 * streaming regen pipeline, so a cookies()-scoped client would throw and silently lose data
 * (memory: cookies()-bound client in streams = silent data loss).
 */

import { createClient } from '@supabase/supabase-js'
import { getAccessToken } from '@/lib/amazon/auth'

const ENDPOINT = process.env.AMAZON_ENDPOINT || 'https://sellingpartnerapi-na.amazon.com'
const MARKETPLACE_ID = process.env.AMAZON_MARKETPLACE_ID || 'ATVPDKIKX0DER'

// Lazy Proxy (2026-08-03, tests-into-CI): a module-top createClient THROWS without env, which made
// every test suite importing this module un-runnable locally and in CI. The Proxy defers client
// construction to the first real property access, so env-free unit tests never trigger it; runtime
// behavior is byte-identical (same client, created once).
let _supabase: ReturnType<typeof createClient<any>> | null = null
const supabase = new Proxy({} as ReturnType<typeof createClient<any>>, {
  get(_t, prop) {
    _supabase ??= createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
    return (_supabase as unknown as Record<string | symbol, unknown>)[prop]
  },
})

const CACHE_SOURCE = 'competitor_seo'
const CACHE_TTL_DAYS = 14

export interface CompetitorSeoSnapshot {
  title: string
  bullets: string[]
  description: string
}

/** Defensive re-shape of a cached JSON blob — a hand-edited/legacy row must never crash the title path. */
function normalizeSnapshot(raw: unknown): CompetitorSeoSnapshot | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as { title?: unknown; bullets?: unknown; description?: unknown }
  const title = typeof o.title === 'string' ? o.title.trim() : ''
  const bullets = Array.isArray(o.bullets) ? o.bullets.filter((b): b is string => typeof b === 'string').map((b) => b.trim()).filter(Boolean) : []
  const description = typeof o.description === 'string' ? o.description.trim() : ''
  if (!title && bullets.length === 0 && !description) return null
  return { title, bullets, description }
}

/**
 * Fetch the competitor's live SEO surface (cache-first, 14d TTL). Returns null on ANY failure or
 * an entirely-empty catalog read — callers treat null as "no snapshot" and change nothing.
 */
export async function getCompetitorSeoSnapshot(competitorAsin: string): Promise<CompetitorSeoSnapshot | null> {
  const asin = (competitorAsin || '').trim().toUpperCase()
  if (!/^[A-Z0-9]{10}$/.test(asin)) return null // 10-char ASIN shape only — never URL-inject junk

  // 1. Fresh cache hit → no API call.
  try {
    const { data } = await supabase
      .from('keyword_cache')
      .select('keyword_data, expires_at')
      .eq('asin', asin)
      .eq('source', CACHE_SOURCE)
      .single()
    if (data) {
      const row = data as { keyword_data: unknown; expires_at: string | null }
      if (!row.expires_at || new Date(row.expires_at) >= new Date()) {
        const cached = normalizeSnapshot(row.keyword_data)
        if (cached) return cached
      }
    }
  } catch { /* miss/expired/table quirk → live fetch below */ }

  // 2. Live Catalog Items read (public catalog data — works for ASINs we don't sell).
  try {
    const token = await getAccessToken()
    const url =
      `${ENDPOINT}/catalog/2022-04-01/items/${encodeURIComponent(asin)}` +
      `?marketplaceIds=${MARKETPLACE_ID}` +
      `&includedData=summaries,attributes`
    const resp = await fetch(url, {
      headers: { 'x-amz-access-token': token, 'Accept': 'application/json' },
    })
    if (!resp.ok) {
      console.warn(`[competitorSeo] Catalog fetch for ${asin} returned ${resp.status} — skipping snapshot.`)
      return null
    }
    const json = (await resp.json()) as {
      summaries?: { itemName?: string }[]
      attributes?: {
        bullet_point?: { value?: string }[]
        product_description?: { value?: string }[]
      }
    }
    const snapshot: CompetitorSeoSnapshot = {
      title: (json.summaries?.[0]?.itemName ?? '').trim(),
      bullets: (json.attributes?.bullet_point ?? []).map((b) => (b?.value ?? '').trim()).filter(Boolean),
      description: (json.attributes?.product_description?.[0]?.value ?? '').trim(),
    }
    if (!snapshot.title && snapshot.bullets.length === 0 && !snapshot.description) return null

    // 3. Cache for 14 days (best-effort — a write failure must not lose the live snapshot).
    try {
      const now = new Date()
      const { error } = await supabase
        .from('keyword_cache')
        .upsert({
          asin,
          source: CACHE_SOURCE,
          keyword_data: snapshot,
          fetched_at: now.toISOString(),
          expires_at: new Date(now.getTime() + CACHE_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString(),
        }, { onConflict: 'asin,source' })
      if (error) console.warn(`[competitorSeo] Cache write error for ${asin}:`, error.message)
    } catch (err) {
      console.warn(`[competitorSeo] Cache write exception for ${asin}:`, err instanceof Error ? err.message : err)
    }
    return snapshot
  } catch (err) {
    console.warn(`[competitorSeo] Snapshot fetch failed for ${asin} (fail-open):`, err instanceof Error ? err.message : err)
    return null
  }
}
