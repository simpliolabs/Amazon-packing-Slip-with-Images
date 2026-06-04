/**
 * /api/fba/listing-optimizer/push-keywords
 * ─────────────────────────────────────────────────────────────────────────────
 * Bulk-pushes the per-child backend keyword strings (generic_keyword) to Amazon
 * for every child SKU of a parent ASIN. Solves the 100+-variant pain point where
 * pasting each child's search terms by hand is infeasible.
 *
 * GET  ?parent_asin=...  → PREVIEW: per-SKU diff (current cached value vs proposed),
 *                          no Amazon writes. Drives the confirmation UI.
 * POST { parent_asin }   → PUSH: for each child, VALIDATION_PREVIEW then live PATCH,
 *                          throttled, with a keyword_push_log row per SKU (rollback).
 *
 * Safety:
 *   - Backend keywords ONLY (generic_keyword) — not customer-visible, lowest risk.
 *   - 250-BYTE cap enforced before every write.
 *   - VALIDATION_PREVIEW first; only PATCH live if Amazon returns VALID.
 *   - 200ms throttle between SKUs (Amazon limit is 5 rps; ~100 SKUs ≈ 20s < 100s budget).
 *   - previous_value stored per SKU in keyword_push_log for rollback.
 *   - Uses the raw-fetch + getAccessToken() + getSellerId() pattern (NOT the SDK),
 *     reading the seller id from app_settings (the working app), per the SP-API consult.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { getAccessToken } from '@/lib/amazon/auth'

const ENDPOINT       = process.env.AMAZON_ENDPOINT       || 'https://sellingpartnerapi-na.amazon.com'
const MARKETPLACE_ID = process.env.AMAZON_MARKETPLACE_ID || 'ATVPDKIKX0DER'
const PATCH_DELAY_MS = 200 // Amazon patchListingsItem limit is 5 rps; 200ms keeps us under it.

async function getSellerId(): Promise<string> {
  const supabase = await createAdminClient()
  const { data } = await supabase
    .from('app_settings')
    .select('value')
    .eq('key', 'amazon_seller_id')
    .single()
  const row = data as { value: string } | null
  if (row?.value) return row.value
  const fromEnv = process.env.AMAZON_MERCHANT_TOKEN || process.env.AMAZON_SELLER_ID
  if (fromEnv) return fromEnv
  throw new Error('amazon_seller_id not configured. Add it in Settings.')
}

function getByteLength(str: string): number {
  return new TextEncoder().encode(str).length
}
function capBytes(str: string, maxBytes = 250): string {
  if (getByteLength(str) <= maxBytes) return str
  let lo = 0, hi = str.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (getByteLength(str.slice(0, mid)) <= maxBytes) lo = mid
    else hi = mid - 1
  }
  const cut = str.slice(0, lo)
  const lastSpace = cut.lastIndexOf(' ')
  return (lastSpace > lo * 0.7 ? cut.slice(0, lastSpace) : cut).trim()
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

interface ChildContent { sku: string; backend_keywords: string | null }

/** Parse per_child_keywords (stored as a JSON string in recommended_keywords). */
function parsePerChild(raw: string | null): Map<string, string> {
  const map = new Map<string, string>()
  if (!raw) return map
  try {
    const arr = JSON.parse(raw)
    if (Array.isArray(arr)) {
      for (const r of arr) if (r?.sku && typeof r.keywords === 'string') map.set(r.sku, r.keywords)
    }
  } catch { /* legacy/non-JSON — no per-child data */ }
  return map
}

/** Load the proposed (per-child) + current (cached) backend keywords for a parent. */
async function loadDiff(parentAsin: string) {
  const supabase = await createAdminClient()
  const { data: rec } = await supabase
    .from('listing_seo_recommendations')
    .select('recommended_keywords')
    .eq('parent_asin', parentAsin)
    .single()
  const proposed = parsePerChild((rec as { recommended_keywords: string | null } | null)?.recommended_keywords ?? null)

  const { data: children } = await supabase
    .from('listing_content')
    .select('sku, backend_keywords')
    .eq('parent_asin', parentAsin)
    .order('sku', { ascending: true })

  const rows = (children ?? []) as ChildContent[]
  const diff = rows
    .filter((c) => proposed.has(c.sku))
    .map((c) => {
      const next = capBytes((proposed.get(c.sku) || '').trim())
      const current = (c.backend_keywords || '').trim()
      return { sku: c.sku, current, proposed: next, bytes: getByteLength(next), changed: current !== next }
    })
  return diff
}

