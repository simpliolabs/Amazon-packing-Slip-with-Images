/**
 * Parent ASIN Sync — Uses Catalog Items API to fetch parent-child relationships
 * for all active ASINs (those appearing in replenishment).
 *
 * The Catalog Items API supports batch lookups via search:
 *   GET /catalog/2022-04-01/items?identifiers=ASIN1,ASIN2,...&identifiersType=ASIN
 *   &includedData=relationships
 *
 * Rate limit: 2 requests/sec for searchCatalogItems
 * Batch size: up to 20 ASINs per request
 *
 * This writes parent_asin into:
 *   - listing_health (backfill)
 *   - asin_traffic (backfill)
 *   - A local map returned to the caller (for replenishment engine)
 */
import { createClient } from '@supabase/supabase-js'
import { getAccessToken } from '@/lib/amazon/auth'

const ENDPOINT = process.env.AMAZON_ENDPOINT || 'https://sellingpartnerapi-na.amazon.com'
const MARKETPLACE_ID = process.env.AMAZON_MARKETPLACE_ID || 'ATVPDKIKX0DER'

function getAdminSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
}

export interface ParentAsinMap {
  [childAsin: string]: string // childAsin -> parentAsin
}

export interface ParentSyncResult {
  totalLookedUp: number
  parentsMapped: number
  error: string | null
  durationMs: number
}

/**
 * Fetch parent ASINs for a list of child ASINs using the Catalog Items API.
 * Batches in groups of 20, with 500ms delay between batches for rate limiting.
 */
