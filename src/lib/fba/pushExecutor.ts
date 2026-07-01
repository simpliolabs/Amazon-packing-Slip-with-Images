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

import { createAdminClient } from '@/lib/supabase/server'
import { getAccessToken } from '@/lib/amazon/auth'
import {
  FIELD_CONFIG, isPushField, type PushField,
  resolveProposed, currentValue, asCompare, buildPatchValue,
  cacheUpdateFor, getByteLength, capBytes,
} from '@/lib/fba/pushFields'
import {
  resolveDetailAttribute, unpushableReason,
  buildDetailPatchValue, currentDetailValue, normalizeFieldName, detailValueToString,
  type DetailAttribute,
} from '@/lib/fba/productDetailAttrs'
import { coerceDetailValue, inspectProductTypeAttribute, attributeExistsInSchema, containerKeyFallback, getDetailValueShape, buildShapedDetailValue, buildShapedDetailValueVariants, type DetailValueShape } from '@/lib/fba/productTypeDefinitions'
import { scrubTrademarks } from '@/lib/fba/trademarkGuard'
import { logAudit } from '@/lib/audit'
import { fingerprintOf } from '@/lib/keyword-engine/shareSnapshots'  // VERBATIM — outcome-epoch fingerprint
import { appendScoreHistory } from '@/lib/fba/scoreHistory'

// Winning write-form per (productType|attribute), discovered by calibration against Amazon's
// validator. Process-lifetime: schemas are static, so the form that validates once keeps
// validating; a deploy restart just re-calibrates on the next push (one extra preview call).
const _detailFormCache = new Map<string, number>()
import { getProductType, tryGetProductType } from '@/lib/amazon/productType'

// ── Cancellation (streaming pushes) ──────────────────────────────────────────
// PO: "NO way to cancel when it starts." The client sends a cancel_token with the push
// body and POSTs {action:'cancel', cancel_token} to flip it here; the SKU loops check
// between SKUs and stop cleanly (already-accepted SKUs stay pushed — Amazon has them).
// In-memory is correct on this single long-lived container. Queued background jobs are
// separate (cancel those before they start by not queueing / future job-cancel).
const _cancelledPushes = new Set<string>()
export function requestPushCancel(token: string): void { if (token) _cancelledPushes.add(token) }
function pushCancelled(token: string | undefined): boolean {
  if (!token || !_cancelledPushes.has(token)) return false
  _cancelledPushes.delete(token)
  return true
}

export const ENDPOINT       = process.env.AMAZON_ENDPOINT       || 'https://sellingpartnerapi-na.amazon.com'
export const MARKETPLACE_ID = process.env.AMAZON_MARKETPLACE_ID || 'ATVPDKIKX0DER'
const PATCH_DELAY_MS = 200 // Amazon patchListingsItem limit is 5 rps; 200ms keeps us under it.

// ── Attribution (spec §5 Phase B) ─────────────────────────────────────────────
// WHO ran this push. A browser push resolves the actor from the Authorization: Bearer
// JWT (work-log getAuthUser pattern); a cron/verify-initiated push has no user, so it uses
// SYSTEM_ACTOR. `id` is written to keyword_push_log.pushed_by + listing_change_log.changed_by
// (both `uuid REFERENCES auth.users(id)`), so it MUST be null (FK-safe) for the system actor —
// a synthetic uuid would fail the FK and the best-effort insert would silently drop. `name` is
// the denormalized display string the change-log timeline renders, so a system row still reads
// "System (automated push)" instead of an unrenderable blank actor.
export interface PushActor {
  id: string | null      // auth.users.id for a real user; null for the system actor (FK-safe)
  name: string           // denormalized display name for the change-log timeline
}
export const SYSTEM_ACTOR: PushActor = { id: null, name: 'System (automated push)' }

/** Mirror a FULL-ACCEPT push into the product-facing change-log (spec §5 Phase B). Best-effort —
 *  never blocks or fails a push that already wrote to Amazon. `db` is the admin (service-role)
 *  supabase client already in scope. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function logPushChange(db: any, args: {
  parent_asin: string; field: string; actor: PushActor; after_value?: string | null; submission_id?: string | null
}): Promise<void> {
  try {
    await db.from('listing_change_log').insert({
      parent_asin: args.parent_asin,
      sku: null,
      field: args.field,
      action: 'push',
      before_value: null,
      after_value: args.after_value ?? null,
      changed_by: args.actor.id,
      changed_by_name: args.actor.name,
      source: 'push_executor',
      submission_id: args.submission_id ?? null,
    })
  } catch (e) {
    console.warn('[push] change-log insert failed (non-fatal):', e instanceof Error ? e.message : e)
  }
}

/** Stamp the OUTCOME EPOCH at PUSH-COMPLETION (spec §4-E / Risk R3). Called from the SAME full-accept
 *  hinge that mirrors attribution (failed===0 && !cancelled && accepted>0), where parent_asin + the
 *  just-pushed content are in scope — NOT in verificationQueue.completeTask (no parent_asin, has
 *  non-100% exit paths that would strand the listing forever). Upserts listing_outcome_state with the
 *  epoch anchor so the Phase C cron's push-epoch-aware wrapper only measures the copy that just shipped.
 *
 *  `fingerprint` MUST be fingerprintOf() of the just-pushed content (same hash the snapshots store) so
 *  the wrapper's same-fingerprint gate matches. baseline_overall_score is the score right after the
 *  push re-score. A NEW full push RESETS the epoch (re-measure the new copy) — that's the upsert.
 *  Best-effort: NEVER blocks the push (mirrors logPushChange). `listing_key = parent_asin` (the
 *  parent/self-parent grain; standalones self-parent). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function stampOutcomeEpoch(db: any, args: {
  parent_asin: string; fingerprint: string | null; baseline_overall_score: number | null
}): Promise<void> {
  try {
    await db.from('listing_outcome_state').upsert({
      listing_key:            args.parent_asin,
      parent_asin:            args.parent_asin,
      push_epoch_at:          new Date().toISOString(),
      push_epoch_fingerprint: args.fingerprint,
      baseline_overall_score: args.baseline_overall_score,
      snapshots_since_push:   0,
      outcome_verdict:        'measuring',
      verdict_reason:         'measuring 0/2',
      non_copy_lever:         null,
      last_evaluated_at:      null,
      next_evaluable_at:      null,
      resurfaced_at:          null,
    }, { onConflict: 'listing_key' })
  } catch (e) {
    console.warn('[push] outcome-epoch stamp failed (non-fatal):', e instanceof Error ? e.message : e)
  }
}

/** PUBLIC epoch stamp for the AUTONOMOUS RESHIP LOOP (PO H1 safety f): the outcome epoch is stamped
 *  ONLY once the reship loop CONVERGES (all children confirmed live), NOT on every partial reship — so
 *  the measured copy is the version that is actually 100% live. Reads the live top-child content,
 *  computes fingerprintOf() (VERBATIM, same hash the snapshots store), reads the current overall_score
 *  for the baseline, then upserts listing_outcome_state via the same best-effort path as the push hinge.
 *  Never throws — convergence stamping must never break the cron. */
export async function stampOutcomeEpochOnConvergence(parent_asin: string): Promise<boolean> {
  if (!parent_asin) return false
  try {
    const supabase = await createAdminClient()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = supabase as any
    // Resolve the representative (top-child / self) ASIN — the snapshot key the wrapper measures on.
    const { data: sc } = await db.from('listing_seo_scores')
      .select('top_child_asin, overall_score').eq('parent_asin', parent_asin).maybeSingle()
    const topChild = (sc as { top_child_asin: string | null } | null)?.top_child_asin || parent_asin
    const overall = (sc as { overall_score: number | null } | null)?.overall_score ?? null
    const { data: kid } = await db.from('listing_content')
      .select('title, bullet_1, bullet_2, bullet_3, bullet_4, bullet_5, description, backend_keywords')
      .eq('asin', topChild).maybeSingle()
    if (!kid) return false
    const fingerprint = fingerprintOf(kid as never)
    await stampOutcomeEpoch(db, { parent_asin, fingerprint, baseline_overall_score: overall })
    return true
  } catch (e) {
    console.warn('[push] convergence epoch stamp failed (non-fatal):', e instanceof Error ? e.message : e)
    return false
  }
}

