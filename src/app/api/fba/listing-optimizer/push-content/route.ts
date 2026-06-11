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
  resolveDetailAttribute, unpushableReason,
  buildDetailPatchValue, currentDetailValue, normalizeFieldName,
  type DetailAttribute,
} from '@/lib/fba/productDetailAttrs'
import { coerceDetailValue, inspectProductTypeAttribute, attributeExistsInSchema } from '@/lib/fba/productTypeDefinitions'
import { getProductType } from '@/lib/amazon/productType'

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
async function loadDiff(parentAsin: string, field: PushField, titleOverride?: string): Promise<DiffRow[]> {
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

  // A manual title override broadcasts ONE typed string to every SKU. That is correct for broadcast-
  // title products (apparel) but would CLOBBER a capacity family's distinct per-GB titles — stamping
  // "128GB" onto the 32GB SKU on the live PDP (adversarial review caught this). So the override is
  // honored ONLY when this is NOT a per-child-title family; otherwise we fall back to resolveProposed.
  const isCapacityFamily = Array.isArray(rec.per_child_titles) && rec.per_child_titles.length > 1
  const effectiveTitleOverride = titleOverride && !isCapacityFamily ? titleOverride : undefined

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
        // Manual title override: the seller typed their own title in the Ship-Title box → broadcast it
        // verbatim to every SKU (capped at Amazon's 200-char title limit), bypassing the AI recommendation.
        : (field === 'title' && effectiveTitleOverride) ? effectiveTitleOverride.slice(0, 200)
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
          parentValue = effectiveTitleOverride
            ? effectiveTitleOverride.slice(0, 200)
            : Array.isArray(rec.per_child_titles) && rec.per_child_titles.length > 1
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
  /** The single value to push across every (FBA+FBM, child) SKU under the parent.
   *  Already coerced to an accepted enum value when the attribute is a constrained
   *  enum (e.g. "Unisex Adult" → "Unisex"). */
  recommendedValue: string
  /** When the attribute is a constrained enum, the accepted values (for the seller to
   *  pick from if the audit's value couldn't be mapped). Undefined for free-text attrs. */
  acceptedValues?: string[]
  /** The audit's original value when enum-coercion changed it (e.g. "Unisex Adult"). */
  normalizedFrom?: string
  /** True = a constrained enum the value can't map to (uncoercible). recommendedValue stays the raw
   *  value; the seller must pick from acceptedValues. The PREVIEW surfaces this so the modal shows a
   *  picker; the PUSH blocks unless a valid value-override is supplied (Part 2b seller-picker). */
  enumInvalid?: boolean
}

/** Load + validate the audit's recommendation for one detail attribute. Returns null on
 *  unknown / non-pushable detail names so the caller can return a clean 4xx. */
