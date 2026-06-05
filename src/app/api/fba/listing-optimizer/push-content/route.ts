/**
 * /api/fba/listing-optimizer/push-content
 * ─────────────────────────────────────────────────────────────────────────────
 * Generalized, per-field push of optimized listing content to Amazon via
 * patchListingsItem. Supersedes the keyword-only push-keywords route.
 *
 *   field=title       → /attributes/item_name           (BROADCAST to every child SKU)
 *   field=bullets     → /attributes/bullet_point         (BROADCAST — 5-value array)
 *   field=description → /attributes/product_description   (BROADCAST)
 *   field=keywords    → /attributes/generic_keyword       (PER-CHILD — unique per SKU)
 *
 * Each content section ships INDEPENDENTLY with its own approval. "Broadcast"
 * fields are parent-level content that must be identical across all children, so
 * the single recommended value is written to every (ASIN-deduped) child. Keywords
 * are per-child (each color/size its own string).
 *
 * GET  ?parent_asin=&field=  → PREVIEW: per-SKU diff (current vs proposed), no writes.
 * POST { parent_asin, field, confirm:true } → PUSH: VALIDATION_PREVIEW then live PATCH
 *      per SKU, throttled, with a keyword_push_log row per SKU (field-tagged; rollback).
 *
 * Safety:
 *   - VALIDATION_PREVIEW before every live write; live PATCH only if Amazon says VALID.
 *   - Per-field defensive caps (keywords 250 bytes; title/desc/bullets char caps).
 *   - 200ms throttle between SKUs (Amazon limit 5 rps).
 *   - previous_value stored per SKU for rollback; field column distinguishes pushes.
 *   - listing_content cache-synced on success, then the page is re-scored.
 *   - Log + cache writes are best-effort: they never abort a push that already wrote.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { getAccessToken } from '@/lib/amazon/auth'
import {
  FIELD_CONFIG, isPushField, type PushField,
  resolveProposed, currentValue, asCompare, buildPatchValue,
  cacheUpdateFor, getByteLength, capBytes,
} from '@/lib/fba/pushFields'
import {
  resolveDetailAttribute, isPushableDetail, unpushableReason,
  buildDetailPatchValue, currentDetailValue, normalizeFieldName,
  type DetailAttribute,
} from '@/lib/fba/productDetailAttrs'

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

interface ContentRow {
  sku: string; asin: string
  title: string | null
  bullet_1: string | null; bullet_2: string | null; bullet_3: string | null; bullet_4: string | null; bullet_5: string | null
  description: string | null
  backend_keywords: string | null
}

const CONTENT_COLUMNS =
  'sku, asin, title, bullet_1, bullet_2, bullet_3, bullet_4, bullet_5, description, backend_keywords'

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

interface DiffRow {
  sku: string
  current: string
  proposed: string
  raw: string | string[] | null
  bytes: number
  chars: number
  changed: boolean
  /** Marks this row as the variation PARENT SKU (the non-buyable hub). Only set for title pushes
   *  when a capacity family is in scope; the title written here is capacity-agnostic. */
  isParent?: boolean
  /** ASIN this row's seller SKU resolves to (helpful when we add FBM twins discovered live). */
  asin?: string
}

/** Strip any GB/TB/MB capacity token from a title so it's safe for the variation-parent SKU.
 *  Mirrors the client-side computation in #60's PARENT row. */
function stripCapacity(t: string): string {
  return (t || '').replace(/\b\d{1,4}\s?(?:GB|TB|MB)\b/gi, '').replace(/\s{2,}/g, ' ').trim()
}

/** Amazon-managed system SKUs we must NOT push to. They surface in Listings Items search but
 *  aren't real seller listings: amzn.gr.* are returnless / graded inventory SKUs, amzn.* in
 *  general is system-namespaced. Pushing a title to them is meaningless and may fail validation. */
function isSystemSku(sku: string): boolean {
  return /^amzn\./i.test(sku)
}

/** Strip trailing fulfillment suffix so an FBA SKU and its FBM twin compare equal:
 *  "DAFEI-482-32G-FBA" → "DAFEI-482-32G", "DAFEI-482-32G" → "DAFEI-482-32G". */