export async function getSellerId(): Promise<string> {
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
  /** TRUE when this SKU is NOT a live Amazon listing (not Active in listing_health) — a backfilled/
   *  offerless row. The push SKIPS these: PATCHing a SKU with no live offer makes Amazon CREATE a
   *  phantom "Missing offer" ASIN instead of updating (the 2026-06-16 B0GHH4MQ7N incident). */
  notLive?: boolean
  /** TIER-2 proactive pre-fill (self-healing-push): broadcast attributes the parent hub is KNOWN to
   *  be missing (from push_heal_rules), pre-resolved from a live child, that the push applies to the
   *  parent BEFORE the content PATCH so the hub's re-validation no longer trips the rejection. Read-only
   *  resolution here (loadDiff is also the GET preview path); only the push loop writes them. */
  prefillAttrs?: { spApiKey: string; value: string }[]
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
): Promise<{ sku: string; asin: string }[] | null> {
  // null = the lookup FAILED (HTTP error / exception) — callers must NOT infer "offerless" from a
  // failure. [] = Amazon successfully reported NO seller SKU under this ASIN — a real "this ASIN has
  // no live seller listing" signal (the ground-truth gate's offerless test in loadDiff).
  try {
    const url =
      `${ENDPOINT}/listings/2021-08-01/items/${encodeURIComponent(sellerId)}` +
      `?identifiers=${encodeURIComponent(asin)}&identifiersType=ASIN` +
      `&marketplaceIds=${MARKETPLACE_ID}&includedData=summaries`
    const resp = await fetch(url, { headers: { 'x-amz-access-token': token } })
    if (!resp.ok) return null
    const json = (await resp.json()) as { items?: { sku?: string }[] }
    return (json.items ?? [])
      .map((it) => (it.sku ? { sku: it.sku, asin } : null))
      .filter((x): x is { sku: string; asin: string } => x !== null && !isSystemSku(x.sku))
  } catch { return null }
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
/** TIER-2 PROACTIVE PRE-FILL (self-healing-push): look up learned heal rules for this productType and,
 *  for each 'inherit_from_child' rule, pre-resolve the value from a live child so the caller can attach
 *  it to the parent's payload and ship complete (never trip the rejection again). READ-ONLY (loadDiff
 *  is also the GET preview path — no Amazon writes here). Best-effort: a missing table/row → []. */
async function resolvePrefillAttrs(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any, parentAsin: string, parentSku: string, sellerId: string | null, token: string | null,
): Promise<{ spApiKey: string; value: string }[]> {
  try {
    if (!sellerId || !token) return []
    const productType = await tryGetProductType(sellerId, token, parentSku)
    if (!productType) return []
    const { data: rules } = await db.from('push_heal_rules')
      .select('attr_key, resolution')
      .eq('product_type', productType)
      .eq('resolution', 'inherit_from_child')
    const keys = [...new Set(((rules ?? []) as { attr_key: string }[]).map((r) => r.attr_key))]
      .filter((k) => BROADCAST_HEALABLE.has(k))
    if (keys.length === 0) return []
    // Live child SKUs to inherit from (>=2 for cross-check agreement — same guard as the heal path).
    const { data: childRows } = await db.from('listing_content')
      .select('sku').eq('parent_asin', parentAsin).neq('sku', parentSku)
    const childSkus = [...new Set(((childRows ?? []) as { sku: string }[]).map((r) => r.sku).filter(Boolean))]
    if (childSkus.length < 2) return []
    const out: { spApiKey: string; value: string }[] = []
    for (const spApiKey of keys) {
      const v = await inheritChildValue(sellerId, token, childSkus, spApiKey)
      if (v) out.push({ spApiKey, value: v })
    }
    return out
  } catch (e) {
    console.warn('[push-heal] prefill resolution failed (non-fatal):', e instanceof Error ? e.message : e)
    return []
  }
}

export async function loadDiff(parentAsin: string, field: PushField, titleOverride?: string): Promise<DiffRow[]> {
  const supabase = await createAdminClient()

  const { data: recRow } = await supabase
    .from('listing_seo_recommendations')
    .select('recommended_title, recommended_bullets, recommended_description, recommended_keywords, per_child_titles, per_child_bullets, per_child_descriptions')
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
    /** Per-design bullets/description for multi-design POD families (migration 033). resolveProposed
     *  picks the SKU-specific value when present, otherwise falls back to the broadcast value. */
    per_child_bullets?: { sku: string; asin: string; bullets: string[] }[] | null
    per_child_descriptions?: { sku: string; asin: string; description: string }[] | null
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

  // GROUND-TRUTH PHANTOM GATE (2026-06-16). The push must not PATCH a SKU with no live Amazon
  // listing — doing so makes Amazon CREATE a junk "Missing offer" ASIN (the B0GHH4MQ7N incident).
  // Earlier gates (#260/#262/#263) keyed on the listing_health CACHE — the WRONG signal: it's
  // incomplete for low-traffic/POD listings, so it blanket-skipped 121 REAL live listings on
  // B0FKDDN44Z (#264 reverted them). This gate uses GROUND TRUTH instead: the live Listings-Items
  // lookup (discoverSkusForAsin, already run per ASIN in the enrichment loop below). A row is skipped
  // ONLY when that lookup SUCCEEDS and reports ZERO seller SKUs for the ASIN (= confirmed offerless).
  // A non-empty result = real listing → push; a FAILED lookup or un-probed ASIN = unknown → push
  // (NEVER over-skip on an API hiccup). notLive is set by the post-discovery pass further below.

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
        // Placeholder — the GROUND-TRUTH GATE pass (after the discovery loop) overwrites this: a row
        // is notLive only if Amazon confirms its ASIN has NO seller listing (offerless phantom).
        notLive: false,
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
  // GROUND-TRUTH liveness map populated by the discovery loop: asin → SKUs Amazon reports under it
  // (null = the lookup FAILED, don't infer offerless; [] = Amazon confirms NO seller SKU under it).
  const discoveredByAsin = new Map<string, { sku: string; asin: string }[] | null>()
  try {
    const knownSkus = new Set(baseDiff.map((d) => d.sku))
    // Probe EVERY row's ASIN via Listings Items — this single loop serves BOTH the FBM-twin discovery
    // AND the ground-truth liveness signal the gate uses (it replaces the reverted listing_health
    // gate). Probing ALL rows (not a "live" subset) is required to classify each ASIN.
    const asinsToProbe = [...new Set(baseDiff.map((d) => d.asin).filter((a): a is string => !!a))]
    if (asinsToProbe.length > 0) {
      token = await getAccessToken()
      sellerId = await getSellerId()
      const skuToCurrent = new Map(rows.map((r) => [r.sku, r]))
      for (const asin of asinsToProbe) {
        const discovered = await discoverSkusForAsin(sellerId, token, asin)
        discoveredByAsin.set(asin, discovered)
        for (const d of (discovered ?? [])) {
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

  // ── GROUND-TRUTH GATE: tag confirmed-offerless rows notLive (executePush skips them) ──
  // A row is non-pushable iff its ASIN's live lookup SUCCEEDED and returned ZERO seller SKUs — the
  // offerless backfilled-phantom case (PATCHing it makes Amazon CREATE a "Missing offer" ASIN).
  // Non-empty discovery = real listing → push. null (lookup failed) or un-probed ASIN = unknown →
  // push (never over-skip on an API hiccup — the mistake the listing_health gate made). The PARENT
  // row (added below) isn't in baseDiff yet so it's never tagged; executePush also exempts asin===parent.
  for (const d of baseDiff) {
    const disc = d.asin ? discoveredByAsin.get(d.asin) : undefined
    d.notLive = Array.isArray(disc) && disc.length === 0
  }
  // SAFETY VALVE against the recurring blanket-skip: offerless rows are a small MINORITY of a real
  // family. If this gate would skip HALF OR MORE of the rows, distrust it (discovery rate-limited, or
  // Amazon returning empty en masse, or a stale asin mapping) and push everything — better a rare
  // phantom than blanket-skipping a healthy family AGAIN (the #260/#262/#263 failure mode, 4×).
  const wouldSkip = baseDiff.filter((d) => d.notLive).length
  if (wouldSkip > 0 && wouldSkip >= Math.ceil(baseDiff.length / 2)) {
    for (const d of baseDiff) d.notLive = false
  }

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
          // TIER-2 pre-fill: attach any learned missing-broadcast attrs (resolved from a live child)
          // so the push completes the hub's record BEFORE the content PATCH re-validates it.
          const prefillAttrs = await resolvePrefillAttrs(supabase, parentAsin, parentSku, sellerId, token)
          baseDiff.push({
            sku: parentSku, asin: parentAsin,
            current: '', // we don't cache the parent's content; VALIDATION_PREVIEW is the safety net
            proposed: parentStr,
            raw: parentValue,
            bytes: getByteLength(parentStr),
            chars: parentStr.length,
            changed: true,
            isParent: true,
            prefillAttrs: prefillAttrs.length ? prefillAttrs : undefined,
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
  /** COMPOSITE attributes only (SHIRT neck/closure/sleeve): the schema-derived nesting for the
   *  patch value. The flat shape into a composite is ACCEPTED then silently dropped by Amazon
   *  (live-verified 0/89 applied) — the value must sit on the sub-field the editor reads
   *  (neck.neck_style, sleeve.type, …). null/undefined = flat attribute, legacy builder. */
  valueShape?: DetailValueShape | null
  /** STRICTLY-resolved productType (never the 'PRODUCT' fallback). Resolved ONCE here so the
   *  schema check, enum coercion, value shape, and the per-SKU patches all agree — the live
   *  failure was the push re-resolving on a transient blip, getting generic 'PRODUCT', and
   *  Amazon rejecting all 82 patches ("The provided value for 'neck' is invalid"). */
  productType?: string | null
}

/** Load + validate the audit's recommendation for one detail attribute. Returns null on
 *  unknown / non-pushable detail names so the caller can return a clean 4xx. */
export async function loadDetailContext(parentAsin: string, detailField: string, valueOverride?: string): Promise<{ ctx: DetailContext | null; error: string | null }> {
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
  const details = ((recRow as any)?.product_details_improvements ?? []) as { field_name?: string; recommended_value?: unknown; sp_api_key?: string; attr_scope?: string; pushable?: boolean }[]
  const wanted = normalizeFieldName(detailField)
  const match = details.find((d) => normalizeFieldName(detailValueToString(d.field_name)) === wanted)
  // Historical rows can carry NON-STRING values (the LLM emitted an array/number — crashed
  // the B0GCF11RKL listing page); normalize before any .trim() so the push path never throws.
  const matchValue = detailValueToString(match?.recommended_value)
  if (!match || !matchValue.trim()) {
    return { ctx: null, error: `No AI recommendation found for "${detailField}". Run an AI audit first.` }
  }
  // Resolve the SP-API attribute: prefer the regen-resolved sp_api_key (schema-driven — works for ANY
  // category, not just the apparel map); fall back to the static map. Reject only when neither yields a
  // pushable broadcast attribute.
  let attribute: DetailAttribute | undefined = (match.pushable && match.sp_api_key)
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
  let recommendedValue = (override || matchValue.trim()).slice(0, 1000)
  let acceptedValues: string[] | undefined
  let normalizedFrom: string | undefined
  let enumInvalid = false
  let valueShape: DetailValueShape | null = null
  let resolvedPt: string | null = null
  let hadSku = false

  // ── productType: STRICT, resolved ONCE. The generic 'PRODUCT' fallback poisons everything
  // downstream for details (schema check, enum coercion, value shape, the patches themselves) —
  // live failure: a transient blip right after a deploy resolved 'PRODUCT' and Amazon rejected
  // the whole 82-SKU family ("The provided value for 'neck' is invalid") with a false
  // "not valid for this product type (PRODUCT)" message blaming the recommendation.
  // The enum coercion/shape below stay best-effort (VALIDATION_PREVIEW backstops them).
  try {
    const { data: skuRows } = await supabase
      .from('listing_content')
      .select('sku')
      .eq('parent_asin', parentAsin)
      .limit(1)
    const sku = (skuRows as { sku?: string }[] | null)?.[0]?.sku
    if (sku) {
      hadSku = true
      const token = await getAccessToken()
      const sellerId = await getSellerId()
      resolvedPt = await tryGetProductType(sellerId, token, sku)
      if (resolvedPt) {
        const productType = resolvedPt
        const ptOpts = { token, sellerId, marketplaceId: MARKETPLACE_ID, endpoint: ENDPOINT }
        // CONTAINER FALLBACK: if the resolved key is a suffixed apparel attr (sleeve_type) that
        // isn't in THIS schema, reroute to the container (sleeve) before coercion/shape derivation —
        // so a "Sleeve Type"/"Neck Style" push resolves the same valid composite as bare "Sleeve".
        // Additive: only fires when the primary key is absent (genuine flat-key types are untouched).
        if (!(await attributeExistsInSchema(productType, attribute.spApiKey, ptOpts))) {
          const container = await containerKeyFallback(productType, attribute.spApiKey, ptOpts)
          if (container && container !== attribute.spApiKey) {
            console.log(`[push-content] container fallback: ${attribute.spApiKey} -> ${container} (productType ${productType})`)
            attribute = { ...attribute, spApiKey: container }
          }
        }
        try {
          const c = await coerceDetailValue(productType, attribute.spApiKey, recommendedValue, ptOpts)
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
          // COMPOSITE shape (neck/closure/sleeve): derive the nested patch path from the same
          // schema. Best-effort like the coercion — null keeps the legacy flat builder.
          valueShape = await getDetailValueShape(productType, attribute.spApiKey, ptOpts)
          if (valueShape) {
            console.log(`[push-content] composite attribute ${attribute.spApiKey}: value path ${valueShape.path.join('.')} (productType ${productType})`)
          }
        } catch (err) {
          console.warn('[push-content] enum coercion skipped:', err)
        }
      }
    }
  } catch (err) {
    console.warn('[push-content] detail context prep failed:', err)
  }
  if (hadSku && !resolvedPt) {
    return { ctx: null, error: `Amazon didn't return this listing's product type just now (usually a transient hiccup right after a deploy). Nothing was pushed — try again in a minute.` }
  }

  return { ctx: { detailField, attribute, recommendedValue, acceptedValues, normalizedFrom, enumInvalid, valueShape, productType: resolvedPt }, error: null }
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
/** The full broadcast SKU set for a parent: every child in listing_content + each child's
 *  FBA/FBM twin (twin-name guarded) + the variation parent SKU. Extracted from loadDetailDiff
 *  (behavior-preserving) so the single-field push AND the bulk Auto Push resolve the EXACT
 *  same set from one place — no drift between the two paths. isParent flags the hub row. */
export async function expandDetailSkuSet(
  parentAsin: string, sellerId: string, token: string,
): Promise<{ sku: string; asin: string; isParent: boolean }[]> {
  const supabase = await createAdminClient()
  const { data: rowsRaw } = await supabase
    .from('listing_content')
    .select('sku, asin')
    .eq('parent_asin', parentAsin)
    .order('sku', { ascending: true })
  const rows = (rowsRaw ?? []) as { sku: string; asin: string }[]
  if (rows.length === 0) return []

  const knownSkus = new Set(rows.map((r) => r.sku))
  const expanded: { sku: string; asin: string }[] = [...rows]
  const asinsToProbe = [...new Set(rows.map((r) => r.asin).filter(Boolean))]
  for (const asin of asinsToProbe) {
    const discovered = await discoverSkusForAsin(sellerId, token, asin)
    for (const d of (discovered ?? [])) {
      if (knownSkus.has(d.sku)) continue
      // TWIN-NAME GUARD: only inherit when the discovered SKU's stripped name matches one of
      // our DB rows under this ASIN — avoids pushing to unrelated SKUs sharing the ASIN.
      const discoveredBase = stripFulfillmentSuffix(d.sku)
      const sourceMatch = rows.find((b) => b.asin === asin && stripFulfillmentSuffix(b.sku) === discoveredBase)
      if (!sourceMatch) continue
      expanded.push(d)
      knownSkus.add(d.sku)
    }
  }

  const knownChildSkus = new Set(rows.map((r) => r.sku))
  let parentSku: string | null = null
  try {
    const ps = await findParentSku(sellerId, token, parentAsin)
    if (ps && !knownSkus.has(ps)) { parentSku = ps; expanded.push({ sku: ps, asin: parentAsin }); knownSkus.add(ps) }
  } catch { /* parent enrichment is best-effort */ }

  return expanded.map((r) => ({ sku: r.sku, asin: r.asin, isParent: r.sku === parentSku && !knownChildSkus.has(r.sku) }))
}

export async function loadDetailDiff(parentAsin: string, ctx: DetailContext): Promise<DiffRow[]> {
  const token = await getAccessToken()
  const sellerId = await getSellerId()
  const expanded = await expandDetailSkuSet(parentAsin, sellerId, token)
  if (expanded.length === 0) return []

  // Build the diff: one row per SKU, current fetched live, proposed = recommendedValue.
  const proposedStr = ctx.recommendedValue
  const isParentSet = new Set(expanded.filter((r) => r.isParent).map((r) => r.sku))

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


// A structured SP-API listings issue. Amazon returns code + attributeNames alongside message; the
// auto-heal layer needs those to identify WHICH attribute was rejected (self-healing-push).
export type AmazonIssue = { code?: string; message?: string; severity?: string; attributeNames?: string[] }
type PatchResult = { ok: boolean; submissionId: string | null; error?: string; issues?: AmazonIssue[] }
// One per-SKU push outcome. `issues` carries the STRUCTURED Amazon rejection (code + attributeNames)
// so the auto-heal layer can act on a parent rejection without re-parsing the message string.
type PushResultRow = { sku: string; status: string; submissionId: string | null; error?: string; isParent?: boolean; issues?: AmazonIssue[] }

/** Parse an SP-API PATCH response's issues[] ONCE, keeping the STRUCTURED error issues (code +
 *  attributeNames), not just the joined message — so auto-heal can act on the specific missing
 *  attribute. ok:true means the submission validated clean. */
function parsePatchIssues(json: { status?: string; submissionId?: string; issues?: AmazonIssue[] }): PatchResult {
  const errorIssues = (json.issues ?? []).filter((i) => i.severity === 'ERROR')
  if (json.status === 'INVALID' || errorIssues.length > 0) {
    return {
      ok: false,
      submissionId: json.submissionId ?? null,
      error: errorIssues.map((i) => i.message).join('; ') || 'Validation INVALID',
      issues: errorIssues,
    }
  }
  return { ok: true, submissionId: json.submissionId ?? null }
}

// ─── PATCH one SKU's attribute (validation-preview, then live) ──────────────────
async function patchSku(
  sellerId: string, token: string, productType: string, sku: string,
  attribute: string, value: string | string[], mode: 'VALIDATION_PREVIEW' | 'LIVE',
): Promise<PatchResult> {
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
  return parsePatchIssues(await resp.json() as Parameters<typeof parsePatchIssues>[0])
}

/** Read the productType once from the first child (variation families share one type). */
// getProductType moved to @/lib/amazon/productType (shared + process-cached for consistent enum
// resolution). Imported above; both loadDetailContext and the ?debug branch use the shared version.

// ─── PATCH one SKU's DETAIL attribute (validation-preview, then live) ──────────
async function patchSkuDetail(
  sellerId: string, token: string, productType: string, sku: string,
  attribute: DetailAttribute, value: string, mode: 'VALIDATION_PREVIEW' | 'LIVE',
  valueShape?: DetailValueShape | null,
  /** Calibrated patch value (a specific write-form variant) — overrides the builders. */
  patchValue?: Record<string, unknown>[],
): Promise<PatchResult> {
  const body = {
    productType,
    patches: [{ op: 'replace', path: `/attributes/${attribute.spApiKey}`,
      // Composite attributes (SHIRT neck/closure/sleeve) need the value on their schema
      // sub-field — the flat shape is accepted then silently dropped (0/89 applied live).
      value: patchValue ?? (valueShape
        ? buildShapedDetailValue(valueShape, value, MARKETPLACE_ID)
        : buildDetailPatchValue(attribute, value, MARKETPLACE_ID)) }],
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
  return parsePatchIssues(await resp.json() as Parameters<typeof parsePatchIssues>[0])
}

// ─── DETERMINISTIC AUTO-HEAL — inherit a missing BROADCAST attribute onto the parent hub ───────
// The non-buyable variation PARENT (e.g. Custom-Cup-TS-Parent) gets rejected on EVERY content/detail
// PATCH when a required BROADCAST attribute (shirt_size#?.size_system / size_class, department,
// age_range_description) is missing on the hub while its CHILDREN carry valid values. We READ a live
// child's value and PATCH it onto the parent (VALIDATION_PREVIEW → LIVE). GUARDRAILS: broadcast-scope
// ONLY (never per-variant color/size/capacity); a passing VALIDATION_PREVIEW gates every LIVE write;
// ABSTAIN when children DISAGREE or none carries the value; everything is best-effort/non-throwing.

/** Broadcast-scoped attribute keys the auto-heal is allowed to inherit onto the parent hub. STRICTLY
 *  the parent-shared attributes whose absence rejects the hub — NEVER per-variant axes (color/size/
 *  capacity) whose value differs per child. `shirt_size` is the composite container carrying the
 *  size_system/size_class sub-fields the Custom-apparel hub is missing. */
const BROADCAST_HEALABLE = new Set<string>([
  'size_system', 'size_class', 'department', 'age_range_description', 'shirt_size',
])

/** The outcome of one heal pass over a parent hub. `healed` = attrs written live; `abstained` =
 *  skipped on child disagreement / no child value / non-broadcast; `failed` = validation or write
 *  rejected. Never thrown — the caller (cron/trigger) rides the queue's attempts/backoff on failures. */
export interface HealResult { healed: string[]; abstained: string[]; failed: string[] }

/** Read one broadcast attribute's value from each child; return the agreed value or null.
 *  ABSTAIN (null) when NO child carries it OR children DISAGREE — never guess a hub value. */
async function inheritChildValue(
  sellerId: string, token: string, childSkus: string[], spApiKey: string,
): Promise<string | null> {
  const seen = new Set<string>()
  for (const sku of childSkus) {
    const v = (await fetchCurrentDetail(sellerId, token, sku, spApiKey)).trim()
    if (v) seen.add(v)
    await sleep(PATCH_DELAY_MS)
  }
  if (seen.size !== 1) return null   // 0 = none carries it; >1 = children disagree → abstain
  return [...seen][0]
}

/**
 * Inherit missing BROADCAST attributes from live children onto the variation parent hub, so the
 * hub stops rejecting every PATCH. Best-effort and NON-THROWING: any failure is captured in the
 * returned buckets, never propagated. On a live-accepted heal it upserts a push_heal_rules row
 * (resolution 'inherit_from_child') so the Tier-2 pre-fill ships the value on future pushes.
 */
export async function healParentAttributes(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  args: { parent_asin: string; parentSku: string; productType: string; missingAttrKeys: string[] },
): Promise<HealResult> {
  const { parent_asin, parentSku, productType, missingAttrKeys } = args
  const out: HealResult = { healed: [], abstained: [], failed: [] }
  // Only broadcast-scoped, schema-known keys are eligible — the guardrail against writing a
  // per-variant axis (color/size) onto the shared hub.
  const eligible = [...new Set(missingAttrKeys)].filter((k) => BROADCAST_HEALABLE.has(k))
  const nonEligible = [...new Set(missingAttrKeys)].filter((k) => !BROADCAST_HEALABLE.has(k))
  out.abstained.push(...nonEligible)
  if (!parent_asin || !parentSku || !productType || eligible.length === 0) return out

  try {
    const token = await getAccessToken()
    const sellerId = await getSellerId()
    const ptOpts = { token, sellerId, marketplaceId: MARKETPLACE_ID, endpoint: ENDPOINT }

    // Live child SKUs of the family (exclude the parent hub itself). Need >=2 to trust an inherited
    // value (a single child can't be cross-checked for agreement) — abstain on the whole heal otherwise.
    const { data: childRows } = await db.from('listing_content')
      .select('sku')
      .eq('parent_asin', parent_asin)
      .neq('sku', parentSku)
    const childSkus = [...new Set(((childRows ?? []) as { sku: string }[]).map((r) => r.sku).filter(Boolean))]
    if (childSkus.length < 2) { out.abstained.push(...eligible); return out }

    for (const spApiKey of eligible) {
      try {
        const inherited = await inheritChildValue(sellerId, token, childSkus, spApiKey)
        if (!inherited) { out.abstained.push(spApiKey); continue }   // disagreement / none carries it
        const attribute: DetailAttribute = { spApiKey, scope: 'broadcast' }
        // Composite container (shirt_size) needs the value on its schema sub-field; flat attrs keep
        // the legacy builder. Best-effort like the push path (VALIDATION_PREVIEW backstops it).
        let valueShape: DetailValueShape | null = null
        try { valueShape = await getDetailValueShape(productType, spApiKey, ptOpts) } catch { /* flat */ }

        const preview = await patchSkuDetail(sellerId, token, productType, parentSku, attribute, inherited, 'VALIDATION_PREVIEW', valueShape)
        if (!preview.ok) { out.failed.push(spApiKey); await sleep(PATCH_DELAY_MS); continue }
        const live = await patchSkuDetail(sellerId, token, productType, parentSku, attribute, inherited, 'LIVE', valueShape)
        if (!live.ok) { out.failed.push(spApiKey); await sleep(PATCH_DELAY_MS); continue }

        out.healed.push(spApiKey)
        // Attribute write log (SYSTEM_ACTOR — pushed_by null, FK-safe). Best-effort.
        try {
          await db.from('keyword_push_log').insert({
            parent_asin, sku: parentSku, field: `heal:${spApiKey}`,
            previous_value: null, new_value: inherited,
            submission_id: live.submissionId, status: 'accepted', error_message: null,
            pushed_by: SYSTEM_ACTOR.id,
          })
        } catch (e) { console.warn('[push-heal] keyword_push_log insert failed (non-fatal):', e instanceof Error ? e.message : e) }
        // Learn the rule so the Tier-2 pre-fill ships it complete next time. hit_count increments on repeat.
        try {
          const { data: existing } = await db.from('push_heal_rules')
            .select('hit_count').eq('product_type', productType).eq('attr_key', spApiKey).maybeSingle()
          const prevHits = (existing as { hit_count?: number } | null)?.hit_count ?? 0
          await db.from('push_heal_rules').upsert({
            product_type: productType, attr_key: spApiKey,
            sub_keys: valueShape ? valueShape.path : [],
            resolution: 'inherit_from_child', resolved_value: null,
            last_seen_at: new Date().toISOString(), hit_count: prevHits + 1,
          }, { onConflict: 'product_type,attr_key' })
        } catch (e) { console.warn('[push-heal] push_heal_rules upsert failed (non-fatal):', e instanceof Error ? e.message : e) }
        await sleep(PATCH_DELAY_MS)
      } catch (e) {
        console.warn(`[push-heal] heal of ${spApiKey} threw (non-fatal):`, e instanceof Error ? e.message : e)
        out.failed.push(spApiKey)
      }
    }
  } catch (e) {
    console.warn('[push-heal] healParentAttributes prep failed (non-fatal):', e instanceof Error ? e.message : e)
    // Any eligible attr we didn't get to is neither healed nor failed deterministically — leave it
    // for the next attempt by marking abstained (the queue's attempts/backoff decides retry vs stop).
    for (const k of eligible) if (!out.healed.includes(k) && !out.failed.includes(k)) out.abstained.push(k)
  }
  return out
}

/** PATCH MULTIPLE attributes on one SKU in a SINGLE submission (the bulk Auto Push efficiency
 *  core — Amazon's patchListingsItem accepts many ops per call). Each op is a fully-built
 *  {op,path,value}. Amazon validates the submission ATOMICALLY: any ERROR-severity issue →
 *  status INVALID and NOTHING applies — so the caller previews first and falls back to
 *  per-attribute pushes when a batch preview fails, preserving failure isolation. */
async function patchSkuMulti(
  sellerId: string, token: string, productType: string, sku: string,
  ops: { op: 'replace'; path: string; value: unknown }[], mode: 'VALIDATION_PREVIEW' | 'LIVE',
): Promise<PatchResult> {
  if (ops.length === 0) return { ok: true, submissionId: null }
  const body = { productType, patches: ops }
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
  return parsePatchIssues(await resp.json() as Parameters<typeof parsePatchIssues>[0])
}

/** Read ONE SKU's listing once and extract the CURRENT value of many attributes from that
 *  single response — the bulk differ reads each SKU once (not once per field). Best-effort:
 *  a fetch failure returns {} so every field reads as '' (→ treated as changed → pushed, the
 *  preview then guards correctness); never throws, never silently skips a SKU. */
async function fetchSkuDetails(
  sellerId: string, token: string, sku: string, spApiKeys: string[],
): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  try {
    const url =
      `${ENDPOINT}/listings/2021-08-01/items/${sellerId}/${encodeURIComponent(sku)}` +
      `?marketplaceIds=${MARKETPLACE_ID}&includedData=attributes`
    const resp = await fetch(url, { headers: { 'x-amz-access-token': token } })
    if (!resp.ok) return out
    const json = (await resp.json()) as { attributes?: Record<string, unknown> }
    for (const k of spApiKeys) out[k] = currentDetailValue(json.attributes ?? null, k)
  } catch { /* leave out empty → fields read as changed → preview-guarded push */ }
  return out
}

// ─── The push engine — shared by the streaming route and background jobs ───────
// Extracted verbatim from the POST handler of push-content/route.ts (PR #184) so
// the SAME battle-tested loop powers both delivery modes:
//   - streaming: the route wraps emit() around controller.enqueue (NDJSON to browser)
//   - jobs:      src/lib/fba/pushJobs.ts wraps emit() around push_jobs DB updates
// Event vocabulary (one emit per event):
//   {type:'started',  field, detail_field?, attribute_key?, total, broadcast}
//   {type:'progress', sku, status:'validating'|'accepted'|'failed', error?, submissionId?, current?, proposed?}
//   {type:'rescore',  message}
//   {type:'result',   pushed, failed, total, message, results, field, detail_field?, attribute_key?}
//   {type:'error',    error, results?}   — terminal; never thrown, always emitted
// executePush NEVER throws and NEVER returns a value: terminal failures emit {type:'error'}.

/** Params for one push execution — identical to the POST body minus `confirm`. */
export interface PushParams {
  parent_asin: string
  field?: string
  detail_field?: string
  skus?: string[]
  title_override?: string
  detail_value_override?: string
  /** Client-generated id for this push; POST {action:'cancel', cancel_token} stops the loop
   *  between SKUs (already-accepted SKUs stay pushed — they're Amazon's now). */
  cancel_token?: string
  /** Bulk Auto Push (field==='details_bulk'): the friendly detail names to push together,
   *  batched per SKU into one PATCH each (7× fewer Amazon calls than field-at-a-time). */
  detail_fields?: string[]
  /** Per-field value overrides for the bulk push (PO edits a wrong value before pushing).
   *  Keyed by friendly field name; each is re-validated/coerced by loadDetailContext, so a
   *  bad manual value is flagged enumInvalid → that field is skipped, never pushed. */
  detail_overrides?: Record<string, string>
  /** WHO is running this push (spec §5 Phase B attribution). Resolved from the Bearer JWT at the
   *  route, or SYSTEM_ACTOR for cron/verify. Threaded into keyword_push_log.pushed_by + (on a
   *  full-accept push) listing_change_log + a narrow logAudit('listing.push'). Defaults to
   *  SYSTEM_ACTOR when absent so a row never carries an unrenderable NULL actor name. */
  actor?: PushActor
}

/** Which of `eligibleFields` differ from the SKU's live value (so the batch touches only what
 *  needs changing — the property that makes a re-run after a partial failure idempotent: an
 *  already-correct field reads equal and is skipped). Pure + exported for unit tests. Compares
 *  trimmed strings; an unknown current (read failure → undefined) counts as CHANGED (push,
 *  preview guards), matching the single-field path's empty-current behavior. */
export function changedDetailFields(
  currents: Record<string, string | undefined>,
  desired: Record<string, string>,
  eligibleFields: string[],
): string[] {
  return eligibleFields.filter((f) => {
    const want = (desired[f] ?? '').trim()
    if (!want) return false
    return (currents[f] ?? '').trim() !== want
  })
}

export type PushEmit = (obj: Record<string, unknown>) => void

/**
 * Summarize a push over a variation family. We DO push the non-buyable variation PARENT (hub) — its
 * title/bullets/description/attributes are part of the displayed record and most parents accept the
 * patch (this restores the pre-#244 behavior; #244 blanket-skipped ALL parents to fix one Amazon
 * Custom family whose incomplete Shirt Size made its record reject the patch, which silently stopped
 * EVERY normal parent from updating — the regression the PO caught). But a parent rejection must not
 * make the push read "broken", so pass/fail is computed over the buyable CHILDREN and the parent's
 * own outcome is surfaced as a separate, non-blocking note. `results` rows are tagged isParent.
 */
function summarizePush(results: { status: string; isParent?: boolean }[]): {
  accepted: number; failed: number; childTotal: number; parentNote: string
} {
  const children = results.filter((r) => !r.isParent)
  const parent = results.find((r) => r.isParent)
  const accepted = children.filter((r) => r.status === 'accepted').length
  const failed = children.filter((r) => r.status === 'failed').length
  const parentNote =
    parent?.status === 'accepted'
      ? ' (Variation parent hub also updated.)'
      : parent?.status === 'failed'
        ? ' (The variation parent hub was rejected — usually an incomplete required attribute like its Shirt Size System/Class; complete it in Seller Central. The buyable variants shoppers see were updated.)'
        : ''
  return { accepted, failed, childTotal: children.length, parentNote }
}

/** If the variation PARENT row FAILED with a rejection naming a BROADCAST-healable attribute, enqueue
 *  a self-heal task (migration 042 kind='heal'). Non-blocking and best-effort — it NEVER flips the
 *  push outcome (the parentNote stays the seller-facing signal); it just schedules the cron to inherit
 *  the missing attribute from a live child. No-op when the parent accepted, or its issues name only
 *  per-variant / non-broadcast attributes (those can't be safely inherited onto the shared hub). */
async function maybeEnqueueParentHeal(
  parent_asin: string, productType: string | null, results: PushResultRow[],
): Promise<void> {
  try {
    if (!productType) return
    const parent = results.find((r) => r.isParent && r.status === 'failed')
    if (!parent?.sku || !parent.issues?.length) return
    const missing = [...new Set(parent.issues.flatMap((i) => i.attributeNames ?? []))]
      .filter((k) => BROADCAST_HEALABLE.has(k))
    if (missing.length === 0) return
    const { enqueueHeal } = await import('@/lib/fba/verificationQueue')
    await enqueueHeal(parent_asin, { parentSku: parent.sku, productType, missingAttrKeys: missing })
  } catch (e) {
    console.warn('[push-heal] enqueue trigger failed (non-fatal):', e instanceof Error ? e.message : e)
  }
}

export async function executePush(params: PushParams, emit: PushEmit): Promise<void> {
  const { parent_asin, field: rawField, detail_field: detailField, skus, title_override, detail_value_override } = params
  // WHO ran this push — for keyword_push_log.pushed_by + the full-accept change-log mirror.
  // Defaults to SYSTEM_ACTOR (cron/verify path) so a row never carries a NULL actor name.
  const actor: PushActor = params.actor ?? SYSTEM_ACTOR
  try {
        // ── DETAILS branch ─────────────────────────────────────────────────────
        if (rawField === 'details') {
          const { ctx, error } = await loadDetailContext(parent_asin, detailField || '', detail_value_override)
          if (!ctx) { emit({ type: 'error', error }); return }
          if (ctx.enumInvalid) {
            // Uncoercible dropdown and no valid override picked -> refuse the write (never push a non-member).
            emit({ type: 'error', error: `"${ctx.recommendedValue}" is not an accepted Amazon value for "${ctx.detailField}". Pick one of the accepted values${ctx.acceptedValues?.length ? `: ${ctx.acceptedValues.slice(0, 25).join(', ')}` : ''}.` })
            return
          }
          // Push the parent hub too (its attributes are part of the displayed record). summarizePush()
          // scopes pass/fail to the buyable children, so a parent that rejects the patch (an Amazon
          // Custom family with incomplete Shirt Size) is a non-blocking note rather than blanket-skipped
          // — the over-generalization (#244/#245) that stopped normal parents from updating.
          const rawDetailDiff = await loadDetailDiff(parent_asin, ctx)
          const diff = rawDetailDiff.filter((d) => d.changed && d.raw != null)
          if (diff.length === 0) {
            emit({
              type: 'result',
              parent_asin, field: 'details', detail_field: ctx.detailField, attribute_key: ctx.attribute.spApiKey,
              pushed: 0, failed: 0, total: 0,
              message: `Nothing to push — every SKU already has ${ctx.detailField} = "${ctx.recommendedValue}".`,
              results: [],
            })
            return
          }
          emit({
            type: 'started',
            field: 'details', detail_field: ctx.detailField, attribute_key: ctx.attribute.spApiKey,
            total: diff.length, broadcast: true,
          })
          const token = await getAccessToken()
          const sellerId = await getSellerId()
          // STRICT type from the context (resolved once, never the 'PRODUCT' fallback) — the
          // schema check, the coerced value, the value shape, and these patches must all agree.
          let productType = ctx.productType ?? null
          if (!productType) productType = await tryGetProductType(sellerId, token, diff[0].sku)
          if (!productType) {
            emit({ type: 'error', error: `Amazon didn't return this listing's product type just now (usually a transient hiccup right after a deploy). Nothing was pushed — try again in a minute.` })
            return
          }
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
            return
          }
          const supabase = await createAdminClient()
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const db = supabase as any
          const logPush = async (rowIn: Record<string, unknown>) => {
            const row: Record<string, unknown> = { ...rowIn, pushed_by: actor.id }  // attribution (spec §5 Phase B)
            try {
              const { error: insertErr } = await db.from('keyword_push_log').insert(row)
              if (!insertErr) return
              const rest = { ...row }; delete rest.field
              const { error: error2 } = await db.from('keyword_push_log').insert(rest)
              if (error2) console.error('[push-content/details] keyword_push_log insert FAILED both attempts — ship date will be missing. first:', insertErr?.message ?? insertErr, '| second:', error2?.message ?? error2)
            } catch (e) { console.error('[push-content/details] keyword_push_log insert threw:', e) }
          }

          // ── CALIBRATE the write form against Amazon's own validator (composites only) ──
          // Reading the schema statically guessed wrong on SHIRT neck (every patch INVALID,
          // live 2026-06-12): the same sub-field can be a {value,language_tag} object, a bare
          // enum string, or a oneOf union of both. VALIDATION_PREVIEW performs no write — so
          // probe the variants on the FIRST SKU, use the survivor for the whole family, and
          // refuse loudly if Amazon rejects them all (no more 82-row failure cascades).
          let calibratedValueFor: ((v: string) => Record<string, unknown>[] | undefined) = () => undefined
          if (ctx.valueShape) {
            const shape = ctx.valueShape
            const formKey = `${productType}|${ctx.attribute.spApiKey}`
            const variants = buildShapedDetailValueVariants(shape, ctx.recommendedValue, MARKETPLACE_ID)
            let winIdx = _detailFormCache.has(formKey) ? (_detailFormCache.get(formKey) as number) : -1
            if (winIdx < 0 || winIdx >= variants.length) {
              winIdx = -1
              let lastErr: string | undefined
              for (let i = 0; i < variants.length; i++) {
                emit({ type: 'progress', sku: diff[0].sku, status: 'validating', current: diff[0].current, proposed: ctx.recommendedValue })
                const probe = await patchSkuDetail(sellerId, token, productType, diff[0].sku, ctx.attribute, ctx.recommendedValue, 'VALIDATION_PREVIEW', shape, variants[i].value)
                if (probe.ok) { winIdx = i; _detailFormCache.set(formKey, i); break }
                lastErr = probe.error
                await sleep(PATCH_DELAY_MS)
              }
              if (winIdx < 0) {
                emit({ type: 'error', error: `Amazon's validator rejected every known write form for "${ctx.detailField}" (${ctx.attribute.spApiKey}) — nothing was pushed to any SKU. Amazon's message: ${lastErr ?? '(none)'}` })
                return
              }
              console.log(`[push-content] calibrated ${formKey} -> write form "${variants[winIdx].id}"`)
            }
            calibratedValueFor = (v: string) => buildShapedDetailValueVariants(shape, v, MARKETPLACE_ID)[winIdx]?.value
          }

          const results: PushResultRow[] = []
          let cancelled = false
          for (const item of diff) {
            if (pushCancelled(params.cancel_token)) { cancelled = true; break }
            const isParent = item.asin === parent_asin
            const newValueStr = ctx.recommendedValue
            emit({ type: 'progress', sku: item.sku, status: 'validating', current: item.current, proposed: newValueStr })
            const preview = await patchSkuDetail(sellerId, token, productType, item.sku, ctx.attribute, newValueStr, 'VALIDATION_PREVIEW', ctx.valueShape, calibratedValueFor(newValueStr))
            if (!preview.ok) {
              // Amazon's pre-launch wall: the attribute is in the schema + Seller Central form, but
              // Listings-API writes stay refused until the July 27, 2026 launch. Say so plainly
              // instead of leaving the seller to decode Amazon's "refer to the tool tip".
              const friendlyErr = preview.error && /currently unsupported/i.test(preview.error)
                ? `${preview.error} — Amazon hasn't opened API writes for this attribute yet (full launch July 27, 2026). The value is generated and saved; push it again once Amazon enables the field.`
                : preview.error
              results.push({ sku: item.sku, status: 'failed', submissionId: null, error: friendlyErr, isParent, issues: preview.issues })
              emit({ type: 'progress', sku: item.sku, status: 'failed', error: friendlyErr })
              await logPush({ parent_asin, sku: item.sku, field: `details:${ctx.attribute.spApiKey}`, previous_value: item.current, new_value: newValueStr, submission_id: null, status: 'failed', error_message: friendlyErr })
              await sleep(PATCH_DELAY_MS)
              continue
            }
            const live = await patchSkuDetail(sellerId, token, productType, item.sku, ctx.attribute, newValueStr, 'LIVE', ctx.valueShape, calibratedValueFor(newValueStr))
            const status = live.ok ? 'accepted' : 'failed'
            results.push({ sku: item.sku, status, submissionId: live.submissionId, error: live.error, isParent, issues: live.issues })
            emit({ type: 'progress', sku: item.sku, status, submissionId: live.submissionId, error: live.error })
            await logPush({ parent_asin, sku: item.sku, field: `details:${ctx.attribute.spApiKey}`, previous_value: item.current, new_value: newValueStr, submission_id: live.submissionId, status, error_message: live.ok ? null : live.error })
            await sleep(PATCH_DELAY_MS)
          }

          // Pass/fail over the buyable CHILDREN; the parent hub's outcome is a non-blocking note.
          const { accepted, failed, childTotal, parentNote } = summarizePush(results)

          // SELF-HEAL trigger (self-healing-push): a parent hub rejected on a missing BROADCAST
          // attribute (the shirt_size#?.size_system/size_class case) schedules the cron to inherit it
          // from a live child. Non-blocking; parentNote unchanged.
          await maybeEnqueueParentHeal(parent_asin, productType, results)

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
                  // recommended_value too: a seller-picked override (or an enum coercion) IS the
                  // recommendation of record once pushed — without this the panel showed the stale
                  // audit value forever and the "✓ On Amazon" equality badge could never light up.
                  p.current_value = ctx.recommendedValue; p.recommended_value = ctx.recommendedValue; p.enum_valid = true; touched = true
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
                  scored_at: new Date().toISOString(),  // freshness stamp — was stuck at the last full Sync
                }).eq('parent_asin', parent_asin)
                // Phase C §4-D: append a push-trigger score-history change-point. NOTE: a DETAILS push
                // (e.g. fabric_type) does NOT change the content COPY, so we do NOT stamp/reset the
                // outcome epoch here (the copy under measurement is unchanged); we only record the score
                // move. Fingerprint the current content so the row still JOINs the snapshots by value.
                const topRow = (sc?.top_child_asin ? rows.find((r) => r.asin === sc.top_child_asin) : rows[0]) ?? parentOwn ?? rows[0]
                await appendScoreHistory(db, {
                  parent_asin,
                  overall_score: score.overall_score,
                  title_score: score.title_score, bullet_score: score.bullet_score,
                  keyword_score: score.keyword_score, aplus_score: score.aplus_score,
                  description_score: score.description_score, features_score: score.features_score,
                  issues: Array.isArray(score.issues) ? (score.issues as unknown[]) : null,
                }, { trigger: 'push', scoredBy: actor.id, scoredByName: actor.name, content: topRow as never })
              }
            } catch (e) { console.warn('[push-content/details] re-score failed (non-fatal):', e) }
          }

          // AUTO-VERIFY queue: register a follow-up verify in ~20 min (within Amazon's 15-30 min
          // application window). The cron at /api/fba/cron-verify-pushes will check live state +
          // re-push stale SKUs until 100% applied or max_attempts hit (PO directive 2026-06-13).
          // Wrapped in try/catch — a queue failure (e.g. migration 030 not applied yet) MUST NOT
          // break a successful push.
          if (accepted > 0 && !cancelled) {
            try {
              const { enqueueVerification } = await import('@/lib/fba/verificationQueue')
              await enqueueVerification({
                parent_asin, field: `details:${ctx.attribute.spApiKey}`,
                detail_field: ctx.detailField, expected_value: ctx.recommendedValue,
              })
            } catch (e) { console.warn('[push-content/details] verify enqueue failed (non-fatal):', e) }
          }

          // ATTRIBUTION (spec §5 Phase B): a FULL-ACCEPT push mirrors a product-facing change-log row
          // (action='push', source='push_executor') + a NARROW compliance audit (listing.push as a
          // write-to-Amazon event). Best-effort — never blocks a push that already wrote to Amazon.
          if (failed === 0 && !cancelled && accepted > 0) {
            await logPushChange(db, {
              parent_asin, field: `details:${ctx.attribute.spApiKey}`, actor,
              after_value: ctx.recommendedValue,
              submission_id: results.find((r) => r.status === 'accepted')?.submissionId ?? null,
            })
            await logAudit({
              userId: actor.id, action: 'listing.push', resourceType: 'listing', resourceId: parent_asin,
              details: { field: `details:${ctx.attribute.spApiKey}`, detail_field: ctx.detailField, accepted, by: actor.name },
            })
          }

          emit({
            type: 'result',
            parent_asin, field: 'details', detail_field: ctx.detailField, attribute_key: ctx.attribute.spApiKey,
            pushed: accepted, failed, total: childTotal, cancelled: cancelled || undefined,
            message: cancelled
              ? `Stopped by you — ${accepted}/${childTotal} accepted before the stop stay pushed; ${diff.length - results.length} SKU${diff.length - results.length === 1 ? '' : 's'} untouched.`
              : `Pushed ${ctx.detailField} for ${accepted}/${childTotal} variant${childTotal === 1 ? '' : 's'}${failed ? `, ${failed} failed` : ''}.${parentNote} Changes typically reflect in 15-30 minutes.`,
            results,
          })
          return
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

        // UPDATE-ONLY GATE (action): never PATCH a SKU that isn't a live Amazon listing — that makes
        // Amazon CREATE a phantom "Missing offer" ASIN instead of updating. loadDiff tags offerless/
        // backfilled rows notLive (not Active in listing_health). The variation PARENT is exempt (its
        // push is intentional and summarizePush treats a parent rejection as a non-blocking note).
        // Applies to BOTH the full and selective paths — even an explicit re-push must not create.
        const skippedNotLive = diff.filter((d) => d.notLive && d.asin !== parent_asin)
        if (skippedNotLive.length > 0) diff = diff.filter((d) => !(d.notLive && d.asin !== parent_asin))
        // The variation PARENT is pushed too (PO 2026-06-15): its displayed title/bullets/description
        // are part of the family record and most parents accept the patch — #244 blanket-skipping ALL
        // parents (to fix one Amazon Custom family whose incomplete Shirt Size made its record reject
        // the patch) silently stopped every NORMAL parent from updating. summarizePush() scopes pass/
        // fail to the buyable children and reports a parent-only rejection as a non-blocking note.
        if (diff.length === 0) {
          emit({
            type: 'result',
            parent_asin, field, pushed: 0, failed: 0, total: 0,
            message: skippedNotLive.length > 0
              ? `Nothing pushed — ${skippedNotLive.length} variant${skippedNotLive.length === 1 ? '' : 's'} skipped because ${skippedNotLive.length === 1 ? "it isn't" : "they aren't"} a live Amazon listing yet (Missing offer/incomplete). Complete the offer${skippedNotLive.length === 1 ? '' : 's'} in Seller Central, then re-push.`
              : `Nothing to push — all ${FIELD_CONFIG[field].label.toLowerCase()} already match.`,
            results: skippedNotLive.map((d) => ({ sku: d.sku, status: 'skipped', submissionId: null, error: 'Not a live Amazon listing yet (Missing offer/incomplete) — skipped so the push cannot create a phantom. Complete its offer in Seller Central, then re-push.' })),
          })
          return
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
        const logPush = async (rowIn: Record<string, unknown>) => {
          const row: Record<string, unknown> = { ...rowIn, pushed_by: actor.id }  // attribution (spec §5 Phase B)
          try {
            const { error } = await db.from('keyword_push_log').insert(row)
            if (!error) return
            // The first attempt may fail because the migration-016 `field` column is absent — retry
            // without it. BUT check THAT error too: supabase-js RETURNS errors (doesn't throw), so an
            // unchecked second insert hid every real failure (table/column/constraint) → no ship date,
            // no signal (PO: "pushed keywords, still no date"). Surface it loudly now.
            const rest = { ...row }; delete rest.field
            const { error: error2 } = await db.from('keyword_push_log').insert(rest)
            if (error2) console.error('[push-content] keyword_push_log insert FAILED both attempts — ship date will be missing. first:', error?.message ?? error, '| second:', error2?.message ?? error2)
          } catch (e) { console.error('[push-content] keyword_push_log insert threw:', e) }
        }

        const results: PushResultRow[] = []
        let cancelled = false
        for (const item of diff) {
          if (pushCancelled(params.cancel_token)) { cancelled = true; break }
          const isParent = item.asin === parent_asin
          // TIER-2 PRE-FILL: complete the parent hub's known-missing broadcast attributes (learned in
          // push_heal_rules, pre-resolved from a live child in loadDiff) BEFORE the content PATCH, so
          // the hub's re-validation no longer trips the rejection. Best-effort, VALIDATION_PREVIEW-gated;
          // a failure here never blocks the content push (the heal cron is the backstop).
          if (isParent && item.prefillAttrs?.length) {
            for (const pf of item.prefillAttrs) {
              try {
                const attr: DetailAttribute = { spApiKey: pf.spApiKey, scope: 'broadcast' }
                const ptOpts = { token, sellerId, marketplaceId: MARKETPLACE_ID, endpoint: ENDPOINT }
                let shape: DetailValueShape | null = null
                try { shape = await getDetailValueShape(productType, pf.spApiKey, ptOpts) } catch { /* flat */ }
                const pv = await patchSkuDetail(sellerId, token, productType, item.sku, attr, pf.value, 'VALIDATION_PREVIEW', shape)
                if (pv.ok) { await patchSkuDetail(sellerId, token, productType, item.sku, attr, pf.value, 'LIVE', shape); await sleep(PATCH_DELAY_MS) }
              } catch (e) { console.warn('[push-heal] prefill patch failed (non-fatal):', e instanceof Error ? e.message : e) }
            }
          }
          // SCRUB-AT-PUSH backstop (batch 2/6): trademark-scrub the value at the moment of publish,
          // so a MANUALLY-typed mark (the title-override box bypasses the generation-time scrub #240)
          // or any stale stored content can never be WRITTEN to Amazon as a protected term ("World
          // Cup" → "World Soccer Cup"). Idempotent — already-scrubbed generated content is unchanged.
          // Applied to both shapes: title/description/keywords (string) + bullets (string[]).
          const rawValue = item.raw as string | string[]
          const value = Array.isArray(rawValue) ? rawValue.map(scrubTrademarks) : scrubTrademarks(rawValue)
          const newValueStr = asCompare(value)
          emit({ type: 'progress', sku: item.sku, status: 'validating', current: item.current, proposed: newValueStr })
          const preview = await patchSku(sellerId, token, productType, item.sku, attribute, value, 'VALIDATION_PREVIEW')
          if (!preview.ok) {
            results.push({ sku: item.sku, status: 'failed', submissionId: null, error: preview.error, isParent, issues: preview.issues })
            emit({ type: 'progress', sku: item.sku, status: 'failed', error: preview.error })
            await logPush({ parent_asin, sku: item.sku, field, previous_value: item.current, new_value: newValueStr, submission_id: null, status: 'failed', error_message: preview.error })
            await sleep(PATCH_DELAY_MS)
            continue
          }
          const live = await patchSku(sellerId, token, productType, item.sku, attribute, value, 'LIVE')
          const status = live.ok ? 'accepted' : 'failed'
          results.push({ sku: item.sku, status, submissionId: live.submissionId, error: live.error, isParent, issues: live.issues })
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

        // Pass/fail over the buyable CHILDREN; the parent hub's outcome is a non-blocking note.
        const { accepted, failed, childTotal, parentNote } = summarizePush(results)

        // SELF-HEAL trigger (self-healing-push): if the parent hub was rejected on a missing BROADCAST
        // attribute, schedule the cron to inherit it from a live child. Non-blocking; parentNote unchanged.
        await maybeEnqueueParentHeal(parent_asin, productType, results)

        // Re-score so the page's score reflects the just-pushed values. Best-effort.
        // Phase C: capture the just-pushed content fingerprint + post-push overall score here (where
        // the fresh top-child content is in hand) so the full-accept hinge can stamp the OUTCOME EPOCH
        // (§4-E) and the push-trigger score-history row (§4-D) both use this EXACT measured copy.
        let pushedFingerprint: string | null = null
        let pushedOverall: number | null = null
        // B-fix: re-score whenever the family's LIVE content is confirmed — including a re-push where the
        // children were already current so only the variation parent was attempted (childTotal===0).
        // Gating the re-score on accepted>0 froze the score on exactly that case (parent-only push whose
        // parent Amazon rejects, PO-caught: "if it fails it does not update the score"). The DESTRUCTIVE
        // side-effects (manual-title-as-rec, DONE verdict, auto-verify enqueue, outcome stamp) stay on the
        // stricter accepted>0 / failed===0 gates below. The empty-diff early return upstream already
        // prevents a re-score when the push wrote literally nothing, so this never runs on a no-op.
        const shouldRescore = accepted > 0 || childTotal === 0
        if (shouldRescore) {
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
                scored_at: new Date().toISOString(),  // freshness stamp — was stuck at the last full Sync
              }).eq('parent_asin', parent_asin)

              // Phase C: fingerprint the measured copy (fingerprintOf VERBATIM → JOINs the snapshots)
              // and conditionally append a push-trigger score-history change-point row.
              pushedFingerprint = fingerprintOf((topChildRow ?? parentOwn ?? rows[0]) as never)
              pushedOverall = typeof score.overall_score === 'number' ? score.overall_score : null
              await appendScoreHistory(db, {
                parent_asin,
                overall_score: score.overall_score,
                title_score: score.title_score, bullet_score: score.bullet_score,
                keyword_score: score.keyword_score, aplus_score: score.aplus_score,
                description_score: score.description_score, features_score: score.features_score,
                issues: Array.isArray(score.issues) ? (score.issues as unknown[]) : null,
              }, { trigger: 'push', scoredBy: actor.id, scoredByName: actor.name, fingerprint: pushedFingerprint })
            }
          } catch (e) { console.warn('[push-content] re-score failed (non-fatal):', e) }
        }

        // Below stays on the STRICT accepted>0 gate — these are destructive (rewrite the stored
        // recommendation / flip the plan verdict to DONE) and must only fire when a child actually shipped.
        if (accepted > 0) {
          // ── Persist a MANUAL title override AS the recommendation (broadcast-title products only) ──
          // When the seller pushes their OWN title, the live content becomes their title but the stored
          // recommendation is still the AI's. That leaves live != recommendation FOREVER: the cohesion row
          // shows "needs update", and the NEXT ship would push the AI title over the seller's. So we make
          // their pushed title the recommendation — it sticks, cohesion goes green, re-ship is a no-op.
          // Capacity families are excluded (their per-GB titles must not collapse to one string).
          if (!cancelled && field === 'title' && typeof title_override === 'string' && title_override.trim()) {
            try {
              const { data: rt } = await db.from('listing_seo_recommendations').select('per_child_titles').eq('parent_asin', parent_asin).single()
              const isCapFam = Array.isArray(rt?.per_child_titles) && rt.per_child_titles.length > 1
              if (!isCapFam) {
                await db.from('listing_seo_recommendations').update({ recommended_title: title_override.trim().slice(0, 200) }).eq('parent_asin', parent_asin)
              }
            } catch (e) { console.warn('[push-content] persist manual title as recommendation failed (non-fatal):', e) }
          }

          // PERSIST verdict=DONE for the pushed section — ONLY when EVERY pushed SKU succeeded
          // (failed === 0) AND the push wasn't cancelled mid-way (a stopped push has untouched
          // SKUs — failed===0 would lie DONE onto an incomplete field). A push with failures
          // (or a selective re-push where some stragglers still error) must NOT flip the card to
          // DONE, or the seller stops before the field is actually consistent on Amazon.
          if (failed === 0 && !cancelled) try {
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

        // AUTO-VERIFY queue (regular fields): register a follow-up verify in ~20 min. Cron
        // re-pushes stale SKUs until 100% applied (PO directive 2026-06-13). Wrapped: queue
        // failure must not break a successful push.
        if (accepted > 0 && !cancelled) {
          try {
            const { enqueueVerification } = await import('@/lib/fba/verificationQueue')
            await enqueueVerification({ parent_asin, field })
          } catch (e) { console.warn('[push-content] verify enqueue failed (non-fatal):', e) }
        }

        // ATTRIBUTION (spec §5 Phase B): a FULL-ACCEPT push mirrors a product-facing change-log row
        // (action='push', source='push_executor') + a NARROW compliance audit (listing.push). The
        // exact pushed bytes live in keyword_push_log; this row is the WHO/WHEN/action timeline.
        // Phase C (§4-E / Risk R3): the SAME full-accept hinge stamps the OUTCOME EPOCH — push_epoch_at
        // = now, push_epoch_fingerprint = fingerprintOf(just-pushed content) computed above during the
        // re-score, baseline_overall_score = the post-push score, verdict='measuring'. A new full push
        // RESETS the epoch (upsert) to re-measure the new copy. Best-effort, never blocks the push.
        if (failed === 0 && !cancelled && accepted > 0) {
          await logPushChange(db, {
            parent_asin, field, actor,
            after_value: field === 'title' ? (titleOv ?? null) : null,
            submission_id: results.find((r) => r.status === 'accepted')?.submissionId ?? null,
          })
          await logAudit({
            userId: actor.id, action: 'listing.push', resourceType: 'listing', resourceId: parent_asin,
            details: { field, accepted, by: actor.name },
          })
          await stampOutcomeEpoch(db, { parent_asin, fingerprint: pushedFingerprint, baseline_overall_score: pushedOverall })
        }

        const label = FIELD_CONFIG[field].label.toLowerCase()
        const skippedNote = skippedNotLive.length > 0
          ? ` ${skippedNotLive.length} skipped (not a live Amazon listing yet — Missing offer/incomplete; complete their offer in Seller Central, then re-push).`
          : ''
        const skippedResults: typeof results = skippedNotLive.map((d) => ({ sku: d.sku, status: 'skipped', submissionId: null, error: 'Not a live Amazon listing yet (Missing offer/incomplete) — skipped so the push cannot create a phantom. Complete its offer in Seller Central, then re-push.' }))
        emit({
          type: 'result',
          parent_asin, field,
          pushed: accepted, failed, total: childTotal, cancelled: cancelled || undefined,
          message: cancelled
            ? `Stopped by you — ${accepted}/${childTotal} accepted before the stop stay pushed; ${diff.length - results.length} SKU${diff.length - results.length === 1 ? '' : 's'} untouched.`
            : `Pushed ${label} for ${accepted}/${childTotal} variant${childTotal === 1 ? '' : 's'}${failed ? `, ${failed} failed` : ''}.${parentNote}${skippedNote} Changes typically reflect in 15-30 minutes.`,
          results: [...results, ...skippedResults],
        })
      } catch (err) {
        // Emit a structured error so the caller can render it instead of choking.
        // No partial-results aggregation here: any SKU that already emitted a 'progress'
        // event has already informed the caller what happened to it.
        emit({ type: 'error', error: err instanceof Error ? err.message : 'Push failed' })
      }
}

// ─── BULK Auto Push: all selected detail attributes, batched PER SKU ───────────
// PO efficiency ask: pushing 7 fields field-at-a-time = 7 × N-SKUs × 2 Amazon calls. Batching
// all changed attributes for ONE SKU into ONE PATCH = N-SKUs × 2 — ~7× fewer calls, ~7× faster,
// far less throttle/deploy-restart exposure. Amazon validates a submission ATOMICALLY (one bad
// attribute → the whole SKU's PATCH is rejected), so this preserves the single-field path's
// failure isolation via a PER-FIELD FALLBACK: preview the batch; if Amazon rejects it, push that
// SKU's fields one-at-a-time so the good ones still land and only the bad one fails for that SKU.
// Fully idempotent: it reads each SKU's live values first and batches ONLY the fields that differ,
// so a re-run after any partial failure touches only the still-wrong SKUs.
interface BulkFieldPlan {
  field: string                 // friendly name (the modal's row id)
  attribute: DetailAttribute
  value: string
  valueShape: DetailValueShape | null
  /** Calibrated patch value for this field's value, or undefined (flat builder). */
  patchValue?: Record<string, unknown>[]
}

export async function executeBulkDetailsPush(params: PushParams, emit: PushEmit): Promise<void> {
  const { parent_asin, detail_fields, detail_overrides } = params
  const actor: PushActor = params.actor ?? SYSTEM_ACTOR  // attribution (spec §5 Phase B)
  try {
    const fields = (detail_fields ?? []).filter((f) => typeof f === 'string' && f.trim())
    if (fields.length === 0) { emit({ type: 'error', error: 'No fields selected for Auto Push.' }); return }

    const token = await getAccessToken()
    const sellerId = await getSellerId()
    const ptOpts = { token, sellerId, marketplaceId: MARKETPLACE_ID, endpoint: ENDPOINT }

    // ── PHASE 0 — pre-flight each field (no writes): resolve ctx (strict productType, coerced
    //    value, shape, enum-validity) + confirm the attribute exists in THIS schema. A field that
    //    can't be pushed is RECORDED with a reason and EXCLUDED — it never blocks the others.
    const skipped: { field: string; reason: string }[] = []
    const plans: BulkFieldPlan[] = []
    let productType: string | null = null
    for (const f of fields) {
      const { ctx, error } = await loadDetailContext(parent_asin, f, detail_overrides?.[f])
      if (!ctx) { skipped.push({ field: f, reason: error || 'not pushable' }); continue }
      if (ctx.enumInvalid) { skipped.push({ field: f, reason: `"${ctx.recommendedValue}" isn't an accepted Amazon value — set it via the single Ship picker` }); continue }
      productType = productType ?? ctx.productType ?? null
      plans.push({ field: f, attribute: ctx.attribute, value: ctx.recommendedValue, valueShape: ctx.valueShape ?? null })
    }
    if (!productType) {
      emit({ type: 'error', error: skipped.length ? `Nothing to push. ${skipped.map((s) => `${s.field}: ${s.reason}`).join(' · ')}` : 'Could not resolve the product type — try again in a minute.' })
      return
    }
    // Drop fields whose attribute isn't in THIS product type's schema (apparel attr on the wrong PT).
    const checkedPlans: BulkFieldPlan[] = []
    for (const p of plans) {
      if (await attributeExistsInSchema(productType, p.attribute.spApiKey, ptOpts)) checkedPlans.push(p)
      else skipped.push({ field: p.field, reason: `not a valid attribute for ${productType}` })
    }
    if (checkedPlans.length === 0) {
      emit({ type: 'error', error: `Nothing to push. ${skipped.map((s) => `${s.field}: ${s.reason}`).join(' · ')}` })
      return
    }

    // ── PHASE 1 — SKU set (one resolution) + each SKU's CURRENT values (one GET per SKU). ──
    const skuSetRaw = await expandDetailSkuSet(parent_asin, sellerId, token)
    // Drop the non-buyable variation PARENT (asin === parent_asin) — it can never accept a content/
    // detail PATCH (Amazon re-validates its whole record + rejects on incomplete required attributes),
    // so counting it as a target produced a permanent partial-fail. Buyable children carry everything.
    const bulkParentDropped = skuSetRaw.some((s) => s.asin === parent_asin)
    const skuSet = skuSetRaw.filter((s) => s.asin !== parent_asin)
    if (skuSet.length === 0) { emit({ type: 'error', error: 'No SKUs found for this parent. Run a Sync first.' }); return }
    const spKeys = checkedPlans.map((p) => p.attribute.spApiKey)

    // ── PHASE 2 — calibrate each composite's write-form ONCE (reuse the validator-probe + cache).
    //    A field that can't calibrate is excluded (others proceed) — never a whole-run abort.
    for (const p of checkedPlans) {
      if (!p.valueShape) { p.patchValue = buildDetailPatchValue(p.attribute, p.value, MARKETPLACE_ID) as unknown as Record<string, unknown>[]; continue }
      const formKey = `${productType}|${p.attribute.spApiKey}`
      const variants = buildShapedDetailValueVariants(p.valueShape, p.value, MARKETPLACE_ID)
      let winIdx = _detailFormCache.has(formKey) ? (_detailFormCache.get(formKey) as number) : -1
      if (winIdx < 0 || winIdx >= variants.length) {
        winIdx = -1
        for (let i = 0; i < variants.length; i++) {
          const probe = await patchSkuMulti(sellerId, token, productType, skuSet[0].sku,
            [{ op: 'replace', path: `/attributes/${p.attribute.spApiKey}`, value: variants[i].value }], 'VALIDATION_PREVIEW')
          if (probe.ok) { winIdx = i; _detailFormCache.set(formKey, i); break }
          await sleep(PATCH_DELAY_MS)
        }
      }
      if (winIdx < 0) { skipped.push({ field: p.field, reason: 'Amazon rejected every known write form (calibration failed)' }); p.patchValue = undefined; p.value = '__CALIBRATION_FAILED__' }
      else p.patchValue = variants[winIdx].value
    }
    const livePlans = checkedPlans.filter((p) => p.value !== '__CALIBRATION_FAILED__')
    if (livePlans.length === 0) {
      emit({ type: 'error', error: `Nothing to push. ${skipped.map((s) => `${s.field}: ${s.reason}`).join(' · ')}` })
      return
    }

    const desired: Record<string, string> = {}
    for (const p of livePlans) desired[p.attribute.spApiKey] = p.value
    const opFor = (p: BulkFieldPlan) => ({ op: 'replace' as const, path: `/attributes/${p.attribute.spApiKey}`,
      value: p.patchValue ?? buildDetailPatchValue(p.attribute, p.value, MARKETPLACE_ID) })

    emit({ type: 'started', mode: 'details_bulk', fields: livePlans.map((p) => p.field), skipped, total: skuSet.length, broadcast: true })

    const supabase = await createAdminClient()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = supabase as any
    const logPush = async (rowIn: Record<string, unknown>) => {
      const row: Record<string, unknown> = { ...rowIn, pushed_by: actor.id }  // attribution (spec §5 Phase B)
      try { const { error } = await db.from('keyword_push_log').insert(row); if (!error) return
        const rest = { ...row }; delete rest.field; const { error: error2 } = await db.from('keyword_push_log').insert(rest)
        if (error2) console.error('[bulk-details] keyword_push_log insert FAILED both attempts — ship date will be missing. first:', error?.message ?? error, '| second:', error2?.message ?? error2)
      } catch (e) { console.error('[bulk-details] keyword_push_log insert threw:', e) }
    }

    // per-field tallies + which fields actually changed at least one SKU (drives write-through).
    const tally: Record<string, { accepted: number; failed: number }> = {}
    for (const p of livePlans) tally[p.field] = { accepted: 0, failed: 0 }
    let cancelled = false
    let skusTouched = 0

    // ── PHASE 3 — per SKU: read current, batch the CHANGED fields, preview→live, per-field fallback.
    for (const s of skuSet) {
      if (pushCancelled(params.cancel_token)) { cancelled = true; break }
      const currents = await fetchSkuDetails(sellerId, token, s.sku, spKeys)
      const changedKeys = changedDetailFields(currents, desired, spKeys)
      if (changedKeys.length === 0) { emit({ type: 'progress', sku: s.sku, status: 'skipped' }); continue }   // already correct — one event per SKU so the progress bar still reaches 100%
      skusTouched++
      const changedPlans = livePlans.filter((p) => changedKeys.includes(p.attribute.spApiKey))
      emit({ type: 'progress', sku: s.sku, status: 'validating', fields: changedPlans.map((p) => p.field) })

      const ops = changedPlans.map(opFor)
      const preview = await patchSkuMulti(sellerId, token, productType, s.sku, ops, 'VALIDATION_PREVIEW')
      let perFieldStatus: { field: string; spApiKey: string; ok: boolean; submissionId: string | null; error?: string }[]

      if (preview.ok) {
        const live = await patchSkuMulti(sellerId, token, productType, s.sku, ops, 'LIVE')
        if (live.ok) {
          perFieldStatus = changedPlans.map((p) => ({ field: p.field, spApiKey: p.attribute.spApiKey, ok: true, submissionId: live.submissionId }))
        } else {
          // Valid preview but live rejected (race / throttle) → isolate per field for THIS sku.
          perFieldStatus = await pushPerFieldFallback(sellerId, token, productType, s.sku, changedPlans)
        }
      } else {
        // Atomic batch rejected (≥1 bad attribute) → per-field so the good ones still land.
        perFieldStatus = await pushPerFieldFallback(sellerId, token, productType, s.sku, changedPlans)
      }

      for (const r of perFieldStatus) {
        tally[r.field][r.ok ? 'accepted' : 'failed']++
        await logPush({ parent_asin, sku: s.sku, field: `details:${r.spApiKey}`, previous_value: currents[r.spApiKey] ?? '', new_value: desired[r.spApiKey], submission_id: r.submissionId, status: r.ok ? 'accepted' : 'failed', error_message: r.ok ? null : r.error })
      }
      const skuFailed = perFieldStatus.filter((r) => !r.ok)
      emit({ type: 'progress', sku: s.sku, status: skuFailed.length === 0 ? 'accepted' : (skuFailed.length === perFieldStatus.length ? 'failed' : 'partial'),
        fields: changedPlans.map((p) => p.field), failedFields: skuFailed.map((r) => r.field), error: skuFailed[0]?.error })
      await sleep(PATCH_DELAY_MS)
    }

    // ── PHASE 4 — write-through (per field with ≥1 accept) + ONE re-score for the whole batch.
    const acceptedFields = livePlans.filter((p) => tally[p.field].accepted > 0)
    if (acceptedFields.length > 0) {
      try {
        const { data: recR } = await db.from('listing_seo_recommendations').select('product_details_improvements').eq('parent_asin', parent_asin).single()
        const pdi = ((recR?.product_details_improvements ?? []) as Record<string, unknown>[])
        let touched = false
        for (const p of acceptedFields) {
          const wantField = normalizeFieldName(p.field)
          for (const row of pdi) {
            if (normalizeFieldName(String(row.field_name ?? '')) === wantField) { row.current_value = p.value; row.recommended_value = p.value; row.enum_valid = true; touched = true }
          }
        }
        if (touched) await db.from('listing_seo_recommendations').update({ product_details_improvements: pdi }).eq('parent_asin', parent_asin)
      } catch (e) { console.warn('[bulk-details] write-through failed (non-fatal):', e) }

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
            title_score: score.title_score, bullet_score: score.bullet_score, keyword_score: score.keyword_score,
            aplus_score: score.aplus_score, description_score: score.description_score, features_score: score.features_score,
            overall_score: score.overall_score, issues: score.issues, child_override_count: score.child_override_count,
            scored_at: new Date().toISOString(),
          }).eq('parent_asin', parent_asin)
          // Phase C §4-D: append a push-trigger score-history change-point. A BULK-DETAILS push changes
          // attributes, NOT content COPY, so (like the single-details branch) we do NOT stamp/reset the
          // outcome epoch — only the score move is recorded. Fingerprint current content so it JOINs.
          const topRow = (sc?.top_child_asin ? rows.find((r) => r.asin === sc.top_child_asin) : rows[0]) ?? parentOwn ?? rows[0]
          await appendScoreHistory(db, {
            parent_asin,
            overall_score: score.overall_score,
            title_score: score.title_score, bullet_score: score.bullet_score,
            keyword_score: score.keyword_score, aplus_score: score.aplus_score,
            description_score: score.description_score, features_score: score.features_score,
            issues: Array.isArray(score.issues) ? (score.issues as unknown[]) : null,
          }, { trigger: 'push', scoredBy: actor.id, scoredByName: actor.name, content: topRow as never })
        }
      } catch (e) { console.warn('[bulk-details] re-score failed (non-fatal):', e) }

      // AUTO-VERIFY queue (bulk): one task per detail field that got at least one accept.
      // Cron re-pushes stale SKUs until 100% applied (PO directive 2026-06-13). Wrapped:
      // a queue failure must not break a successful bulk push.
      if (!cancelled) try {
        const { enqueueVerification } = await import('@/lib/fba/verificationQueue')
        for (const p of acceptedFields) {
          await enqueueVerification({
            parent_asin, field: `details:${p.attribute.spApiKey}`,
            detail_field: p.field, expected_value: p.value,
          })
        }
      } catch (e) { console.warn('[bulk-details] verify enqueue failed (non-fatal):', e) }
    }

    const perField = [
      ...livePlans.map((p) => ({ field: p.field, accepted: tally[p.field].accepted, failed: tally[p.field].failed })),
      ...skipped.map((s) => ({ field: s.field, accepted: 0, failed: 0, skippedReason: s.reason })),
    ]
    const totalAccepted = livePlans.reduce((n, p) => n + tally[p.field].accepted, 0)
    const totalFailed = livePlans.reduce((n, p) => n + tally[p.field].failed, 0)

    // ATTRIBUTION (spec §5 Phase B): a FULL-ACCEPT bulk push mirrors a change-log row per accepted
    // field (action='push', source='push_executor') + ONE narrow logAudit('listing.push') for the
    // batch. Best-effort — never blocks a push that already wrote to Amazon.
    if (totalFailed === 0 && !cancelled && totalAccepted > 0) {
      for (const p of acceptedFields) {
        await logPushChange(db, { parent_asin, field: `details:${p.attribute.spApiKey}`, actor, after_value: p.value })
      }
      await logAudit({
        userId: actor.id, action: 'listing.push', resourceType: 'listing', resourceId: parent_asin,
        details: { mode: 'details_bulk', fields: acceptedFields.map((p) => p.field), accepted: totalAccepted, by: actor.name },
      })
    }
    emit({
      type: 'result', mode: 'details_bulk', parent_asin, perField,
      pushed: totalAccepted, failed: totalFailed, total: skusTouched, cancelled: cancelled || undefined,
      message: cancelled
        ? `Stopped by you — ${skusTouched} SKU(s) processed before the stop; accepted fields stay pushed, the rest are untouched.`
        : `Auto Push done — ${livePlans.length} field(s) across ${skusTouched} SKU(s) that needed it${skipped.length ? `; ${skipped.length} field(s) skipped` : ''}.${bulkParentDropped ? ' (Variation parent skipped — non-buyable hub.)' : ''} Changes reflect in 15min–6hr; use Verify live to confirm.`,
    })
  } catch (err) {
    emit({ type: 'error', error: err instanceof Error ? err.message : 'Auto Push failed' })
  }
}

