/**
 * /api/fba/listing-optimizer/fix-capacity
 * ─────────────────────────────────────────────────────────────────────────────
 * Patches the CAPACITY attribute of one child SKU to the correct value (e.g. fixing
 * a SKU whose live `memory_storage_capacity` says 128GB but the SKU is `...-32G-FBA`).
 * Same safety chain as the re-link route:
 *   GET  ?child_sku=&value=&unit=  → VALIDATION_PREVIEW only.
 *   POST { child_sku, value, unit, confirm:true } → re-validate, then live PATCH.
 *
 * Caveats surfaced to the UI:
 *   - We use whichever capacity attribute Amazon ALREADY stores on the listing (we never
 *     introduce a brand-new attribute name; that would be invalid for this productType).
 *   - ACCEPTED != applied — the user re-runs the capacity check to verify.
 *   - Changing a variation axis value can trigger Amazon to re-validate the family. If that
 *     creates a duplicate (e.g. two children now share the same capacity), the variation may
 *     be split. The VALIDATION_PREVIEW pass surfaces this before we write.
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

interface AttrEntry { value?: number | string; unit?: string; marketplace_id?: string }
interface Listing { sku?: string; summaries?: { productType?: string }[]; attributes?: Record<string, AttrEntry[]> }

async function getListing(sellerId: string, token: string, sku: string): Promise<Listing | null> {
  const url =
    `${ENDPOINT}/listings/2021-08-01/items/${sellerId}/${encodeURIComponent(sku)}` +
    `?marketplaceIds=${MARKETPLACE_ID}&includedData=summaries,attributes&issueLocale=en_US`
  const resp = await fetch(url, { headers: { 'x-amz-access-token': token } })
  if (!resp.ok) return null
  return (await resp.json()) as Listing
}

/** Find the capacity-shaped attribute that ALREADY exists on the listing. We patch whatever
 *  name is there — we never invent a new one for the productType. */
function findCapacityAttribute(attrs: Record<string, AttrEntry[]> | undefined): { name: string; entry: AttrEntry } | null {
  if (!attrs) return null
  const preferred = ['memory_storage_capacity', 'digital_storage_capacity', 'hard_disk_size', 'capacity']
  for (const name of preferred) {
    const e = attrs[name]?.[0]; if (e && (e.value != null || e.unit)) return { name, entry: e }
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

interface Issue { code?: string; message?: string; severity?: string }

/** Build the patch body. The new value matches the SHAPE of whatever's currently on the listing
 *  (preserves marketplace_id and other extra fields), only changing value + unit. This keeps
 *  the productType-specific schema valid. */
function buildPatch(attrName: string, currentEntry: AttrEntry, value: number, unit: string) {
  const replacement: AttrEntry = {
    ...currentEntry,
    value,
    unit,
    marketplace_id: currentEntry.marketplace_id ?? MARKETPLACE_ID,
  }
  return [{ op: 'replace', path: `/attributes/${attrName}`, value: [replacement] }]
}

async function patchSku(
  sellerId: string, token: string, sku: string, productType: string,
  patches: ReturnType<typeof buildPatch>, mode: 'VALIDATION_PREVIEW' | 'LIVE',
): Promise<{ ok: boolean; submissionId: string | null; status: string | null; issues: Issue[] }> {
  const modeParam = mode === 'VALIDATION_PREVIEW' ? '&mode=VALIDATION_PREVIEW' : ''
  const url =
    `${ENDPOINT}/listings/2021-08-01/items/${sellerId}/${encodeURIComponent(sku)}` +
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

/** Resolve productType, current capacity attribute, and the patch body. */
async function prepare(childSku: string, value: number, unit: string) {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`Invalid capacity value: ${value}`)
  if (unit !== 'gigabytes' && unit !== 'terabytes') throw new Error(`Invalid capacity unit: ${unit} (expected gigabytes or terabytes)`)
  const token = await getAccessToken()
  const sellerId = await getSellerId()
  const child = await getListing(sellerId, token, childSku)
  if (!child) throw new Error(`Child SKU not found: ${childSku}`)
  const productType = child.summaries?.[0]?.productType ?? 'PRODUCT'
  const found = findCapacityAttribute(child.attributes)
  if (!found) throw new Error('No capacity attribute is currently set on this listing. Adding a new attribute requires the full product-type schema and is not safe to do blind — set it once in Seller Central, then this auto-fix can correct it.')
  const patches = buildPatch(found.name, found.entry, value, unit)
  return { token, sellerId, productType, attributeName: found.name, currentEntry: found.entry, patches }
}

// ─── GET — validation preview (no write) ───────────────────────────────────────
export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const childSku = url.searchParams.get('child_sku')
  const value = Number(url.searchParams.get('value') ?? NaN)
  const unit = (url.searchParams.get('unit') ?? '').toLowerCase()
  if (!childSku) return NextResponse.json({ error: 'child_sku is required' }, { status: 400 })
  try {
    const { token, sellerId, productType, attributeName, currentEntry, patches } = await prepare(childSku, value, unit)
    const res = await patchSku(sellerId, token, childSku, productType, patches, 'VALIDATION_PREVIEW')
    return NextResponse.json({
      child_sku: childSku, productType, attributeName,
      current: { value: currentEntry.value, unit: currentEntry.unit },
      proposed: { value, unit },
      ok: res.ok, issues: res.issues,
    })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'preview failed' }, { status: 500 })
  }
}

// ─── POST — live fix (requires confirm) ────────────────────────────────────────
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}))
    const { child_sku: childSku, value, unit, confirm } = body as { child_sku?: string; value?: number; unit?: string; confirm?: boolean }
    if (!childSku) return NextResponse.json({ error: 'child_sku is required' }, { status: 400 })
    if (confirm !== true) return NextResponse.json({ error: 'Refusing to write without confirm:true.' }, { status: 400 })

    const { token, sellerId, productType, attributeName, patches } = await prepare(childSku, Number(value), String(unit).toLowerCase())
    // Re-validate immediately before writing.
    const preview = await patchSku(sellerId, token, childSku, productType, patches, 'VALIDATION_PREVIEW')
    if (!preview.ok) return NextResponse.json({ child_sku: childSku, attributeName, applied: false, issues: preview.issues, error: 'Validation failed — not written.' }, { status: 422 })

    const live = await patchSku(sellerId, token, childSku, productType, patches, 'LIVE')
    return NextResponse.json({
      child_sku: childSku, attributeName,
      submitted: live.ok, status: live.status, submissionId: live.submissionId, issues: live.issues,
      message: live.ok
        ? 'Submitted to Amazon. ACCEPTED, not yet applied — re-run the capacity check in a few minutes to confirm the live attribute now matches.'
        : 'Amazon rejected the capacity fix.',
    })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'capacity fix failed' }, { status: 500 })
  }
}