function stripFulfillmentSuffix(sku: string): string {
  return sku.replace(/[-_](?:FBA|FBM|AFN|MFN|FN)$/i, '')
}

/**
 * For a given ASIN, ask Amazon for every SKU this seller has under it (FBA, FBM, etc.). Used to
 * augment listing_content rows whose FBM twin was never synced into our DB. Best-effort: if the
 * call fails we just return what was passed in. Filters out Amazon-managed system SKUs.
 */
async function discoverSkusForAsin(
  sellerId: string, token: string, asin: string,
): Promise<{ sku: string; asin: string }[]> {
  try {
    const url =
      `${ENDPOINT}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}` +
      `?identifiers=${encodeURIComponent(asin)}&identifiersType=ASIN` +
      `&marketplaceIds=${MARKETPLACE_ID}&includedData=summaries`
    const resp = await fetch(url, { headers: { 'x-amz-access-token': token } })
    if (!resp.ok) return []
    const json = (await resp.json()) as { items?: { sku?: string }[] }
    return (json.items ?? [])
      .map((it) => (it.sku ? { sku: it.sku, asin } : null))
      .filter((x): x is { sku: string; asin: string } => x !== null && !isSystemSku(x.sku))
  } catch { return [] }
}

/** Look up the variation-parent SKU for a parent ASIN via Listings Items search. */
async function findParentSku(sellerId: string, token: string, parentAsin: string): Promise<string | null> {
  try {
    const url =
      `${ENDPOINT}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}` +
      `?identifiers=${encodeURIComponent(parentAsin)}&identifiersType=ASIN` +
      `&marketplaceIds=${MARKETPLACE_ID}&includedData=summaries`
    const resp = await fetch(url, { headers: { 'x-amz-access-token': token } })
    if (!resp.ok) return null
    const json = (await resp.json()) as { items?: { sku?: string }[] }
    return json.items?.[0]?.sku ?? null
  } catch { return null }
}

/**
 * Load the proposed (recommended) + current (cached) value for EVERY SKU of the parent.
 *
 * We deliberately do NOT dedup by ASIN: an ASIN can have both an FBA and an FBM SKU, and
 * the seller needs BOTH listings updated — pushing a title to only one leaves the matching
 * SKU stale (the bug this fixes). Keywords are per-color, so we resolve them by ASIN and
 * apply the same string to both SKUs of a pair (per_child_keywords holds one SKU per ASIN).
 */
