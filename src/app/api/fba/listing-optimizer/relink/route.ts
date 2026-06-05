/**
 * /api/fba/listing-optimizer/relink
 * ─────────────────────────────────────────────────────────────────────────────
 * Re-links a child SKU into a variation family via the SP-API Listings Items API
 * (2021-08-01). Researched approach: a single PATCH on the CHILD setting
 * parentage_level=child + child_parent_sku_relationship.parent_sku=<target> (+ the
 * parent's variation_theme) re-parents it; moving a re-parented child works directly.
 *
 * GET  ?child_sku=&parent_sku=  → VALIDATION_PREVIEW only (no write): returns Amazon's
 *                                 issues + the planned change so the UI can show a dry run.
 * POST { child_sku, parent_sku, confirm:true } → LIVE patch.
 *
 * Safety (per research):
 *   - VALIDATION_PREVIEW first — block on any ERROR issue.
 *   - productType MUST match the parent; variation_theme is taken from the parent.
 *   - ACCEPTED != applied — the response reminds the caller to verify via the orphan
 *     check after a few minutes (we never claim success from the submission alone).
 *   - We never op:delete the relationship (that doesn't detach and corrupts state).
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

interface Listing {
  summaries?: { productType?: string }[]
  attributes?: Record<string, unknown>
}

async function getListing(sellerId: string, token: string, sku: string): Promise<Listing | null> {
  const url =
    `${ENDPOINT}/listings/2021-08-01/items/${sellerId}/${encodeURIComponent(sku)}` +
    `?marketplaceIds=${MARKETPLACE_ID}&includedData=summaries,attributes&issueLocale=en_US`
  const resp = await fetch(url, { headers: { 'x-amz-access-token': token } })
  if (!resp.ok) return null
  return (await resp.json()) as Listing
}

function themeOf(listing: Listing | null): string | null {
  const vt = listing?.attributes?.variation_theme as { name?: string }[] | undefined
  return vt?.[0]?.name ?? null
}

function buildPatches(parentSku: string, theme: string | null) {
  const patches: { op: string; path: string; value: unknown }[] = [
    { op: 'replace', path: '/attributes/parentage_level', value: [{ marketplace_id: MARKETPLACE_ID, value: 'child' }] },
    {
      op: 'replace',
      path: '/attributes/child_parent_sku_relationship',
      value: [{ marketplace_id: MARKETPLACE_ID, child_relationship_type: 'variation', parent_sku: parentSku }],
    },
  ]
  if (theme) patches.push({ op: 'replace', path: '/attributes/variation_theme', value: [{ marketplace_id: MARKETPLACE_ID, name: theme }] })
  return patches
}

interface Issue { code?: string; message?: string; severity?: string }

async function patchChild(
  sellerId: string, token: string, childSku: string, productType: string,
  patches: ReturnType<typeof buildPatches>, mode: 'VALIDATION_PREVIEW' | 'LIVE',
): Promise<{ ok: boolean; submissionId: string | null; status: string | null; issues: Issue[] }> {
  const modeParam = mode === 'VALIDATION_PREVIEW' ? '&mode=VALIDATION_PREVIEW' : ''
  const url =
    `${ENDPOINT}/listings/2021-08-01/items/${sellerId}/${encodeURIComponent(childSku)}` +
    `?marketplaceIds=${MARKETPLACE_ID}&includedData=issues&issueLocale=en_US${modeParam}`
  const resp = await fetch(url, {
    method: 'PATCH',
    headers: { 'x-amz-access-token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ productType, patches }),
  })
  const text = await resp.text()
  if (!resp.ok) return { ok: false, submissionId: null, status: `HTTP ${resp.status}`, issues: [{ severity: 'ERROR', message: text.slice(0, 300) }] }
  const json = JSON.parse(text) as { status?: string; submissionId?: string; issues?: Issue[] }
  const issues = json.issues ?? []
  const errors = issues.filter((i) => i.severity === 'ERROR')
  return { ok: json.status !== 'INVALID' && errors.length === 0, submissionId: json.submissionId ?? null, status: json.status ?? null, issues }
}

/** Shared prep: resolve productType (must match) + variation_theme (from parent), build patches. */
async function prepare(childSku: string, parentSku: string) {
  const token = await getAccessToken()
  const sellerId = await getSellerId()
  const [child, parent] = await Promise.all([getListing(sellerId, token, childSku), getListing(sellerId, token, parentSku)])
  if (!child) throw new Error(`Child SKU not found: ${childSku}`)
  if (!parent) throw new Error(`Parent SKU not found: ${parentSku}`)
  const childType = child.summaries?.[0]?.productType
  const parentType = parent.summaries?.[0]?.productType
  if (childType && parentType && childType !== parentType) {
    throw new Error(`Product types differ — child is ${childType}, parent is ${parentType}. Amazon won't link them.`)
  }
  const theme = themeOf(parent) || themeOf(child)
  const productType = parentType || childType || 'PRODUCT'
  return { token, sellerId, productType, theme, patches: buildPatches(parentSku, theme) }
}

