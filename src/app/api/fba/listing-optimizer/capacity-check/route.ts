/**
 * GET /api/fba/listing-optimizer/capacity-check?parent_asin=...
 *
 * Detects children whose live Amazon CAPACITY attribute disagrees with the SKU-encoded ground
 * truth (e.g. a SKU like `...-32G-FBA` whose live `memory_storage_capacity` is 128GB instead
 * of 32GB — the bug reported on B0FH39GY4R). Read-only; never writes.
 *
 * Strategy:
 *   1. Pull every child SKU stored under this parent.
 *   2. Fetch each SKU's live attributes via SP-API Listings Items 2021-08-01.
 *   3. Find whichever capacity-shaped attribute is actually present on the listing
 *      (`memory_storage_capacity`, `digital_storage_capacity`, `capacity`, etc.) — we don't
 *      assume one name; we use whatever Amazon already has there.
 *   4. Compare its rendered value (e.g. "128 gigabytes") to the SKU-derived capacity
 *      ("32GB" parsed via the same regex used by per-child titles).
 *   5. Return mismatches with enough info for the UI + a follow-up fix call.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { getAccessToken } from '@/lib/amazon/auth'

const ENDPOINT = process.env.AMAZON_ENDPOINT || 'https://sellingpartnerapi-na.amazon.com'
const MARKETPLACE_ID = process.env.AMAZON_MARKETPLACE_ID || 'ATVPDKIKX0DER'

async function getSellerId(): Promise<string> {
  const supabase = await createAdminClient()
  const { data } = await supabase.from('app_settings').select('value').eq('key', 'amazon_seller_id').single()
  const row = data as { value: string } | null
  if (row?.value) return row.value
  const fromEnv = process.env.AMAZON_MERCHANT_TOKEN || process.env.AMAZON_SELLER_ID
  if (fromEnv) return fromEnv
  throw new Error('amazon_seller_id not configured.')
}

/** Same regex used by the pipeline so detection and fix agree on the SKU's ground truth. */
const CAPACITY_RE = /\b(\d{1,4})\s?(t|g)b?\b/i
function capacityOf(s: string | null | undefined): { value: number; unit: 'gigabytes' | 'terabytes' } | null {
  const m = (s ?? '').match(CAPACITY_RE)
  if (!m) return null
  const value = Number(m[1])
  if (!Number.isFinite(value) || value <= 0) return null
  const u = m[2].toUpperCase() === 'T' ? 'terabytes' : 'gigabytes'
  return { value, unit: u }
}
function capStr(c: { value: number; unit: string } | null): string {
  return c ? `${c.value}${c.unit === 'terabytes' ? 'TB' : 'GB'}` : '—'
}

interface AttrEntry { value?: number | string; unit?: string; marketplace_id?: string }
interface ListingItem { sku?: string; summaries?: { productType?: string }[]; attributes?: Record<string, AttrEntry[]> }

/** Whichever capacity attribute Amazon actually stores on this listing. */
function findCapacityAttribute(
  attrs: Record<string, AttrEntry[]> | undefined,
): { name: string; entry: AttrEntry } | null {
  if (!attrs) return null
  // Prefer the canonical electronics-storage attribute when present; fall back to anything
  // whose name suggests capacity, then anything with a gigabytes/terabytes unit.
  const preferred = ['memory_storage_capacity', 'digital_storage_capacity', 'hard_disk_size', 'capacity']
  for (const name of preferred) {
    const e = attrs[name]?.[0]
    if (e && (e.value != null || e.unit)) return { name, entry: e }
  }
  for (const [name, arr] of Object.entries(attrs)) {
    if (!/capacity|storage/i.test(name)) continue
    const e = arr?.[0]; if (e && (e.value != null || e.unit)) return { name, entry: e }
  }
  for (const [name, arr] of Object.entries(attrs)) {
    const e = arr?.[0]
    if (e?.unit && /^(gigabytes?|terabytes?)$/i.test(e.unit)) return { name, entry: e }
  }
  return null
}

function liveCapacityFromEntry(e: AttrEntry): { value: number; unit: 'gigabytes' | 'terabytes' } | null {
  if (e.value == null) return null
  const raw = String(e.value)
  // Sometimes value is "128 GB" string, sometimes a number with a separate unit.
  const fromStr = capacityOf(raw)
  if (fromStr) return fromStr
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return null
  const u = e.unit && /tera/i.test(e.unit) ? 'terabytes' : 'gigabytes'
  return { value: n, unit: u }
}

export async function GET(req: NextRequest) {
  const parentAsin = new URL(req.url).searchParams.get('parent_asin')
  if (!parentAsin) return NextResponse.json({ error: 'parent_asin is required' }, { status: 400 })
  try {
    const supabase = await createAdminClient()
    const { data: rows } = await supabase
      .from('listing_content')
      .select('sku, asin, parent_asin')
      .eq('parent_asin', parentAsin)
    const all = (rows ?? []) as { sku: string; asin: string; parent_asin: string | null }[]
    const children = all.filter((c) => c.asin !== parentAsin)
    if (children.length === 0) return NextResponse.json({ parent_asin: parentAsin, children: [], mismatchCount: 0 })

    const token = await getAccessToken()
    const sellerId = await getSellerId()

    // Fetch each SKU's attributes. Sequential keeps us well under SP-API rate limits and the
    // 100s gateway window for a handful of children; for larger families we can batch later.
    const result: {
      sku: string; asin: string; productType: string | null
      attributeName: string | null
      live: { value: number; unit: string } | null
      expected: { value: number; unit: string } | null
      liveLabel: string; expectedLabel: string
      mismatch: boolean
      reason: 'no_attribute' | 'no_sku_capacity' | 'match' | 'mismatch' | 'fetch_failed'
    }[] = []

    for (const c of children) {
      const url =
        `${ENDPOINT}/listings/2021-08-01/items/${sellerId}/${encodeURIComponent(c.sku)}` +
        `?marketplaceIds=${MARKETPLACE_ID}&includedData=summaries,attributes&issueLocale=en_US`
      const resp = await fetch(url, { headers: { 'x-amz-access-token': token } })
      if (!resp.ok) {
        result.push({ sku: c.sku, asin: c.asin, productType: null, attributeName: null, live: null, expected: capacityOf(c.sku), liveLabel: '—', expectedLabel: capStr(capacityOf(c.sku)), mismatch: false, reason: 'fetch_failed' })
        continue
      }
      const json = (await resp.json()) as ListingItem
      const productType = json.summaries?.[0]?.productType ?? null
      const found = findCapacityAttribute(json.attributes)
      const live = found ? liveCapacityFromEntry(found.entry) : null
      const expected = capacityOf(c.sku)
      let reason: 'no_attribute' | 'no_sku_capacity' | 'match' | 'mismatch' | 'fetch_failed' = 'match'
      if (!expected) reason = 'no_sku_capacity'
      else if (!found || !live) reason = 'no_attribute'
      else if (live.value !== expected.value || live.unit !== expected.unit) reason = 'mismatch'
      result.push({
        sku: c.sku, asin: c.asin, productType,
        attributeName: found?.name ?? null,
        live, expected,
        liveLabel: capStr(live), expectedLabel: capStr(expected),
        mismatch: reason === 'mismatch',
        reason,
      })
    }

    const mismatchCount = result.filter((r) => r.mismatch).length
    return NextResponse.json({ parent_asin: parentAsin, count: result.length, mismatchCount, children: result })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'capacity check failed' }, { status: 500 })
  }
}
