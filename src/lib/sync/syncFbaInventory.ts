/**
 * syncFbaInventory.ts
 *
 * Fetches live FBA inventory quantities from the Amazon SP-API
 * FBA Inventory API (GET /fba/inventory/v1/summaries) and upserts
 * into the fba_inventory table.
 *
 * This is the source of truth for:
 *   - quantity_available  (fulfillable units at FCs)
 *   - quantity_inbound    (units in transit / being received) ← the ON WAY column
 *   - quantity_reserved   (reserved for pending orders)
 *   - quantity_total      (sum of all)
 *
 * The API paginates via nextToken. We fetch all pages and upsert by SKU.
 *
 * Rate limit: 2 req/s burst, 2 req/s sustained — we add 600ms delay between pages.
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

interface FbaInventorySummary {
  asin: string
  fnSku: string
  sellerSku: string
  condition: string
  inventoryDetails?: {
    fulfillableQuantity?: number
    inboundWorkingQuantity?: number
    inboundShippedQuantity?: number
    inboundReceivingQuantity?: number
    reservedQuantity?: {
      totalReservedQuantity?: number
      pendingCustomerOrderQuantity?: number
      pendingTransshipmentQuantity?: number
      fcProcessingQuantity?: number
    }
    researchingQuantity?: {
      totalResearchingQuantity?: number
    }
    unfulfillableQuantity?: {
      totalUnfulfillableQuantity?: number
    }
  }
  totalQuantity?: number
  lastUpdatedTime?: string
  productName?: string
}

interface FbaInventoryResponse {
  payload?: {
    granularity?: { granularityType: string; granularityId: string }
    inventorySummaries?: FbaInventorySummary[]
  }
  pagination?: {
    nextToken?: string
  }
}

/**
 * Fetch one page of FBA inventory summaries from the SP-API.
 */
async function fetchInventoryPage(
  token: string,
  nextToken?: string
): Promise<{ summaries: FbaInventorySummary[]; nextToken: string | null }> {
  const params = new URLSearchParams({
    details: 'true',
    granularityType: 'Marketplace',
    granularityId: MARKETPLACE_ID,
    marketplaceIds: MARKETPLACE_ID,
  })

  if (nextToken) {
    params.set('nextToken', nextToken)
  }

  const url = `${ENDPOINT}/fba/inventory/v1/summaries?${params.toString()}`

  const resp = await fetch(url, {
    headers: {
      'x-amz-access-token': token,
      'Accept': 'application/json',
    },
  })

  if (!resp.ok) {
    const body = await resp.text()
    throw new Error(`FBA Inventory API error ${resp.status}: ${body}`)
  }

  const json: FbaInventoryResponse = await resp.json()
  const summaries = json.payload?.inventorySummaries ?? []
  const next = json.pagination?.nextToken ?? null

  return { summaries, nextToken: next }
}

/**
 * Main export: sync all FBA inventory from Amazon into the fba_inventory table.
 * Returns a summary of what was processed.
 */
export async function syncFbaInventory(): Promise<{
  success: boolean
  skusProcessed: number
  error?: string
}> {
  console.log('[FbaInventory] Starting sync...')

  try {
    const token = await getAccessToken()
    const supabase = getAdminSupabase()

    const allSummaries: FbaInventorySummary[] = []
    let nextToken: string | undefined = undefined
    let pageCount = 0

    // Paginate through all FBA inventory
    do {
      const { summaries, nextToken: next } = await fetchInventoryPage(token, nextToken)
      allSummaries.push(...summaries)
      nextToken = next ?? undefined
      pageCount++

      console.log(`[FbaInventory] Page ${pageCount}: ${summaries.length} SKUs (total so far: ${allSummaries.length})`)

      // Respect rate limit: 600ms between pages
      if (nextToken) {
        await new Promise(resolve => setTimeout(resolve, 600))
      }
    } while (nextToken)

    console.log(`[FbaInventory] Fetched ${allSummaries.length} SKUs across ${pageCount} pages`)

    if (allSummaries.length === 0) {
      return { success: true, skusProcessed: 0 }
    }

    // Transform into upsert rows
    const now = new Date().toISOString()
    const rows = allSummaries.map((s) => {
      const details = s.inventoryDetails ?? {}
      const fulfillable = details.fulfillableQuantity ?? 0
      const inboundWorking = details.inboundWorkingQuantity ?? 0
      const inboundShipped = details.inboundShippedQuantity ?? 0
      const inboundReceiving = details.inboundReceivingQuantity ?? 0
      // Total inbound = working + shipped + receiving
      const quantityInbound = inboundWorking + inboundShipped + inboundReceiving
      const reserved = details.reservedQuantity?.totalReservedQuantity ?? 0
      const total = s.totalQuantity ?? (fulfillable + quantityInbound + reserved)

      return {
        asin: s.asin,
        sku: s.sellerSku,
        fnsku: s.fnSku,
        condition_type: s.condition ?? 'NewItem',
        quantity_available: fulfillable,
        quantity_reserved: reserved,
        quantity_inbound: quantityInbound,
        quantity_total: total,
        last_synced_at: now,
      }
    })

    // Upsert in batches of 500 to avoid payload limits
    const BATCH_SIZE = 500
    let upserted = 0

    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE)
      const { error } = await supabase
        .from('fba_inventory')
        .upsert(batch, {
          onConflict: 'sku',
          ignoreDuplicates: false,
        })

      if (error) {
        console.error(`[FbaInventory] Upsert error on batch ${i / BATCH_SIZE + 1}:`, error)
        throw new Error(`Supabase upsert failed: ${error.message}`)
      }

      upserted += batch.length
      console.log(`[FbaInventory] Upserted ${upserted}/${rows.length} rows`)
    }

    console.log(`[FbaInventory] Sync complete — ${upserted} SKUs updated`)
    return { success: true, skusProcessed: upserted }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[FbaInventory] Sync failed:', message)
    return { success: false, skusProcessed: 0, error: message }
  }
}