// ─── GET — validation preview (no write) ───────────────────────────────────────
export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const childSku = url.searchParams.get('child_sku')
  const parentSku = url.searchParams.get('parent_sku')
  if (!childSku || !parentSku) return NextResponse.json({ error: 'child_sku and parent_sku are required' }, { status: 400 })
  try {
    const { token, sellerId, productType, theme, patches } = await prepare(childSku, parentSku)
    const res = await patchChild(sellerId, token, childSku, productType, patches, 'VALIDATION_PREVIEW')
    return NextResponse.json({ child_sku: childSku, parent_sku: parentSku, productType, variation_theme: theme, ok: res.ok, issues: res.issues })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'preview failed' }, { status: 500 })
  }
}

// ─── POST — live re-link (requires confirm) ────────────────────────────────────
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}))
    const { child_sku: childSku, parent_sku: parentSku, confirm } = body as { child_sku?: string; parent_sku?: string; confirm?: boolean }
    if (!childSku || !parentSku) return NextResponse.json({ error: 'child_sku and parent_sku are required' }, { status: 400 })
    if (confirm !== true) return NextResponse.json({ error: 'Refusing to write without confirm:true.' }, { status: 400 })

    const { token, sellerId, productType, theme, patches } = await prepare(childSku, parentSku)
    // Re-validate immediately before writing.
    const preview = await patchChild(sellerId, token, childSku, productType, patches, 'VALIDATION_PREVIEW')
    if (!preview.ok) return NextResponse.json({ child_sku: childSku, parent_sku: parentSku, applied: false, issues: preview.issues, error: 'Validation failed — not written.' }, { status: 422 })

    const live = await patchChild(sellerId, token, childSku, productType, patches, 'LIVE')

    // Persist the submission for status tracking + duplicate-submission guard.
    // Best-effort; never fails the response that already wrote to Amazon. The migration
    // (018_relink_log.sql) creates the table — if it hasn't been applied, this insert is a no-op.
    if (live.ok) {
      try {
        // Resolve the child's current ASIN (Listings Items search by SKU keeps it generic).
        let childAsin = ''
        try {
          const url =
            `${ENDPOINT}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(childSku)}` +
            `?marketplaceIds=${MARKETPLACE_ID}&includedData=summaries`
          const r = await fetch(url, { headers: { 'x-amz-access-token': token } })
          if (r.ok) {
            const j = (await r.json()) as { summaries?: { asin?: string }[] }
            childAsin = j.summaries?.[0]?.asin ?? ''
          }
        } catch { /* leave blank */ }
        const supabase = await createAdminClient()
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (supabase as any).from('relink_log').insert({
          child_sku: childSku, child_asin: childAsin,
          target_parent_sku: parentSku,
          submission_id: live.submissionId, status: 'pending',
        })
      } catch (e) { console.warn('[relink] log insert failed (migration 018 applied?):', e) }
    }

    return NextResponse.json({
      child_sku: childSku, parent_sku: parentSku, variation_theme: theme,
      submitted: live.ok, status: live.status, submissionId: live.submissionId, issues: live.issues,
      message: live.ok
        ? 'Submitted to Amazon. This is ACCEPTED, not yet applied — re-run the orphan check in a few minutes to confirm the child shows under the parent.'
        : 'Amazon rejected the re-link.',
    })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'relink failed' }, { status: 500 })
  }
}