/** Per-field fallback for ONE SKU when the atomic batch is rejected — push each field's single
 *  attribute alone so the valid ones still land and only the offending one fails for this SKU. */
async function pushPerFieldFallback(
  sellerId: string, token: string, productType: string, sku: string,
  plans: BulkFieldPlan[],
): Promise<{ field: string; spApiKey: string; ok: boolean; submissionId: string | null; error?: string }[]> {
  const out: { field: string; spApiKey: string; ok: boolean; submissionId: string | null; error?: string }[] = []
  for (const p of plans) {
    const preview = await patchSkuDetail(sellerId, token, productType, sku, p.attribute, p.value, 'VALIDATION_PREVIEW', p.valueShape, p.patchValue)
    if (!preview.ok) {
      const friendly = preview.error && /currently unsupported/i.test(preview.error)
        ? `${preview.error} — Amazon hasn't opened API writes for this attribute yet (launch July 27, 2026).`
        : preview.error
      out.push({ field: p.field, spApiKey: p.attribute.spApiKey, ok: false, submissionId: null, error: friendly })
      await sleep(PATCH_DELAY_MS); continue
    }
    const live = await patchSkuDetail(sellerId, token, productType, sku, p.attribute, p.value, 'LIVE', p.valueShape, p.patchValue)
    out.push({ field: p.field, spApiKey: p.attribute.spApiKey, ok: live.ok, submissionId: live.submissionId, error: live.error })
    await sleep(PATCH_DELAY_MS)
  }
  return out
}