async function loadDiff(parentAsin: string, field: PushField): Promise<DiffRow[]> {
  const supabase = await createAdminClient()

  const { data: recRow } = await supabase
    .from('listing_seo_recommendations')
    .select('recommended_title, recommended_bullets, recommended_description, recommended_keywords, per_child_titles')
    .eq('parent_asin', parentAsin)
    .single()
  const rec = (recRow ?? {}) as {
    recommended_title?: string | null
    recommended_bullets?: string[] | null
    recommended_description?: string | null
    recommended_keywords?: string | null
    /** Per-child titles for capacity families (migration 017). resolveProposed picks the
     *  SKU-specific title when present, otherwise falls back to recommended_title. */
    per_child_titles?: { sku: string; asin: string; title: string }[] | null
  }

  const { data: rowsRaw } = await supabase
    .from('listing_content')
    .select(CONTENT_COLUMNS)
    .eq('parent_asin', parentAsin)
    .order('sku', { ascending: true })
  const rows = (rowsRaw ?? []) as ContentRow[] // every SKU — FBA and FBM both get pushed

  // Keywords are per-color (per-ASIN). Map ASIN → string so BOTH the FBA and FBM SKU of a
  // pair receive the same per-child keywords.
  const asinToKeywords = new Map<string, string>()
  if (field === 'keywords') {
    const perChild = parsePerChild(rec.recommended_keywords ?? null) // sku → keywords (one SKU per ASIN)
    const skuToAsin = new Map(rows.map((r) => [r.sku, r.asin]))
    for (const [sku, kw] of perChild) {
      const asin = skuToAsin.get(sku)
      if (asin) asinToKeywords.set(asin, kw)
    }
  }

  const baseDiff = rows
    .map((row): DiffRow => {
      const proposed = field === 'keywords'
        ? (asinToKeywords.has(row.asin) ? capBytes((asinToKeywords.get(row.asin) || '').trim(), 250) : null)
        : resolveProposed(field, rec, new Map(), row.sku)
      const proposedStr = asCompare(proposed)
      const current = currentValue(field, row as unknown as Record<string, unknown>)
      return {
        sku: row.sku, asin: row.asin,
        current,
        proposed: proposedStr,
        raw: proposed,
        bytes: getByteLength(proposedStr),
        chars: proposedStr.length,
        changed: proposedStr.length > 0 && current !== proposedStr,
      }
    })
    .filter((d) => d.raw != null) // keywords: drops SKUs whose ASIN has no per-child recommendation
  if (baseDiff.length === 0) return baseDiff

  // ── ENRICH with FBM twin SKUs discovered live from Amazon ──
  // listing_content historically deduped some FBA/FBM pairs; the user expects the push to hit
  // BOTH. Ask SP-API Listings Items per ASIN to find every SKU this seller has under that ASIN,
  // and add any SKU we don't already have to the diff with the SAME proposed value.
  let token: string | null = null
  let sellerId: string | null = null
  try {
    const knownSkus = new Set(baseDiff.map((d) => d.sku))
    const asinsToProbe = [...new Set(baseDiff.map((d) => d.asin).filter((a): a is string => !!a))]
    if (asinsToProbe.length > 0) {
      token = await getAccessToken()
      sellerId = await getSellerId()
      const skuToCurrent = new Map(rows.map((r) => [r.sku, r]))
      for (const asin of asinsToProbe) {
        const discovered = await discoverSkusForAsin(sellerId, token, asin)
        for (const d of discovered) {
          if (knownSkus.has(d.sku)) continue // already in the diff
          // INHERITANCE rule: a newly-discovered SKU under the same ASIN is a TWIN (typically the
          // FBM half of an FBA/FBM pair). It must inherit the SAME proposed value as its sibling
          // — NOT fall back to the broadcast title via resolveProposed, which would assign the
          // wrong capacity.
          // TWIN-NAME GUARD: only inherit from a source SKU whose NAME (minus fulfillment suffix)
          // matches the discovered SKU's name. Sellers occasionally assign multiple unrelated SKUs
          // to one ASIN (e.g. DAFEI-482-128GB stored under the 32G ASIN through a stale mapping);
          // those aren't real twins and we'd silently push the wrong title. Match by stripped name
          // and skip when no match exists.
          const discoveredBase = stripFulfillmentSuffix(d.sku)
          const sourceRow = baseDiff.find(
            (b) => b.asin === asin && stripFulfillmentSuffix(b.sku) === discoveredBase,
          ) ?? null
          if (!sourceRow) continue // not a true FBA/FBM twin — leave it alone
          const proposed = field === 'keywords'
            ? (asinToKeywords.has(asin) ? capBytes((asinToKeywords.get(asin) || '').trim(), 250) : null)
            : sourceRow.raw // <- inherit verbatim from the source row, so FBM gets the FBA's title
          const proposedStr = asCompare(proposed)
          if (!proposed || proposedStr.length === 0) continue
          const currentValueForRow = sourceRow.current
          baseDiff.push({
            sku: d.sku, asin,
            current: currentValueForRow,
            proposed: proposedStr,
            raw: proposed,
            bytes: getByteLength(proposedStr),
            chars: proposedStr.length,
            // A discovered SKU we haven't synced is assumed to need updating unless it happens
            // to equal the proposed string.
            changed: proposedStr.length > 0 && currentValueForRow !== proposedStr,
          })
          knownSkus.add(d.sku)
        }
      }
    }
  } catch { /* enrichment is best-effort — don't block the preview */ }

  // ── PARENT SKU row for BROADCAST field pushes ────────────────────────────────
  // The variation parent (e.g. Memory-Card-P) is non-buyable but DOES carry its own
  // item_name / bullet_point / product_description. Amazon's PDP and search results
  // surface the PARENT's content for the variation hub, so a child-only push leaves
  // the customer-visible parent stale — which is why pushing bullets to all children
  // looked like "nothing changed on Amazon" an hour later (we never wrote the
  // parent's bullets).
  //
  // Fires for any BROADCAST field (title / bullets / description), not just
  // title-with-capacity-families. Title uses a CAPACITY-AGNOSTIC version
  // (stripCapacity) when per_child_titles is in scope; otherwise ships the broadcast
  // title verbatim. Bullets and description always ship the broadcast value
  // (they're not capacity-specific).
  const isBroadcastField = field === 'title' || field === 'bullets' || field === 'description'
  if (isBroadcastField) {
    try {
      if (!token) { token = await getAccessToken(); sellerId = await getSellerId() }
      const parentSku = sellerId ? await findParentSku(sellerId, token, parentAsin) : null
      if (parentSku && !baseDiff.some((d) => d.sku === parentSku)) {
        // Resolve the parent's proposed value per-field.
        let parentValue: string | string[] | null = null
        if (field === 'title') {
          parentValue = Array.isArray(rec.per_child_titles) && rec.per_child_titles.length > 1
            ? (stripCapacity(rec.recommended_title ?? '') || null)
            : (rec.recommended_title ?? null)
        } else if (field === 'bullets') {
          parentValue = resolveProposed('bullets', rec, new Map(), parentSku)
        } else if (field === 'description') {
          parentValue = resolveProposed('description', rec, new Map(), parentSku)
        }
        const parentStr = asCompare(parentValue)
        if (parentValue && parentStr.length > 0) {
          baseDiff.push({
            sku: parentSku, asin: parentAsin,
            current: '', // we don't cache the parent's content; VALIDATION_PREVIEW is the safety net
            proposed: parentStr,
            raw: parentValue,
            bytes: getByteLength(parentStr),
            chars: parentStr.length,
            changed: true,
            isParent: true,
          })
        }
      }
    } catch { /* parent enrichment is best-effort */ }
  }

  return baseDiff
}