async function loadDetailContext(parentAsin: string, detailField: string, valueOverride?: string): Promise<{ ctx: DetailContext | null; error: string | null }> {
  if (!detailField) return { ctx: null, error: 'detail_field is required for field=details (e.g. ?detail_field=Material).' }

  const supabase = await createAdminClient()
  const { data: recRow } = await supabase
    .from('listing_seo_recommendations')
    .select('product_details_improvements')
    .eq('parent_asin', parentAsin)
    .single()
  // product_details_improvements is JSONB; not in generated types yet. The regen now resolves + persists
  // sp_api_key/attr_scope/pushable per item (schema-driven), so read those.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const details = ((recRow as any)?.product_details_improvements ?? []) as { field_name?: string; recommended_value?: string; sp_api_key?: string; attr_scope?: string; pushable?: boolean }[]
  const wanted = normalizeFieldName(detailField)
  const match = details.find((d) => normalizeFieldName(d.field_name || '') === wanted)
  if (!match || !match.recommended_value || !match.recommended_value.trim()) {
    return { ctx: null, error: `No AI recommendation found for "${detailField}". Run an AI audit first.` }
  }
  // Resolve the SP-API attribute: prefer the regen-resolved sp_api_key (schema-driven — works for ANY
  // category, not just the apparel map); fall back to the static map. Reject only when neither yields a
  // pushable broadcast attribute.
  const attribute: DetailAttribute | undefined = (match.pushable && match.sp_api_key)
    ? { spApiKey: match.sp_api_key, scope: 'broadcast' }
    : resolveDetailAttribute(detailField) ?? undefined
  if (!attribute || attribute.scope !== 'broadcast') {
    return { ctx: null, error: unpushableReason(detailField) || `"${detailField}" isn't a pushable attribute for this product type.` }
  }

  // ── Enum validation (Feature B) ──────────────────────────────────────────────
  // Some attributes are constrained enums (apparel `department` accepts only
  // {Unisex, Unisex Baby, Unisex Kids} for this product type). The audit emits a
  // free-text value ("Unisex Adult") that Amazon rejects. Read the LIVE product-type
  // schema and coerce the value to an accepted one — "the system knows the acceptable
  // terms for any feature". Best-effort: any failure leaves the value as-is (the prior
  // behavior; VALIDATION_PREVIEW still guards the write).
  // SELLER OVERRIDE (Part 2b): the seller's pick from the panel's accepted-values chips REPLACES the
  // audit value — but it must STILL pass the enum validation below. Defense-in-depth: a direct POST
  // could send any string, and we must NEVER write a non-member (adversarial review caught the original
  // verbatim-passthrough). The override only skips the audit value, never the validation. Capped at
  // 1000 chars: details are short attributes, and this also bounds a free-text override.
  const override = (valueOverride ?? '').trim()
  let recommendedValue = (override || match.recommended_value.trim()).slice(0, 1000)
  let acceptedValues: string[] | undefined
  let normalizedFrom: string | undefined
  let enumInvalid = false

  // ── Enum validation (Feature B) — coerce the value (audit OR seller override) to an accepted member;
  // FLAG (don't error) when uncoercible so the PREVIEW can show the seller-picker and the PUSH blocks.
  // Best-effort: any SP-API failure leaves the value as-is (VALIDATION_PREVIEW is the final backstop).
  try {
    const { data: skuRows } = await supabase
      .from('listing_content')
      .select('sku')
      .eq('parent_asin', parentAsin)
      .limit(1)
    const sku = (skuRows as { sku?: string }[] | null)?.[0]?.sku
    if (sku) {
      const token = await getAccessToken()
      const sellerId = await getSellerId()
      const productType = await getProductType(sellerId, token, sku)
      const c = await coerceDetailValue(productType, attribute.spApiKey, recommendedValue, {
        token, sellerId, marketplaceId: MARKETPLACE_ID, endpoint: ENDPOINT,
      })
      if (c.isEnum) {
        acceptedValues = c.accepted
        if (!c.valid) {
          enumInvalid = true   // uncoercible dropdown — preview shows the picker; PUSH blocks w/o a valid override
        } else if (c.normalizedFrom) {
          normalizedFrom = c.normalizedFrom
          recommendedValue = c.value
          console.log(`[push-content] enum-coerced ${attribute.spApiKey}: "${normalizedFrom}" -> "${recommendedValue}" (productType ${productType})`)
        }
      }
    }
  } catch (err) {
    console.warn('[push-content] enum coercion skipped:', err)
  }

  return { ctx: { detailField, attribute, recommendedValue, acceptedValues, normalizedFrom, enumInvalid }, error: null }
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

    // ── DEBUG branch (?debug=1&field=details&detail_field=…) — diagnose enum resolution.
    //    Read-only: resolves the productType and introspects the LIVE product-type schema so we
    //    can see WHERE enum lookup fails (definitions HTTP status, presigned-schema status,
    //    attribute presence, extraction). ?product_type= overrides the resolved type.
    if (url.searchParams.get('debug') === '1' && rawField === 'details') {
      const detailField = url.searchParams.get('detail_field') || 'Department'
      const attribute = resolveDetailAttribute(detailField)
      if (!attribute) return NextResponse.json({ error: `unknown detail "${detailField}"` }, { status: 400 })
      const supabase = await createAdminClient()
      const { data: skuRows } = await supabase.from('listing_content').select('sku').eq('parent_asin', parentAsin).limit(1)
      const sku = (skuRows as { sku?: string }[] | null)?.[0]?.sku ?? null
      const ptOverride = url.searchParams.get('product_type')
      let productType = ptOverride || 'PRODUCT'
      let token = '', sellerId = ''
      try {
        token = await getAccessToken()
        sellerId = await getSellerId()
        if (!ptOverride && sku) productType = await getProductType(sellerId, token, sku)
      } catch (e) {
        return NextResponse.json({ stage: 'auth', sku, error: e instanceof Error ? e.message : String(e) })
      }
      const inspect = await inspectProductTypeAttribute(productType, attribute.spApiKey, {
        token, sellerId, marketplaceId: MARKETPLACE_ID, endpoint: ENDPOINT,
      })
      return NextResponse.json({ sku, detailField, spApiKey: attribute.spApiKey, productType, ...inspect })
    }

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
        // Enum (Feature B): the accepted vocabulary for this attribute + what we
        // normalized the audit's value FROM, so the modal can show "Unisex Adult → Unisex".
        acceptedValues: ctx.acceptedValues ?? null,
        normalizedFrom: ctx.normalizedFrom ?? null,
        // Part 2b: uncoercible dropdown — the modal shows a seller-picker over acceptedValues.
        enum_invalid: ctx.enumInvalid ?? false,
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
// getProductType moved to @/lib/amazon/productType (shared + process-cached for consistent enum
// resolution). Imported above; both loadDetailContext and the ?debug branch use the shared version.

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
// Streams NDJSON so the upload survives proxy idle-timeouts (Coolify nginx ~60s,
// Cloudflare ~100s) and container restarts mid-deploy. Replaces the previous
// synchronous JSON response that surfaced as 'Bad Gateway' to the client when
// the proxy gave up before the push finished (PR #69 caught the parser error;
// this fixes the root cause).
//
// Event types (one JSON object per newline-delimited line):
//   {type:'started',    field, detail_field?, attribute_key?, total, broadcast}
//   {type:'progress',   sku, status:'validating'|'accepted'|'failed', error?, submissionId?, current?, proposed?}
//   {type:'rescore',    message:'…'}       — between SKU loop and final result
//   {type:'result',     pushed, failed, total, message, results, field, detail_field?, attribute_key?}
//   {type:'error',      error, results?}    — terminal; partial results included when known
//
// The client reads the stream line-by-line; the 'result' event is the only one
// that should advance the post-push UI. 'progress' updates a per-SKU spinner.
export async function POST(req: NextRequest) {
  // Validate the body BEFORE opening the stream — a 400 here is a real client error,
  // not a mid-push failure. Keeps the streaming envelope reserved for things that
  // can actually fail asynchronously.
  let body: { parent_asin?: string; confirm?: boolean; field?: string; detail_field?: string; skus?: string[]; title_override?: string; detail_value_override?: string }
  try { body = (await req.json().catch(() => ({}))) as typeof body }
  catch { return NextResponse.json({ error: 'Invalid request body' }, { status: 400 }) }
  const { parent_asin, confirm, field: rawField, detail_field: detailField, skus, title_override, detail_value_override } = body
  if (!parent_asin) return NextResponse.json({ error: 'parent_asin is required' }, { status: 400 })
  if (confirm !== true) {
    return NextResponse.json({ error: 'Refusing to write without explicit confirm:true. Use GET to preview first.' }, { status: 400 })
  }

  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (obj: unknown) => controller.enqueue(encoder.encode(JSON.stringify(obj) + '\n'))
      try {
        // ── DETAILS branch ─────────────────────────────────────────────────────
        if (rawField === 'details') {
          const { ctx, error } = await loadDetailContext(parent_asin, detailField || '', detail_value_override)
          if (!ctx) { emit({ type: 'error', error }); controller.close(); return }
          if (ctx.enumInvalid) {
            // Uncoercible dropdown and no valid override picked -> refuse the write (never push a non-member).
            emit({ type: 'error', error: `"${ctx.recommendedValue}" is not an accepted Amazon value for "${ctx.detailField}". Pick one of the accepted values${ctx.acceptedValues?.length ? `: ${ctx.acceptedValues.slice(0, 25).join(', ')}` : ''}.` })
            controller.close(); return
          }
          const diff = (await loadDetailDiff(parent_asin, ctx)).filter((d) => d.changed && d.raw != null)
          if (diff.length === 0) {
            emit({
              type: 'result',
              parent_asin, field: 'details', detail_field: ctx.detailField, attribute_key: ctx.attribute.spApiKey,
              pushed: 0, failed: 0, total: 0,
              message: `Nothing to push — every SKU already has ${ctx.detailField} = "${ctx.recommendedValue}".`,
              results: [],
            })
            controller.close(); return
          }
          emit({
            type: 'started',
            field: 'details', detail_field: ctx.detailField, attribute_key: ctx.attribute.spApiKey,
            total: diff.length, broadcast: true,
          })
          const token = await getAccessToken()
          const sellerId = await getSellerId()
          const productType = await getProductType(sellerId, token, diff[0].sku)
          // GUARD (PO live bug): the attribute must EXIST in THIS product type's schema. Apparel attrs
          // (department, fit_type, fabric_type) are absent on office/electronics types — Amazon 400s EVERY
          // patch with "the provided attribute path is not valid" (10 failed writes on a sticky-notes
          // listing). Catch it ONCE with a clear message instead. Fail-open on a schema-fetch error.
          const ptOpts = { token, sellerId, marketplaceId: MARKETPLACE_ID, endpoint: ENDPOINT }
          if (!(await attributeExistsInSchema(productType, ctx.attribute.spApiKey, ptOpts))) {
            emit({
              type: 'result', parent_asin, field: 'details', detail_field: ctx.detailField, attribute_key: ctx.attribute.spApiKey,
              pushed: 0, failed: 0, total: 0,
              message: `"${ctx.detailField}" is not a valid attribute for this product type (${productType}) — it doesn't apply to this category, so there's nothing to push. It shouldn't have been recommended; regenerate to refresh the suggestions.`,
              results: [],
            })
            controller.close(); return
          }
          const supabase = await createAdminClient()
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const db = supabase as any
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
            emit({ type: 'progress', sku: item.sku, status: 'validating', current: item.current, proposed: newValueStr })
            const preview = await patchSkuDetail(sellerId, token, productType, item.sku, ctx.attribute, newValueStr, 'VALIDATION_PREVIEW')
            if (!preview.ok) {
              // Amazon's pre-launch wall: the attribute is in the schema + Seller Central form, but
              // Listings-API writes stay refused until the July 27, 2026 launch. Say so plainly
              // instead of leaving the seller to decode Amazon's "refer to the tool tip".
              const friendlyErr = preview.error && /currently unsupported/i.test(preview.error)
                ? `${preview.error} — Amazon hasn't opened API writes for this attribute yet (full launch July 27, 2026). The value is generated and saved; push it again once Amazon enables the field.`
                : preview.error
              results.push({ sku: item.sku, status: 'failed', submissionId: null, error: friendlyErr })
              emit({ type: 'progress', sku: item.sku, status: 'failed', error: friendlyErr })
              await logPush({ parent_asin, sku: item.sku, field: `details:${ctx.attribute.spApiKey}`, previous_value: item.current, new_value: newValueStr, submission_id: null, status: 'failed', error_message: friendlyErr })
              await sleep(PATCH_DELAY_MS)
              continue
            }
            const live = await patchSkuDetail(sellerId, token, productType, item.sku, ctx.attribute, newValueStr, 'LIVE')
            const status = live.ok ? 'accepted' : 'failed'
            results.push({ sku: item.sku, status, submissionId: live.submissionId, error: live.error })
            emit({ type: 'progress', sku: item.sku, status, submissionId: live.submissionId, error: live.error })
            await logPush({ parent_asin, sku: item.sku, field: `details:${ctx.attribute.spApiKey}`, previous_value: item.current, new_value: newValueStr, submission_id: live.submissionId, status, error_message: live.ok ? null : live.error })
            await sleep(PATCH_DELAY_MS)
          }

          const accepted = results.filter((r) => r.status === 'accepted').length
          const failed = results.filter((r) => r.status === 'failed').length

          // WRITE-THROUGH + RE-SCORE so Features rises IMMEDIATELY (the bullets ship→rise experience),
          // instead of staying RED until the next regen re-reads Amazon. On success, mark this detail's
          // current_value = the pushed value so the scorer's productDetailsGaps drops, then re-score.
          // Best-effort (mirrors the regular-fields branch). Without this the details push was a "RED
          // stays RED" dead-end — the score never moved on push (PO question: "8 → 12/12?").
          if (accepted > 0) {
            try {
              const { data: recR } = await db.from('listing_seo_recommendations').select('product_details_improvements').eq('parent_asin', parent_asin).single()
              const pdi = ((recR?.product_details_improvements ?? []) as Record<string, unknown>[])
              let touched = false
              const wantField = normalizeFieldName(ctx.detailField)
              for (const p of pdi) {
                if (normalizeFieldName(String(p.field_name ?? '')) === wantField) {
                  p.current_value = ctx.recommendedValue; p.enum_valid = true; touched = true
                }
              }
              if (touched) await db.from('listing_seo_recommendations').update({ product_details_improvements: pdi }).eq('parent_asin', parent_asin)
            } catch (e) { console.warn('[push-content/details] write-through failed (non-fatal):', e) }
            emit({ type: 'rescore', message: 'Re-scoring listing…' })
            try {
              const { scoreListingContent, fetchScoringContext } = await import('@/lib/sync/syncListingContent')
              const { data: kids } = await db.from('listing_content')
                .select('sku, asin, title, bullet_1, bullet_2, bullet_3, bullet_4, bullet_5, description, backend_keywords, image_count, has_aplus, aplus_module_count, aplus_has_brand_story, aplus_has_headline, aplus_images_missing_alt')
                .eq('parent_asin', parent_asin)
              const rows = (kids ?? []) as Record<string, unknown>[]
              if (rows.length > 0) {
                const { data: sc } = await db.from('listing_seo_scores').select('top_child_asin').eq('parent_asin', parent_asin).single()
                const ctxS = await fetchScoringContext(db, parent_asin, (sc?.top_child_asin as string) || (rows[0]?.asin as string) || null)
                const parentOwn = rows.find((r) => r.asin === parent_asin) || null
                const score = scoreListingContent(parentOwn as never, rows as never, ctxS)
                await db.from('listing_seo_scores').update({
                  title_score: score.title_score, bullet_score: score.bullet_score,
                  keyword_score: score.keyword_score, aplus_score: score.aplus_score,
                  description_score: score.description_score, features_score: score.features_score,
                  overall_score: score.overall_score, issues: score.issues,
                  child_override_count: score.child_override_count,
                }).eq('parent_asin', parent_asin)
              }
            } catch (e) { console.warn('[push-content/details] re-score failed (non-fatal):', e) }
          }

          emit({
            type: 'result',
            parent_asin, field: 'details', detail_field: ctx.detailField, attribute_key: ctx.attribute.spApiKey,
            pushed: accepted, failed, total: results.length,
            message: `Pushed ${ctx.detailField} for ${accepted}/${results.length} variant${results.length === 1 ? '' : 's'}${failed ? `, ${failed} failed` : ''}. Changes typically reflect in 15-30 minutes.`,
            results,
          })
          controller.close(); return
        }

        // ── REGULAR FIELDS branch (title / bullets / description / keywords) ──
        const field: PushField = isPushField(rawField) ? rawField : 'keywords'
        const titleOv = field === 'title' && typeof title_override === 'string' && title_override.trim() ? title_override.trim() : undefined
        const rawDiff = (await loadDiff(parent_asin, field, titleOv)).filter((d) => d.raw != null)
        let diff: DiffRow[]
        // Selective re-push ("push just the stale ones"): FORCE the requested SKUs (+ their FBA/FBM twins
        // by shared ASIN) even if the local cache says they already match. They are stale on AMAZON — the
        // verify checks live state, while the cache was optimistically write-through-updated on the first
        // push. Filtering by `changed` (a cache comparison) here would skip exactly the stragglers the
        // seller is trying to fix -> "Nothing to push" (the live bug the PO hit). A FULL push keeps the
        // changed filter. Twin-by-ASIN inclusion preserves the #36 FBA/FBM parity guarantee.
        if (Array.isArray(skus)) {   // present (even empty) → selective; an empty list pushes NOTHING, never "all"
          const wantSkus = new Set(skus)
          const wantAsins = new Set(rawDiff.filter((d) => wantSkus.has(d.sku) && d.asin).map((d) => d.asin))
          diff = rawDiff.filter((d) => wantSkus.has(d.sku) || (d.asin != null && wantAsins.has(d.asin)))
        } else {
          diff = rawDiff.filter((d) => d.changed)
        }
        if (diff.length === 0) {
          emit({
            type: 'result',
            parent_asin, field, pushed: 0, failed: 0, total: 0,
            message: `Nothing to push — all ${FIELD_CONFIG[field].label.toLowerCase()} already match.`,
            results: [],
          })
          controller.close(); return
        }

        emit({
          type: 'started',
          field, total: diff.length,
          broadcast: FIELD_CONFIG[field].broadcast,
        })

        const token       = await getAccessToken()
        const sellerId    = await getSellerId()
        const productType = await getProductType(sellerId, token, diff[0].sku)
        const attribute   = FIELD_CONFIG[field].attribute
        const supabase    = await createAdminClient()
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const db = supabase as any
        const logPush = async (row: Record<string, unknown>) => {
          try {
            const { error } = await db.from('keyword_push_log').insert(row)
            if (!error) return
            const rest = { ...row }; delete rest.field
            await db.from('keyword_push_log').insert(rest)
          } catch (e) { console.warn('[push-content] keyword_push_log insert failed (migrations 015/016 applied?):', e) }
        }

        const results: { sku: string; status: string; submissionId: string | null; error?: string }[] = []
        for (const item of diff) {
          const value = item.raw as string | string[]
          const newValueStr = asCompare(value)
          emit({ type: 'progress', sku: item.sku, status: 'validating', current: item.current, proposed: newValueStr })
          const preview = await patchSku(sellerId, token, productType, item.sku, attribute, value, 'VALIDATION_PREVIEW')
          if (!preview.ok) {
            results.push({ sku: item.sku, status: 'failed', submissionId: null, error: preview.error })
            emit({ type: 'progress', sku: item.sku, status: 'failed', error: preview.error })
            await logPush({ parent_asin, sku: item.sku, field, previous_value: item.current, new_value: newValueStr, submission_id: null, status: 'failed', error_message: preview.error })
            await sleep(PATCH_DELAY_MS)
            continue
          }
          const live = await patchSku(sellerId, token, productType, item.sku, attribute, value, 'LIVE')
          const status = live.ok ? 'accepted' : 'failed'
          results.push({ sku: item.sku, status, submissionId: live.submissionId, error: live.error })
          emit({ type: 'progress', sku: item.sku, status, submissionId: live.submissionId, error: live.error })
          await logPush({ parent_asin, sku: item.sku, field, previous_value: item.current, new_value: newValueStr, submission_id: live.submissionId, status, error_message: live.ok ? null : live.error })
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

        // Re-score so the page's score reflects the just-pushed values. Best-effort.
        if (accepted > 0) {
          emit({ type: 'rescore', message: 'Re-scoring listing…' })
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
              // Refresh the cached display title alongside the scores. syncListingContent
              // populates listing_seo_scores.product_title from the top child's title at
              // sync time; without this same update on push, the page header + dashboard
              // card show the seller's OLD title for hours/days after a successful push.
              // Pick the top-child's row by asin (matching syncListingContent's logic);
              // fall back to the first row when top_child_asin isn't set yet.
              const topChildRow = (sc?.top_child_asin
                ? rows.find((r) => r.asin === sc.top_child_asin)
                : rows[0]) ?? rows[0]
              const newProductTitle = typeof topChildRow?.title === 'string' ? topChildRow.title : null
              await db.from('listing_seo_scores').update({
                title_score: score.title_score, bullet_score: score.bullet_score,
                keyword_score: score.keyword_score, aplus_score: score.aplus_score,
                description_score: score.description_score, features_score: score.features_score,
                overall_score: score.overall_score, issues: score.issues,
                child_override_count: score.child_override_count,
                product_title: newProductTitle,
              }).eq('parent_asin', parent_asin)
            }
          } catch (e) { console.warn('[push-content] re-score failed (non-fatal):', e) }

          // ── Persist a MANUAL title override AS the recommendation (broadcast-title products only) ──
          // When the seller pushes their OWN title, the live content becomes their title but the stored
          // recommendation is still the AI's. That leaves live != recommendation FOREVER: the cohesion row
          // shows "needs update", and the NEXT ship would push the AI title over the seller's. So we make
          // their pushed title the recommendation — it sticks, cohesion goes green, re-ship is a no-op.
          // Capacity families are excluded (their per-GB titles must not collapse to one string).
          if (field === 'title' && typeof title_override === 'string' && title_override.trim()) {
            try {
              const { data: rt } = await db.from('listing_seo_recommendations').select('per_child_titles').eq('parent_asin', parent_asin).single()
              const isCapFam = Array.isArray(rt?.per_child_titles) && rt.per_child_titles.length > 1
              if (!isCapFam) {
                await db.from('listing_seo_recommendations').update({ recommended_title: title_override.trim().slice(0, 200) }).eq('parent_asin', parent_asin)
              }
            } catch (e) { console.warn('[push-content] persist manual title as recommendation failed (non-fatal):', e) }
          }

          // PERSIST verdict=DONE for the pushed section — ONLY when EVERY pushed SKU succeeded
          // (failed === 0). A push with failures (or a selective re-push where some stragglers still
          // error) must NOT flip the card to DONE, or the seller stops before the field is actually
          // consistent on Amazon (adversarial review). Without persisting, the card snaps back to
          // "Do Now" on the next recommendations refetch — so we persist only when truly fully shipped.
          if (failed === 0) try {
            const { data: recRow } = await db.from('listing_seo_recommendations')
              .select('action_plan').eq('parent_asin', parent_asin).single()
            const plan = Array.isArray(recRow?.action_plan) ? recRow.action_plan as Array<Record<string, unknown>> : null
            if (plan) {
              const isPushed = (el: string) =>
                field === 'title' ? el === 'title'
                : field === 'description' ? el === 'description'
                : field === 'keywords' ? el === 'backend_keywords'
                : field === 'bullets' ? /^bullet_\d+$/.test(el) : false
              const lbl = FIELD_CONFIG[field].label.toLowerCase()
              let changed = false
              for (const it of plan) {
                if (isPushed(String(it.element)) && it.verdict !== 'DONE' && it.verdict !== 'SKIP') {
                  it.verdict = 'DONE'
                  it.current_status = `✓ Shipped to Amazon — live ${lbl} now matches the recommended version.`
                  it.instruction = 'No action required — you pushed this. The copy box stays below if you need it.'
                  if (it.priority !== 'HIGH') it.priority = 'NONE'
                  changed = true
                }
              }
              if (changed) await db.from('listing_seo_recommendations').update({ action_plan: plan }).eq('parent_asin', parent_asin)
            }
          } catch (e) { console.warn('[push-content] persist DONE verdict failed (non-fatal):', e) }
        }

        const label = FIELD_CONFIG[field].label.toLowerCase()
        emit({
          type: 'result',
          parent_asin, field,
          pushed: accepted, failed, total: results.length,
          message: `Pushed ${label} for ${accepted}/${results.length} variant${results.length === 1 ? '' : 's'}${failed ? `, ${failed} failed` : ''}. Changes typically reflect in 15-30 minutes.`,
          results,
        })
        controller.close()
      } catch (err) {
        // Emit a structured error so the client can render it instead of choking.
        // No partial-results aggregation here: any SKU that already streamed a 'progress'
        // event has already informed the client what happened to it.
        emit({ type: 'error', error: err instanceof Error ? err.message : 'Push failed' })
        controller.close()
      }
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson',
      'Transfer-Encoding': 'chunked',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      // Disable nginx buffering on the proxy side so each emit() actually reaches the client
      // immediately. Coolify's default config buffers up to 8KB before flushing.
      'X-Accel-Buffering': 'no',
    },
  })
}