export async function syncParentAsins(asins: string[]): Promise<{ map: ParentAsinMap; result: ParentSyncResult }> {
  const start = Date.now()
  const supabase = getAdminSupabase()
  const parentMap: ParentAsinMap = {}

  if (asins.length === 0) {
    return {
      map: parentMap,
      result: { totalLookedUp: 0, parentsMapped: 0, error: null, durationMs: Date.now() - start },
    }
  }

  try {
    const token = await getAccessToken()

    // First, check what we already know from asin_traffic and listing_health
    const { data: knownFromTraffic } = await supabase
      .from('asin_traffic')
      .select('child_asin, parent_asin')
      .not('parent_asin', 'is', null)

    if (knownFromTraffic) {
      for (const row of knownFromTraffic) {
        if (row.parent_asin && row.child_asin) {
          parentMap[row.child_asin] = row.parent_asin
        }
      }
    }

    const { data: knownFromLH } = await supabase
      .from('listing_health')
      .select('asin, parent_asin')
      .not('parent_asin', 'is', null)

    if (knownFromLH) {
      for (const row of knownFromLH) {
        if (row.parent_asin && row.asin && !parentMap[row.asin]) {
          parentMap[row.asin] = row.parent_asin
        }
      }
    }

    console.log(`[Parent Sync] Already know ${Object.keys(parentMap).length} parent mappings from DB`)

    // Filter out ASINs we already have parent data for
    const unknownAsins = asins.filter(a => !parentMap[a])
    console.log(`[Parent Sync] Need to look up ${unknownAsins.length} ASINs via Catalog API`)

    if (unknownAsins.length === 0) {
      return {
        map: parentMap,
        result: { totalLookedUp: 0, parentsMapped: Object.keys(parentMap).length, error: null, durationMs: Date.now() - start },
      }
    }

    // Batch lookup via Catalog Items API — 20 ASINs per request
    const BATCH_SIZE = 20
    let lookedUp = 0

    for (let i = 0; i < unknownAsins.length; i += BATCH_SIZE) {
      const batch = unknownAsins.slice(i, i + BATCH_SIZE)
      const identifiers = batch.join(',')

      const url =
        `${ENDPOINT}/catalog/2022-04-01/items` +
        `?identifiers=${encodeURIComponent(identifiers)}` +
        `&identifiersType=ASIN` +
        `&marketplaceIds=${MARKETPLACE_ID}` +
        `&includedData=relationships`

      try {
        const resp = await fetch(url, {
          headers: { 'x-amz-access-token': token },
        })

        if (resp.ok) {
          const json = await resp.json()
          const items: Array<Record<string, unknown>> = json.items || []

          for (const item of items) {
            const asin = item.asin as string
            if (!asin) continue

            // relationships is an array of { identifiers, type, childAsins, parentAsins }
            const relationships = item.relationships as Array<Record<string, unknown>> | undefined
            if (!relationships) continue

            for (const rel of relationships) {
              // Look for parentAsins in the relationship
              const parentAsins = rel.parentAsins as Array<Record<string, unknown>> | undefined
              if (parentAsins && parentAsins.length > 0) {
                // parentAsins[0] has { marketplaceId, asin }
                const parentAsin = parentAsins[0].asin as string
                if (parentAsin) {
                  parentMap[asin] = parentAsin
                }
              }
            }
          }

          lookedUp += batch.length
        } else if (resp.status === 429) {
          // Rate limited — wait longer and retry
          console.warn(`[Parent Sync] Rate limited at batch ${i}, waiting 2s...`)
          await new Promise(r => setTimeout(r, 2000))
          i -= BATCH_SIZE // Retry this batch
          continue
        } else {
          const errText = await resp.text()
          console.error(`[Parent Sync] Catalog API error (${resp.status}):`, errText.slice(0, 200))
        }
      } catch (err) {
        console.error(`[Parent Sync] Fetch error for batch ${i}:`, err instanceof Error ? err.message : String(err))
      }

      // Rate limit: 500ms between batches (2 req/sec)
      if (i + BATCH_SIZE < unknownAsins.length) {
        await new Promise(r => setTimeout(r, 500))
      }
    }

    console.log(`[Parent Sync] Looked up ${lookedUp} ASINs, found ${Object.keys(parentMap).length} parent mappings`)

    // Persist new parent mappings to listing_health and asin_traffic
    const newMappings = Object.entries(parentMap)
    for (const [childAsin, parentAsin] of newMappings) {
      // Update listing_health
      await supabase
        .from('listing_health')
        .update({ parent_asin: parentAsin })
        .eq('asin', childAsin)
        .is('parent_asin', null)

      // Update asin_traffic if row exists
      await supabase
        .from('asin_traffic')
        .update({ parent_asin: parentAsin })
        .eq('child_asin', childAsin)
        .is('parent_asin', null)
    }

    // Also compute parent rollups from sku_sales_analytics for parents we now know about
    const uniqueParents = [...new Set(Object.values(parentMap))]
    for (const parentAsin of uniqueParents) {
      const childAsins = Object.entries(parentMap)
        .filter(([, p]) => p === parentAsin)
        .map(([c]) => c)

      // Sum up sales from sku_sales_analytics for all children of this parent
      const { data: childSales } = await supabase
        .from('sku_sales_analytics')
        .select('asin, units_sold_30d, revenue_30d')
        .in('asin', childAsins)

      if (childSales && childSales.length > 0) {
        const totalUnits = childSales.reduce((sum, r) => sum + (r.units_sold_30d || 0), 0)
        const totalRevenue = childSales.reduce((sum, r) => sum + (r.revenue_30d || 0), 0)
        const topChild = childSales.reduce((best, r) =>
          (r.units_sold_30d || 0) > (best.units_sold_30d || 0) ? r : best, childSales[0])

        await supabase
          .from('parent_asin_rollup')
          .upsert([{
            parent_asin: parentAsin,
            child_count: childAsins.length,
            total_units_30d: totalUnits,
            total_revenue_30d: totalRevenue,
            total_sessions_30d: 0, // Will be enriched by traffic sync
            total_page_views_30d: 0,
            avg_conversion_rate: 0,
            avg_buy_box_pct: 0,
            top_child_asin: topChild?.asin || null,
            top_child_units: topChild?.units_sold_30d || 0,
            last_synced_at: new Date().toISOString(),
          }], { onConflict: 'parent_asin' })
          .select('parent_asin')
      }
    }

    console.log(`[Parent Sync] Updated ${uniqueParents.length} parent rollups`)

    return {
      map: parentMap,
      result: {
        totalLookedUp: lookedUp,
        parentsMapped: Object.keys(parentMap).length,
        error: null,
        durationMs: Date.now() - start,
      },
    }

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[Parent Sync] Fatal error:', msg)
    return {
      map: parentMap,
      result: { totalLookedUp: 0, parentsMapped: 0, error: msg, durationMs: Date.now() - start },
    }
  }
}