// ─── PRODUCT DETAILS — parallel path for field=details ─────────────────────────
// Details push is one ATTRIBUTE per click (Material, Brand, Fit Type, …). The
// friendly name comes from the audit's product_details_improvements; we resolve
// it to an SP-API key via productDetailAttrs and build the patch with the same
// twin-SKU expansion logic title uses.

interface DetailContext {
  /** Friendly name as emitted by the audit, e.g. "Material" or "Fit Type". */
  detailField: string
  /** Resolved SP-API attribute key, e.g. "material" or "fit_type". */
  attribute: DetailAttribute
  /** The single value to push across every (FBA+FBM, child) SKU under the parent. */
  recommendedValue: string
}

/** Load + validate the audit's recommendation for one detail attribute. Returns null on
 *  unknown / non-pushable detail names so the caller can return a clean 4xx. */
async function loadDetailContext(parentAsin: string, detailField: string): Promise<{ ctx: DetailContext | null; error: string | null }> {
  if (!detailField) return { ctx: null, error: 'detail_field is required for field=details (e.g. ?detail_field=Material).' }
  if (!isPushableDetail(detailField)) {
    return { ctx: null, error: unpushableReason(detailField) || `"${detailField}" can't be pushed from the portal.` }
  }
  const attribute = resolveDetailAttribute(detailField)
  if (!attribute) return { ctx: null, error: `"${detailField}" is not a recognized product-detail attribute yet.` }

  const supabase = await createAdminClient()
  const { data: recRow } = await supabase
    .from('listing_seo_recommendations')
    .select('product_details_improvements')
    .eq('parent_asin', parentAsin)
    .single()
  // product_details_improvements is JSONB; not in generated types yet.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const details = ((recRow as any)?.product_details_improvements ?? []) as { field_name?: string; recommended_value?: string }[]
  const wanted = normalizeFieldName(detailField)
  const match = details.find((d) => normalizeFieldName(d.field_name || '') === wanted)
  if (!match || !match.recommended_value || !match.recommended_value.trim()) {
    return { ctx: null, error: `No AI recommendation found for "${detailField}". Run an AI audit first.` }
  }
  return { ctx: { detailField, attribute, recommendedValue: match.recommended_value.trim() }, error: null }
}

