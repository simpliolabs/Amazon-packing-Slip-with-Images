/**
 * GET /api/fba/admin/sku-attributes?sku=TCEO-...&keys=shirt_size,shirt_body_type
 * ─────────────────────────────────────────────────────────────────────────────
 * Read-only diagnostic: the raw SP-API stored attributes (+ standing issues) for ONE SKU.
 * Born in the 2026-08-05 twin-heal saga — the missing probe that forced every diagnosis to
 * go through heal-attempt cycles. Ground-truth use case: compare a Seller-Central-accepted
 * record's shape (the PO's hand-fixed row) against what the API writes, instead of guessing
 * which of Amazon's contradictory conditional messages to obey.
 *
 * `keys` (optional, comma-separated) filters the attributes returned; absent → attribute
 * NAMES only plus the requested-container details, keeping the response readable.
 * No writes, no credits beyond one rate-bucketed GET.
 */
import { NextRequest, NextResponse } from 'next/server'
import { getAccessToken } from '@/lib/amazon/auth'
import { getSellerId, ENDPOINT, MARKETPLACE_ID } from '@/lib/fba/pushExecutor'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const sku = (url.searchParams.get('sku') ?? '').trim()
  const keys = (url.searchParams.get('keys') ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  if (!sku) return NextResponse.json({ error: 'sku required' }, { status: 400 })
  try {
    const [sellerId, token] = await Promise.all([getSellerId(), getAccessToken()])
    const getUrl = `${ENDPOINT}/listings/2021-08-01/items/${sellerId}/${encodeURIComponent(sku)}` +
      `?marketplaceIds=${MARKETPLACE_ID}&includedData=attributes,issues`
    const resp = await fetch(getUrl, { headers: { 'x-amz-access-token': token }, cache: 'no-store' })
    if (!resp.ok) {
      const t = await resp.text()
      return NextResponse.json({ error: `GET failed HTTP ${resp.status}: ${t.slice(0, 300)}` }, { status: 502 })
    }
    const json = (await resp.json()) as { attributes?: Record<string, unknown>; issues?: unknown[] }
    const attrs = json.attributes ?? {}
    const picked: Record<string, unknown> = {}
    for (const k of keys) picked[k] = attrs[k] ?? null
    return NextResponse.json({
      sku,
      attributeNames: Object.keys(attrs).sort(),
      attributes: keys.length ? picked : undefined,
      issues: (json.issues ?? []).slice(0, 10),
    })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}