// ─── GET — preview (no writes) ─────────────────────────────────────────────────
export async function GET(req: NextRequest) {
  try {
    const parentAsin = new URL(req.url).searchParams.get('parent_asin')
    if (!parentAsin) return NextResponse.json({ error: 'parent_asin is required' }, { status: 400 })
    const diff = await loadDiff(parentAsin)
    if (diff.length === 0) {
      return NextResponse.json({ error: 'No per-child keyword recommendations found. Run an AI audit first.' }, { status: 404 })
    }
    return NextResponse.json({ parent_asin: parentAsin, count: diff.length, changed: diff.filter((d) => d.changed).length, diff })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Preview failed' }, { status: 500 })
  }
}

// ─── PATCH one SKU's generic_keyword (validation-preview, then live) ────────────
async function patchSku(
  sellerId: string, token: string, productType: string, sku: string, value: string, mode: 'VALIDATION_PREVIEW' | 'LIVE',
): Promise<{ ok: boolean; submissionId: string | null; error?: string }> {
  const body = {
    productType,
    patches: [{
      op: 'replace',
      path: '/attributes/generic_keyword',
      value: [{ value, marketplace_id: MARKETPLACE_ID, language_tag: 'en_US' }],
    }],
  }
  const modeParam = mode === 'VALIDATION_PREVIEW' ? '&mode=VALIDATION_PREVIEW' : ''
  const url =
    `${ENDPOINT}/listings/2021-08-01/items/${sellerId}/${encodeURIComponent(sku)}` +
    `?marketplaceIds=${MARKETPLACE_ID}&includedData=issues${modeParam}`
  const resp = await fetch(url, {
    method: 'PATCH',
    headers: { 'x-amz-access-token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!resp.ok) {
    const txt = await resp.text()
    return { ok: false, submissionId: null, error: `HTTP ${resp.status}: ${txt.slice(0, 200)}` }
  }
  const json = await resp.json() as { status?: string; submissionId?: string; issues?: { severity?: string; message?: string }[] }
  const errorIssues = (json.issues ?? []).filter((i) => i.severity === 'ERROR')
  if (json.status === 'INVALID' || errorIssues.length > 0) {
    return { ok: false, submissionId: json.submissionId ?? null, error: errorIssues.map((i) => i.message).join('; ') || 'Validation INVALID' }
  }
  return { ok: true, submissionId: json.submissionId ?? null }
}

/** Read the productType once from the first child (variation families share one type). */
async function getProductType(sellerId: string, token: string, sku: string): Promise<string> {
  try {
    const url =
      `${ENDPOINT}/listings/2021-08-01/items/${sellerId}/${encodeURIComponent(sku)}` +
      `?marketplaceIds=${MARKETPLACE_ID}&includedData=summaries`
    const resp = await fetch(url, { headers: { 'x-amz-access-token': token } })
    if (resp.ok) {
      const json = await resp.json() as { summaries?: { productType?: string }[] }
      const pt = json.summaries?.[0]?.productType
      if (pt) return pt
    }
  } catch { /* fall through */ }
  return 'PRODUCT' // generic fallback; Amazon resolves the actual type from the listing
}

// ─── POST — push (writes to Amazon, with confirm) ──────────────────────────────
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}))
    const { parent_asin, confirm } = body as { parent_asin?: string; confirm?: boolean }
    if (!parent_asin) return NextResponse.json({ error: 'parent_asin is required' }, { status: 400 })
    if (confirm !== true) {
      return NextResponse.json({ error: 'Refusing to write without explicit confirm:true. Use GET to preview first.' }, { status: 400 })
    }

    const diff = (await loadDiff(parent_asin)).filter((d) => d.changed && d.proposed.length > 0)
    if (diff.length === 0) {
      return NextResponse.json({ parent_asin, pushed: 0, message: 'Nothing to push — all child keywords already match.' })
    }

    const token    = await getAccessToken()
    const sellerId = await getSellerId()
    const productType = await getProductType(sellerId, token, diff[0].sku)
    const supabase = await createAdminClient()
    // keyword_push_log (migration 015) is not in the generated Supabase types yet;
    // use a loose alias for its writes (same pattern as optimize-listing/route.ts).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = supabase as any
    // The audit-log insert and cache update must NEVER abort a push that already wrote
    // to Amazon (e.g. if migration 015 isn't applied yet). Both are best-effort.
    const logPush = async (row: Record<string, unknown>) => {
      try { await db.from('keyword_push_log').insert(row) }
      catch (e) { console.warn('[push] keyword_push_log insert failed (migration 015 applied?):', e) }
    }

    const results: { sku: string; status: string; submissionId: string | null; error?: string }[] = []

    for (const item of diff) {
      const value = capBytes(item.proposed)
      // 1) validation preview
      const preview = await patchSku(sellerId, token, productType, item.sku, value, 'VALIDATION_PREVIEW')
      if (!preview.ok) {
        results.push({ sku: item.sku, status: 'failed', submissionId: null, error: preview.error })
        await logPush({ parent_asin, sku: item.sku, previous_value: item.current, new_value: value, submission_id: null, status: 'failed', error_message: preview.error })
        await sleep(PATCH_DELAY_MS)
        continue
      }
      // 2) live write
      const live = await patchSku(sellerId, token, productType, item.sku, value, 'LIVE')
      const status = live.ok ? 'accepted' : 'failed'
      results.push({ sku: item.sku, status, submissionId: live.submissionId, error: live.error })
      await logPush({ parent_asin, sku: item.sku, previous_value: item.current, new_value: value, submission_id: live.submissionId, status, error_message: live.ok ? null : live.error })
      // keep the local cache in sync on success (best-effort)
      if (live.ok) {
        try {
          await db.from('listing_content')
            .update({ backend_keywords: value, content_synced_at: new Date().toISOString() })
            .eq('sku', item.sku)
        } catch (e) { console.warn('[push] listing_content cache update failed:', e) }
      }
      await sleep(PATCH_DELAY_MS)
    }

    const accepted = results.filter((r) => r.status === 'accepted').length
    const failed   = results.filter((r) => r.status === 'failed').length

    // Re-score so the page's Keywords/overall score reflects the just-pushed values (the scorer
    // otherwise only runs on Sync/Regenerate, so the score went stale after a push). Best-effort —
    // never fail a push that already wrote to Amazon. listing_content was cache-updated above.
    if (accepted > 0) {
      try {
        const { scoreListingContent, fetchScoringContext } = await import('@/lib/sync/syncListingContent')
        const { data: kids } = await db.from('listing_content')
          .select('sku, asin, title, bullet_1, bullet_2, bullet_3, bullet_4, bullet_5, description, backend_keywords, image_count, has_aplus, aplus_module_count, aplus_has_brand_story, aplus_has_headline, aplus_images_missing_alt')
          .eq('parent_asin', parent_asin)
        const rows = (kids ?? []) as Record<string, unknown>[]
        if (rows.length > 0) {
          const { data: sc } = await db.from('listing_seo_scores').select('top_child_asin').eq('parent_asin', parent_asin).single()
          const ctx = await fetchScoringContext(db, parent_asin, (sc?.top_child_asin as string) || (rows[0]?.asin as string) || null)
          const parentOwn = rows.find((r) => r.asin === parent_asin) || null
          const score = scoreListingContent(parentOwn as never, rows as never, ctx)
          await db.from('listing_seo_scores').update({
            title_score: score.title_score, bullet_score: score.bullet_score,
            keyword_score: score.keyword_score, aplus_score: score.aplus_score,
            overall_score: score.overall_score, issues: score.issues,
            child_override_count: score.child_override_count,
          }).eq('parent_asin', parent_asin)
        }
      } catch (e) { console.warn('[push] re-score failed (non-fatal):', e) }
    }

    return NextResponse.json({
      parent_asin,
      pushed: accepted,
      failed,
      total: results.length,
      message: `Pushed backend keywords for ${accepted}/${results.length} variants${failed ? `, ${failed} failed` : ''}. Changes typically reflect in 15-30 minutes.`,
      results,
    })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Push failed' }, { status: 500 })
  }
}