/** Fetch a SKU's CURRENT attribute value live from Listings Items. Best-effort: '' on failure. */
async function fetchCurrentDetail(
  sellerId: string, token: string, sku: string, spApiKey: string,
): Promise<string> {
  try {
    const url =
      `${ENDPOINT}/listings/2021-08-01/items/${sellerId}/${encodeURIComponent(sku)}` +
      `?marketplaceIds=${MARKETPLACE_ID}&includedData=attributes`
    const resp = await fetch(url, { headers: { 'x-amz-access-token': token } })
    if (!resp.ok) return ''
    const json = (await resp.json()) as { attributes?: Record<string, unknown> }
    return currentDetailValue(json.attributes ?? null, spApiKey)
  } catch { return '' }
}

/**
 * Build the per-SKU diff for a detail attribute. Mirrors loadDiff's shape so the existing
 * push modal can render it unchanged. Differences:
 *   - the proposed value comes from product_details_improvements (one string, broadcast)
 *   - the current value is read live per-SKU from Listings Items attributes (no DB cache)
 *   - twin SKUs (FBA/FBM) are discovered and added with the same proposed value
 *   - the parent SKU is ALSO included for broadcast details so the variation hub agrees
 */
async function loadDetailDiff(parentAsin: string, ctx: DetailContext): Promise<DiffRow[]> {
  const supabase = await createAdminClient()
  const { data: rowsRaw } = await supabase
    .from('listing_content')
    .select('sku, asin')
    .eq('parent_asin', parentAsin)
    .order('sku', { ascending: true })
  const rows = (rowsRaw ?? []) as { sku: string; asin: string }[]
  if (rows.length === 0) return []

  const token = await getAccessToken()
  const sellerId = await getSellerId()

  // Expand to FBM twins per ASIN (same logic title push uses) so a broadcast detail also
  // covers the FBM half of each FBA/FBM pair the seller hasn't synced into our DB.
  const knownSkus = new Set(rows.map((r) => r.sku))
  const expanded: { sku: string; asin: string }[] = [...rows]
  const asinsToProbe = [...new Set(rows.map((r) => r.asin).filter(Boolean))]
  for (const asin of asinsToProbe) {
    const discovered = await discoverSkusForAsin(sellerId, token, asin)
    for (const d of discovered) {
      if (knownSkus.has(d.sku)) continue
      // TWIN-NAME GUARD: same rule as title push — only inherit when the discovered SKU's
      // stripped name matches one of our DB rows under this ASIN. Avoids accidentally
      // pushing to unrelated SKUs that share the ASIN through a stale mapping.
      const discoveredBase = stripFulfillmentSuffix(d.sku)
      const sourceMatch = rows.find(
        (b) => b.asin === asin && stripFulfillmentSuffix(b.sku) === discoveredBase,
      )
      if (!sourceMatch) continue
      expanded.push(d)
      knownSkus.add(d.sku)
    }
  }

  // Optionally include the variation parent SKU (broadcast details should agree on the hub too).
  try {
    const parentSku = await findParentSku(sellerId, token, parentAsin)
    if (parentSku && !knownSkus.has(parentSku)) {
      expanded.push({ sku: parentSku, asin: parentAsin })
      knownSkus.add(parentSku)
    }
  } catch { /* parent enrichment is best-effort */ }

  // Build the diff: one row per SKU, current fetched live, proposed = recommendedValue.
  const proposedStr = ctx.recommendedValue
  const isParentSet = new Set<string>()
  // Mark the parent row so the modal can label it (same flag the title diff uses).
  const parentRow = expanded.find((r) => r.asin === parentAsin && !rows.some((rr) => rr.sku === r.sku))
  if (parentRow) isParentSet.add(parentRow.sku)

  const diff: DiffRow[] = []
  for (const r of expanded) {
    const current = await fetchCurrentDetail(sellerId, token, r.sku, ctx.attribute.spApiKey)
    diff.push({
      sku: r.sku, asin: r.asin,
      current,
      proposed: proposedStr,
      raw: proposedStr,
      bytes: getByteLength(proposedStr),
      chars: proposedStr.length,
      changed: proposedStr.length > 0 && current !== proposedStr,
      isParent: isParentSet.has(r.sku) || undefined,
    })
  }
  return diff
}

// ─── GET — preview (no writes) ─────────────────────────────────────────────────
export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url)
    const parentAsin = url.searchParams.get('parent_asin')
    const rawField = url.searchParams.get('field') ?? 'keywords'
    if (!parentAsin) return NextResponse.json({ error: 'parent_asin is required' }, { status: 400 })

    // ── DETAILS branch ─────────────────────────────────────────────────────────
    if (rawField === 'details') {
      const detailField = url.searchParams.get('detail_field') ?? ''
      const { ctx, error } = await loadDetailContext(parentAsin, detailField)
      if (!ctx) return NextResponse.json({ error }, { status: 400 })
      const diff = await loadDetailDiff(parentAsin, ctx)
      if (diff.length === 0) {
        return NextResponse.json({ error: 'No SKUs found for this parent. Run a Sync first.' }, { status: 404 })
      }
      return NextResponse.json({
        parent_asin: parentAsin,
        field: 'details' as const,
        // Surface the SP-API key so the seller knows which attribute is being patched.
        detail_field: ctx.detailField,
        attribute_key: ctx.attribute.spApiKey,
        label: `Detail · ${ctx.detailField}`,
        // Details are always broadcast in v1 (per-variant attrs are blocked upstream).
        broadcast: true,
        configBroadcast: true,
        count: diff.length,
        changed: diff.filter((d) => d.changed).length,
        proposedValue: ctx.recommendedValue,
        diff,
      })
    }

    if (!isPushField(rawField)) return NextResponse.json({ error: `unknown field "${rawField}"` }, { status: 400 })
    const field = rawField

    const diff = await loadDiff(parentAsin, field)
    if (diff.length === 0) {
      return NextResponse.json({ error: 'No recommendations found for this field. Run an AI audit first.' }, { status: 404 })
    }
    const cfg = FIELD_CONFIG[field]
    // EFFECTIVE broadcast: the FIELD_CONFIG says title/bullets/description are broadcast, but
    // capacity variation families inject per_child_titles → the proposed values are SKU-specific.
    // Detecting that purely from the field name is wrong (silently shows ONE title to the user
    // while writing different ones per SKU). Compare the actual proposed strings: only call it
    // broadcast when every SKU genuinely agrees on the same value.
    const proposedStrings = diff.map((d) => d.proposed)
    const allIdentical = proposedStrings.length === 0 || proposedStrings.every((s) => s === proposedStrings[0])
    const effectiveBroadcast = cfg.broadcast && allIdentical
    return NextResponse.json({
      parent_asin: parentAsin,
      field,
      label: cfg.label,
      broadcast: effectiveBroadcast,
      // Useful for the UI to know whether this field is broadcast IN PRINCIPLE (so it can
      // explain why values differ) vs per-child by definition (like backend keywords).
      configBroadcast: cfg.broadcast,
      count: diff.length,
      changed: diff.filter((d) => d.changed).length,
      // For broadcast fields every child gets the same value — surface it once for the UI.
      // For effective-per-child cases, set to null so the modal must use diff[] per-SKU.
      proposedValue: effectiveBroadcast ? (diff[0]?.raw ?? null) : null,
      diff,
    })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Preview failed' }, { status: 500 })
  }
}

// ─── PATCH one SKU's attribute (validation-preview, then live) ──────────────────
async function patchSku(
  sellerId: string, token: string, productType: string, sku: string,
  attribute: string, value: string | string[], mode: 'VALIDATION_PREVIEW' | 'LIVE',
): Promise<{ ok: boolean; submissionId: string | null; error?: string }> {
  const body = {
    productType,
    patches: [{ op: 'replace', path: `/attributes/${attribute}`, value: buildPatchValue(value, MARKETPLACE_ID) }],
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

// ─── PATCH one SKU's DETAIL attribute (validation-preview, then live) ──────────
async function patchSkuDetail(
  sellerId: string, token: string, productType: string, sku: string,
  attribute: DetailAttribute, value: string, mode: 'VALIDATION_PREVIEW' | 'LIVE',
): Promise<{ ok: boolean; submissionId: string | null; error?: string }> {
  const body = {
    productType,
    patches: [{ op: 'replace', path: `/attributes/${attribute.spApiKey}`,
      value: buildDetailPatchValue(attribute, value, MARKETPLACE_ID) }],
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

// ─── POST — push (writes to Amazon, with confirm) ──────────────────────────────
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}))
    const { parent_asin, confirm, field: rawField, detail_field: detailField } = body as
      { parent_asin?: string; confirm?: boolean; field?: string; detail_field?: string }
    if (!parent_asin) return NextResponse.json({ error: 'parent_asin is required' }, { status: 400 })
    if (confirm !== true) {
      return NextResponse.json({ error: 'Refusing to write without explicit confirm:true. Use GET to preview first.' }, { status: 400 })
    }

    // ── DETAILS branch ─────────────────────────────────────────────────────────
    if (rawField === 'details') {
      const { ctx, error } = await loadDetailContext(parent_asin, detailField || '')
      if (!ctx) return NextResponse.json({ error }, { status: 400 })
      const diff = (await loadDetailDiff(parent_asin, ctx)).filter((d) => d.changed && d.raw != null)
      if (diff.length === 0) {
        return NextResponse.json({ parent_asin, field: 'details', detail_field: ctx.detailField, pushed: 0, message: `Nothing to push — every SKU already has ${ctx.detailField} = "${ctx.recommendedValue}".` })
      }
      const token = await getAccessToken()
      const sellerId = await getSellerId()
      const productType = await getProductType(sellerId, token, diff[0].sku)
      const supabase = await createAdminClient()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const db = supabase as any
      // Audit-log helper (best-effort — tagged with field='details' + the friendly attribute name
      // so a future log query can distinguish title/bullets/keywords/details by attribute).
      const logPush = async (row: Record<string, unknown>) => {
        try {
          const { error: insertErr } = await db.from('keyword_push_log').insert(row)
          if (!insertErr) return
          const rest = { ...row }; delete rest.field
          await db.from('keyword_push_log').insert(rest)
        } catch (e) { console.warn('[push-content/details] keyword_push_log insert failed:', e) }
      }

      const results: { sku: string; status: string; submissionId: string | null; error?: string }[] = []
      for (const item of diff) {
        const newValueStr = ctx.recommendedValue
        // 1) validation preview
        const preview = await patchSkuDetail(sellerId, token, productType, item.sku, ctx.attribute, newValueStr, 'VALIDATION_PREVIEW')
        if (!preview.ok) {
          results.push({ sku: item.sku, status: 'failed', submissionId: null, error: preview.error })
          await logPush({ parent_asin, sku: item.sku, field: `details:${ctx.attribute.spApiKey}`, previous_value: item.current, new_value: newValueStr, submission_id: null, status: 'failed', error_message: preview.error })
          await sleep(PATCH_DELAY_MS)
          continue
        }
        // 2) live write
        const live = await patchSkuDetail(sellerId, token, productType, item.sku, ctx.attribute, newValueStr, 'LIVE')
        const status = live.ok ? 'accepted' : 'failed'
        results.push({ sku: item.sku, status, submissionId: live.submissionId, error: live.error })
        await logPush({ parent_asin, sku: item.sku, field: `details:${ctx.attribute.spApiKey}`, previous_value: item.current, new_value: newValueStr, submission_id: live.submissionId, status, error_message: live.ok ? null : live.error })
        await sleep(PATCH_DELAY_MS)
      }

      const accepted = results.filter((r) => r.status === 'accepted').length
      const failed = results.filter((r) => r.status === 'failed').length
      return NextResponse.json({
        parent_asin,
        field: 'details' as const,
        detail_field: ctx.detailField,
        attribute_key: ctx.attribute.spApiKey,
        pushed: accepted,
        failed,
        total: results.length,
        message: `Pushed ${ctx.detailField} for ${accepted}/${results.length} variant${results.length === 1 ? '' : 's'}${failed ? `, ${failed} failed` : ''}. Changes typically reflect in 15-30 minutes.`,
        results,
      })
    }

    const field: PushField = isPushField(rawField) ? rawField : 'keywords'

    const diff = (await loadDiff(parent_asin, field)).filter((d) => d.changed && d.raw != null)
    if (diff.length === 0) {
      return NextResponse.json({ parent_asin, field, pushed: 0, message: `Nothing to push — all ${FIELD_CONFIG[field].label.toLowerCase()} already match.` })
    }

    const token       = await getAccessToken()
    const sellerId    = await getSellerId()
    const productType = await getProductType(sellerId, token, diff[0].sku)
    const attribute   = FIELD_CONFIG[field].attribute
    const supabase    = await createAdminClient()
    // keyword_push_log (migrations 015/016) is not in the generated Supabase types;
    // use a loose alias for its writes (same pattern as optimize-listing/route.ts).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = supabase as any
    // The audit-log insert and cache update must NEVER abort a push that already wrote
    // to Amazon (e.g. if migration 015/016 isn't applied yet). Both are best-effort.
    // Supabase .insert() returns an { error } (it doesn't throw) on an unknown column,
    // so if migration 016 (the `field` column) hasn't been applied we retry without it
    // — the rollback trail still survives, just untagged.
    const logPush = async (row: Record<string, unknown>) => {
      try {
        const { error } = await db.from('keyword_push_log').insert(row)
        if (!error) return
        const rest = { ...row }; delete rest.field // migration 016 not applied yet → log untagged
        await db.from('keyword_push_log').insert(rest)
      } catch (e) { console.warn('[push-content] keyword_push_log insert failed (migrations 015/016 applied?):', e) }
    }

    const results: { sku: string; status: string; submissionId: string | null; error?: string }[] = []

    for (const item of diff) {
      const value = item.raw as string | string[]
      const newValueStr = asCompare(value)
      // 1) validation preview
      const preview = await patchSku(sellerId, token, productType, item.sku, attribute, value, 'VALIDATION_PREVIEW')
      if (!preview.ok) {
        results.push({ sku: item.sku, status: 'failed', submissionId: null, error: preview.error })
        await logPush({ parent_asin, sku: item.sku, field, previous_value: item.current, new_value: newValueStr, submission_id: null, status: 'failed', error_message: preview.error })
        await sleep(PATCH_DELAY_MS)
        continue
      }
      // 2) live write
      const live = await patchSku(sellerId, token, productType, item.sku, attribute, value, 'LIVE')
      const status = live.ok ? 'accepted' : 'failed'
      results.push({ sku: item.sku, status, submissionId: live.submissionId, error: live.error })
      await logPush({ parent_asin, sku: item.sku, field, previous_value: item.current, new_value: newValueStr, submission_id: live.submissionId, status, error_message: live.ok ? null : live.error })
      // keep the local cache in sync on success (best-effort) so the re-score below is accurate
      if (live.ok) {
        try {
          await db.from('listing_content')
            .update({ ...cacheUpdateFor(field, value), content_synced_at: new Date().toISOString() })
            .eq('sku', item.sku)
        } catch (e) { console.warn('[push-content] listing_content cache update failed:', e) }
      }
      await sleep(PATCH_DELAY_MS)
    }

    const accepted = results.filter((r) => r.status === 'accepted').length
    const failed   = results.filter((r) => r.status === 'failed').length

    // Re-score so the page's score reflects the just-pushed values (the scorer otherwise
    // only runs on Sync/Regenerate, so the score went stale after a push). Best-effort —
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
      } catch (e) { console.warn('[push-content] re-score failed (non-fatal):', e) }
    }

    const label = FIELD_CONFIG[field].label.toLowerCase()
    return NextResponse.json({
      parent_asin,
      field,
      pushed: accepted,
      failed,
      total: results.length,
      message: `Pushed ${label} for ${accepted}/${results.length} variant${results.length === 1 ? '' : 's'}${failed ? `, ${failed} failed` : ''}. Changes typically reflect in 15-30 minutes.`,
      results,
    })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Push failed' }, { status: 500 })
  }
}
