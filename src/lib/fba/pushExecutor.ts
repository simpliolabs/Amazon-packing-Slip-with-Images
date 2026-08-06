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
import { spApiWriteBucket, spApiReadBucket } from '@/lib/fba/spApiRateLimiter'
import { reconcileFamilyChildren } from '@/lib/fba/familyReconcile'
import { getAccessToken } from '@/lib/amazon/auth'
import {
  FIELD_CONFIG, isPushField, type PushField, PUSH_FIELDS,
  resolveProposed, currentValue, asCompare, buildPatchValue,
  cacheUpdateFor, getByteLength, capBytes, dedupByAsin, buildCoreOps,
  titlePushBlocked,
} from '@/lib/fba/pushFields'
import {
  resolveDetailAttribute, unpushableReason,
  buildDetailPatchValue, currentDetailValue, normalizeFieldName, detailValueToString,
  setItemHighlightsApiState, isItemHighlightsField,
  isItemHighlightTitleTooLongError, ITEM_HIGHLIGHT_TITLE_TOO_LONG_MSG,
  isSingleDesignOnlyKey, SINGLE_DESIGN_ONLY_LEAK_REASON,
  type DetailAttribute, type ItemHighlightsApiState,
} from '@/lib/fba/productDetailAttrs'
import { resolveMultiDesign } from '@/lib/fba/perDesign'
import type { SupabaseClient } from '@supabase/supabase-js'
import { coerceDetailValue, inspectProductTypeAttribute, attributeExistsInSchema, containerKeyFallback, getDetailValueShape, buildShapedDetailValue, buildShapedDetailValueVariants, bustProductTypeSchemaCache, applyLiveDetailSubfieldHint, type DetailValueShape } from '@/lib/fba/productTypeDefinitions'
import { calibrateVariants } from '@/lib/fba/detailCalibration'
import { scrubTrademarks } from '@/lib/fba/trademarkGuard'
import { scrubCelebrityNames } from '@/lib/fba/celebrityGuard'
import { logAudit } from '@/lib/audit'
import { fingerprintOf } from '@/lib/keyword-engine/shareSnapshots'  // VERBATIM — outcome-epoch fingerprint
import { appendScoreHistory } from '@/lib/fba/scoreHistory'
import { pickRescoreRepresentative } from '@/lib/fba/rescoreRepresentative'
// PURE heal-decision helpers (adversarial review 2026-07-02): dependency-free so the sandbox can
// smoke the destructive/escalation gates standalone — see healEvidence.ts's module doc.
import {
  compositeItemCarries, subsetDeepEqual, classifyDeletePreviewFailure,
  findCompleteWriteEvidence, HEAL_EVIDENCE_WINDOW_MS, HEAL_EVIDENCE_MAX_ROWS,
  runNegotiationLoop, verifyNegotiationReadBack,
  type CompositeItem, type NegotiationOp,
} from '@/lib/fba/healEvidence'

// Winning write-form per (productType|attribute), discovered by calibration against Amazon's
// validator. Process-lifetime: schemas are static, so the form that validates once keeps
// validating; a deploy restart just re-calibrates on the next push (one extra preview call).
// Keyed by the variant's stable ID (not its index): the variant LIST is value-dependent now —
// each candidate sub-field only emits variants when the pushed value coerces into ITS
// vocabulary — so an index cached under one value could point at a DIFFERENT form for another.
const _detailFormCache = new Map<string, string>()
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
  accepted?: number; failed?: number   // counts so a PARTIAL push reads "…to 133/148 variants" (migration 044)
}): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const base: Record<string, any> = {
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
  }
  try {
    // supabase-js returns { error } (does NOT throw) on an unknown column, so a lagging migration 044
    // would SILENTLY drop the push row — the exact "history didn't show my push" bug. On any insert
    // error, retry WITHOUT the count columns so the push STILL appears (counts are a nice-to-have).
    const { error } = await db.from('listing_change_log').insert({ ...base, accepted_count: args.accepted ?? null, failed_count: args.failed ?? null })
    if (error) {
      const { error: e2 } = await db.from('listing_change_log').insert(base)
      if (e2) console.warn('[push] change-log insert failed (non-fatal):', e2.message)
    }
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
  /** TIER-2 proactive pre-fill (self-healing-push): the parent hub's known-missing broadcast attrs are
   *  resolved (live SP-API GETs) + written LAZILY in the push loop (executePush), never on the modal-open
   *  GET preview path (adversarial review 2026-06-28). loadDiff only flags the parent row via isParent;
   *  no prefill data rides the DiffRow, so the GET path issues ZERO SP-API GETs for prefill. */
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
export async function discoverSkusForAsin(
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
    await spApiReadBucket.acquire()   // global 5-rps ceiling for getListingsItem reads (task #23) — 1 token per GET
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
    await spApiReadBucket.acquire()   // global 5-rps ceiling for getListingsItem reads (task #23) — 1 token per GET
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
 *  it to the parent's payload and ship complete (never trip the rejection again). READ-ONLY (no Amazon
 *  writes), but it DOES issue live SP-API GETs (productType + child attributes), so it is GATED:
 *
 *  `resolve=false` → return [] immediately with ZERO SP-API calls. loadDiff passes false because it is
 *  ALSO the modal-open GET preview path — a preview must never fan out N live GETs + sleeps (adversarial
 *  review 2026-06-28). `resolve=true` → do the full resolution; only executePush (the PUSH path) passes
 *  true, lazily, right before the parent content PATCH. Best-effort: a missing table/row → []. */
/** A resolved Tier-2 pre-fill entry. `flat` = a scalar broadcast attr (department/age_range) written via
 *  the shaped detail builder. `composite` = a verbatim-mirrored composite container (shirt_size) whose
 *  `value` is the ready-to-PATCH array — written raw via patchSkuMulti so NO shape builder reshapes the
 *  child's own sub-objects (the same fail-safe payload the heal path builds). */
type PrefillEntry =
  | { kind: 'flat'; spApiKey: string; value: string }
  | { kind: 'composite'; containerKey: string; value: unknown[] }

async function resolvePrefillAttrs(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any, parentAsin: string, parentSku: string, sellerId: string | null, token: string | null,
  resolve: boolean,
): Promise<PrefillEntry[]> {
  try {
    if (!resolve) return []   // GET-path guard: no SP-API from the modal-open preview
    if (!sellerId || !token) return []
    const productType = await tryGetProductType(sellerId, token, parentSku)
    if (!productType) return []
    // PRE-FILL SAFETY (heal v2 delete-partial): this filter selects ONLY 'inherit_from_child' rules —
    // rules with resolution 'delete_partial_container' are DELIBERATELY SKIPPED (ignored). Pre-fill runs
    // on EVERY future parent push and must NEVER delete anything: the one-time delete is owned by the
    // REACTIVE heal (healParentComposite strategy 2, read-back-verified). A learned delete rule means the
    // hub's partial container was removed and the conditional rejection no longer fires — re-ADDING the
    // container here would re-trip it, and issuing deletes from a pre-fill would be an unguarded
    // destructive write on every push.
    const { data: rules } = await db.from('push_heal_rules')
      .select('attr_key, resolution')
      .eq('product_type', productType)
      .eq('resolution', 'inherit_from_child')
    const ruleKeys = [...new Set(((rules ?? []) as { attr_key: string }[]).map((r) => r.attr_key))]
    const flatKeys = ruleKeys.filter((k) => BROADCAST_HEALABLE.has(k))
    // Composite rules are keyed on the container name (shirt_size); resolve each learned container's spec.
    const compositeSpecs = ruleKeys
      .map((k) => COMPOSITE_HEAL_SPECS.find((s) => s.containerKey === k))
      .filter((s): s is CompositeHealSpec => !!s)
    if (flatKeys.length === 0 && compositeSpecs.length === 0) return []
    // Live child SKUs to inherit from (>=2 for cross-check agreement — same guard as the heal path).
    const { data: childRows } = await db.from('listing_content')
      .select('sku').eq('parent_asin', parentAsin).neq('sku', parentSku)
    const childSkus = [...new Set(((childRows ?? []) as { sku: string }[]).map((r) => r.sku).filter(Boolean))]
    if (childSkus.length < 2) return []
    // FAN-OUT FIX: fetch each SAMPLED child ONCE (capped at HEAL_SAMPLE_CAP) and resolve EVERY key from
    // that single payload — not one GET per (child × key). Same single-fetch model as the heal path.
    const childAttrs = await fetchChildAttributesMap(sellerId, token, childSkus)
    const out: PrefillEntry[] = []
    for (const spApiKey of flatKeys) {
      const v = inheritChildValue(childAttrs, spApiKey)
      if (v) out.push({ kind: 'flat', spApiKey, value: v })
    }
    for (const spec of compositeSpecs) {
      // Identical verbatim-mirror + agreement guard the heal path uses — pre-fill ships the SAME payload.
      const built = buildCompositeMirrorItem(childAttrs, spec.containerKey, spec.subKeys)
      if (built) out.push({ kind: 'composite', containerKey: spec.containerKey, value: [built.item] })
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

  // PHASE 4 PUSH-BOUNDARY GATE: refuse a >75-char title BEFORE any PATCH is built. Amazon
  // auto-rewrites item_name over 75 (2026-07-27 policy) and Item Highlights 100476-rejects SKUs
  // whose live title exceeds it — the mess the #81 heal loop cleans up AFTER the fact. Refuse,
  // never truncate (a mid-word slice ships garbage; the :1133 heal gate set the precedent). This
  // also covers the seller's manual override, which was previously sliced at the generic 200 cap
  // and sent. Unchanged rows never block — they are not being sent.
  if (field === 'title') {
    const over = titlePushBlocked(baseDiff)
    if (over) {
      throw new Error(
        `Title push refused: "${over.sku}" would ship ${over.chars} characters (limit 75). ` +
        `Amazon auto-rewrites titles over 75 and rejects Item Highlights on them (100476) — ` +
        `shorten the title or regenerate it, then push again. Nothing was sent.`,
      )
    }
  }

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
          // TIER-2 pre-fill: the actual missing-broadcast-attr RESOLUTION (live SP-API GETs) is DEFERRED
          // to the push path (executePush) — this GET preview issues ZERO SP-API calls for it (adversarial
          // review 2026-06-28). The parent row is simply flagged isParent; the push loop resolves + writes
          // the learned prefill attrs lazily, just before the parent content PATCH.
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
    .select('product_details_improvements, per_child_titles')
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
  // STYLE LEAK GATE (B, defense-in-depth): style/style_name describe the specific design — broadcasting
  // one value across a multi-design family overwrites every design's distinct style. The UI already hides
  // the button, but a direct POST must be blocked here too (INVARIANT 5 — gate on the bytes that ship).
  // Single-design broadcasts safely (all children share the one design). Checks the resolved spApiKey so it
  // catches both the schema-resolved and static-map paths.
  if (isSingleDesignOnlyKey(attribute.spApiKey)) {
    // The seller's manual "Multi Design" override is authoritative over the auto-detected per_child_titles
    // (both directions — force-single un-suppresses, force-multi suppresses), matching the client gates via
    // the shared resolveMultiDesign. Read it once (only reached for a style-attr push, so rare).
    const { data: scoreRow } = await supabase
      .from('listing_seo_scores')
      .select('is_multi_design_override')
      .eq('parent_asin', parentAsin)
      .maybeSingle()
    const override = (scoreRow as { is_multi_design_override?: boolean | null } | null)?.is_multi_design_override ?? null
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (resolveMultiDesign((recRow as any)?.per_child_titles, override)) {
      return { ctx: null, error: SINGLE_DESIGN_ONLY_LEAK_REASON }
    }
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

/** Which of a composite's candidate sub-fields does the LIVE listing already populate?
 *  A HINT, not proof (adversarial review fix 3): a derived sub-field (SHIRT sleeve
 *  `length_description`) is populated by Amazon's OWN derivation without honoring writes, so
 *  "populated" alone must not promote it — the caller gates this hint through
 *  applyLiveDetailSubfieldHint (union-enum candidates only) before reordering the probes.
 *  candidatePaths come in preference order — when several are populated the earlier one wins.
 *  Best-effort: null on any failure / nothing populated (schema order then decides). */
async function detectLiveDetailSubfield(
  sellerId: string, token: string, sku: string, spApiKey: string, candidatePaths: string[][],
): Promise<string | null> {
  try {
    const url =
      `${ENDPOINT}/listings/2021-08-01/items/${sellerId}/${encodeURIComponent(sku)}` +
      `?marketplaceIds=${MARKETPLACE_ID}&includedData=attributes`
    await spApiReadBucket.acquire()   // global 5-rps ceiling for getListingsItem reads (task #23) — 1 token per GET
    const resp = await fetch(url, { headers: { 'x-amz-access-token': token } })
    if (!resp.ok) return null
    const json = (await resp.json()) as { attributes?: Record<string, unknown> }
    const arr = (json.attributes ?? {})[spApiKey]
    if (!Array.isArray(arr) || arr.length === 0) return null
    const entry = arr[0] as Record<string, unknown>
    for (const p of candidatePaths) {
      const v = entry?.[p[0]]
      if (v == null) continue
      if (Array.isArray(v) ? v.length > 0 : true) return p[0]
    }
    return null
  } catch { return null }
}

/** Fetch a SKU's CURRENT attribute value live from Listings Items. Best-effort: '' on failure. */
async function fetchCurrentDetail(
  sellerId: string, token: string, sku: string, spApiKey: string,
): Promise<string> {
  try {
    const url =
      `${ENDPOINT}/listings/2021-08-01/items/${sellerId}/${encodeURIComponent(sku)}` +
      `?marketplaceIds=${MARKETPLACE_ID}&includedData=attributes`
    await spApiReadBucket.acquire()   // global 5-rps ceiling for getListingsItem reads (task #23) — 1 token per GET
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
): Promise<{ sku: string; asin: string; isParent: boolean; notLive?: boolean }[]> {
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
  // Track discovery result per ASIN so we can compute notLive AFTER the loop — mirrors the content-path
  // gate pattern (loadDiff:550-567) that already saved us from phantom-listing creation on backfilled
  // rows. Details-path was ungated (2026-07-20 workflow verifier: "CRITICAL — same class of bug that
  // bit PO on B0DQ5YZH38"); this brings parity so a details:title_differentiation push (which likely
  // triggered the B0DQ5YZH38 family split when repeated on offerless-backfilled SKUs) can no longer
  // materialize phantom ASINs.
  const discoveredByAsin = new Map<string, { sku: string; asin: string }[] | null>()
  for (const asin of asinsToProbe) {
    const discovered = await discoverSkusForAsin(sellerId, token, asin)
    discoveredByAsin.set(asin, discovered)
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

  // ── GROUND-TRUTH GATE (2026-07-20 details-path parity): tag notLive iff Amazon SUCCESSFULLY reported
  // ZERO seller SKUs under the row's ASIN (offerless-backfilled phantom). null (lookup failed) or an
  // un-probed ASIN stays live → we NEVER over-skip on an API hiccup, the mistake the reverted
  // listing_health gate made (#260 → #264, 121-listing revert). PARENT row (asin===parentAsin) is
  // exempted — a non-buyable hub is normal, not phantom.
  const withNotLive = expanded.map((r) => {
    const isParent = r.sku === parentSku && !knownChildSkus.has(r.sku)
    if (isParent || r.asin === parentAsin) return { sku: r.sku, asin: r.asin, isParent, notLive: false }
    const disc = r.asin ? discoveredByAsin.get(r.asin) : undefined
    const notLive = Array.isArray(disc) && disc.length === 0
    return { sku: r.sku, asin: r.asin, isParent, notLive }
  })
  // SAFETY VALVE (same threshold + rationale as loadDiff's content-path gate at :564-566): offerless
  // rows are a small MINORITY of a real family. If this gate would skip HALF OR MORE, distrust it
  // (discovery rate-limited / Amazon returning empty en masse / stale asin mapping) and push everything
  // — a rare phantom is far better than the #260/#262/#263/#264 revert cycle that blanket-skipped 121
  // real POD listings.
  const wouldSkip = withNotLive.filter((r) => r.notLive).length
  if (wouldSkip > 0 && wouldSkip >= Math.ceil(withNotLive.length / 2)) {
    for (const r of withNotLive) r.notLive = false
  }
  return withNotLive
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
      // Propagate the ground-truth phantom-gate signal so single-attribute detail push (executePush
      // details branch) can skip offerless-backfilled rows — parity with content-path's own notLive.
      notLive: r.notLive === true ? true : false,
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
  await spApiWriteBucket.acquire()   // global 5-rps ceiling across ALL writers (task #23) — 1 token per patchListingsItem call
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

/** PARENT-HUB baseline attributes — the SP-API research (2026-07-20) confirmed the "ACCEPTED then
 *  silently dropped" behavior on variation-parent PATCHes is caused by our writes omitting the coherent
 *  family attribute set Amazon requires on every parent-record edit. amzn/selling-partner-api-models
 *  #439/#2489/#3500 all describe the same pattern; own-code comments name it at pushExecutor.ts:1177.
 *
 *  READ, don't guess: fetch the parent's OWN current parentage_level + child_parent_sku_relationship +
 *  variation_theme. Whatever Amazon already stores is authoritative for this SKU (a shirt family may be
 *  SIZE or SIZE-COLOR or COLOR-SIZE — reading avoids hard-coding the wrong theme). We then RE-SEND those
 *  exact values alongside the actual target attribute so Amazon has the coherent set inside one PATCH.
 *
 *  Returns null on any read failure — caller falls back to the pre-fix single-attribute PATCH (never
 *  over-block the push on a transient GET flake). */
type ParentBaselineAttrs = {
  parentage_level?: unknown[]
  child_parent_sku_relationship?: unknown[]
  variation_theme?: unknown[]
}
async function fetchParentFamilyBaseline(
  sellerId: string, token: string, parentSku: string,
): Promise<ParentBaselineAttrs | null> {
  try {
    await spApiReadBucket.acquire()
    const url = `${ENDPOINT}/listings/2021-08-01/items/${sellerId}/${encodeURIComponent(parentSku)}?marketplaceIds=${MARKETPLACE_ID}&includedData=attributes`
    const resp = await fetch(url, { headers: { 'x-amz-access-token': token } })
    if (!resp.ok) return null
    const json = (await resp.json()) as { attributes?: Record<string, unknown[]> }
    const attrs = json.attributes ?? {}
    const out: ParentBaselineAttrs = {}
    if (Array.isArray(attrs.parentage_level)) out.parentage_level = attrs.parentage_level
    if (Array.isArray(attrs.child_parent_sku_relationship)) out.child_parent_sku_relationship = attrs.child_parent_sku_relationship
    if (Array.isArray(attrs.variation_theme)) out.variation_theme = attrs.variation_theme
    // At least ONE baseline attr must be present or the "coherent family set" claim is meaningless —
    // return null so caller falls back to plain patchSku instead of shipping a wrong-shaped baseline.
    return Object.keys(out).length > 0 ? out : null
  } catch { return null }
}

/** PATCH a parent SKU with the target attribute PLUS its family baseline in ONE top-level replace.
 *  Mirrors patchSku's response contract so callers can drop it in as a replacement for isParent rows.
 *  Amazon needs the WHOLE family set present, not just the target — omitting it is what causes silent-
 *  drop. Rate-limited via the same spApiWriteBucket. */
async function patchParentSkuWithBaseline(
  sellerId: string, token: string, productType: string, sku: string,
  attribute: string, value: string | string[], mode: 'VALIDATION_PREVIEW' | 'LIVE',
  baseline: ParentBaselineAttrs,
): Promise<PatchResult> {
  await spApiWriteBucket.acquire()
  const patches: { op: string; path: string; value: unknown }[] = [
    // Target FIRST so downstream diagnostics see it in the patches[0] slot.
    { op: 'replace', path: `/attributes/${attribute}`, value: buildPatchValue(value, MARKETPLACE_ID) },
  ]
  if (baseline.parentage_level) patches.push({ op: 'replace', path: '/attributes/parentage_level', value: baseline.parentage_level })
  if (baseline.child_parent_sku_relationship) patches.push({ op: 'replace', path: '/attributes/child_parent_sku_relationship', value: baseline.child_parent_sku_relationship })
  if (baseline.variation_theme) patches.push({ op: 'replace', path: '/attributes/variation_theme', value: baseline.variation_theme })
  const modeParam = mode === 'VALIDATION_PREVIEW' ? '&mode=VALIDATION_PREVIEW' : ''
  const url =
    `${ENDPOINT}/listings/2021-08-01/items/${sellerId}/${encodeURIComponent(sku)}` +
    `?marketplaceIds=${MARKETPLACE_ID}&includedData=issues${modeParam}`
  const resp = await fetch(url, {
    method: 'PATCH',
    headers: { 'x-amz-access-token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ productType, patches }),
  })
  if (!resp.ok) {
    const txt = await resp.text()
    return { ok: false, submissionId: null, error: `HTTP ${resp.status}: ${txt.slice(0, 200)}` }
  }
  return parsePatchIssues(await resp.json() as Parameters<typeof parsePatchIssues>[0])
}

/** Read item_name for one SKU — the specific readback we need on parent-hub title pushes.
 *  fetchCurrentDetail already handles the shape (attributes.item_name[0].value); this is just the
 *  narrow-purpose call site for the parent-silent-drop detector, named for grep-ability. Returns ''
 *  on any fetch/parse failure (caller must not treat '' as a definitive mismatch — the readback
 *  guard tolerates '' and skips the mismatch classification). */
async function readbackItemName(
  sellerId: string, token: string, sku: string,
): Promise<string> {
  return (await fetchCurrentDetail(sellerId, token, sku, 'item_name')).trim()
}

/** AUTO-HEAL for Amazon error 100476 on Item Highlights (2026-07-20, PO explicit ask).
 *
 *  WHY: 100476 means "provide an Item Name ≤75 chars to use Item Highlights". It fires when the SKU's
 *  LIVE item_name on Amazon is >75 — which happens routinely when our optimizer generated a compliant
 *  ≤75 title but the seller never re-pushed the title itself (B0DQ66546T Beast Mode: live title 166
 *  chars, portal cache says 71). Our previous "friendly error" text told the seller to do it manually;
 *  the seller (rightly) asked "why doesn't the system auto-heal?" It now does.
 *
 *  WHAT: read `listing_seo_recommendations.recommended_title` (already generated by the optimizer,
 *  already capTitle75-gated at generation time), sanity-check it is ≤75 chars, push it as item_name for
 *  THIS ONE SKU, then the caller retries the IH push. No regeneration — reusing the value we already
 *  approved. All 3 patchSku calls (preview title, live title, retry-preview IH, retry-live IH) go
 *  through the shared spApiWriteBucket so 5-rps stays honored.
 *
 *  SCOPE: fires ONLY on 100476 (isItemHighlightTitleTooLongError) and ONLY on the IH attribute
 *  (isItemHighlightsField). Cannot touch any other attribute; cannot fire without the exact error.
 *  Failing to heal is soft — the caller records the original failure with the auto-heal note appended.
 *
 *  UNKNOWN we cannot help: per-CHILD titles for multi-design families. `recommended_title` is the
 *  broadcast/parent title; if a family uses per_child_titles and one child needs a different ≤75 title,
 *  the auto-heal for THAT child uses the parent title (still compliant, just not per-design). Fine as a
 *  starting point; multi-design per-child auto-heal is a future refinement. */
async function autoHealIhLongTitle(
  sellerId: string,
  token: string,
  productType: string,
  sku: string,
  parent_asin: string,
): Promise<{ healed: boolean; usedTitle?: string; error?: string }> {
  try {
    const supabase = await createAdminClient()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data } = await (supabase as any).from('listing_seo_recommendations')
      .select('recommended_title')
      .eq('parent_asin', parent_asin)
      .maybeSingle()
    const rec = ((data as { recommended_title?: string } | null)?.recommended_title ?? '').trim()
    if (!rec) return { healed: false, error: 'no recommended_title in listing_seo_recommendations — run an AI audit first' }
    if (rec.length > 75) return { healed: false, usedTitle: rec, error: `recommended_title is ${rec.length}>75 — refusing to push a title Amazon will re-reject with the same 100476` }
    const prev = await patchSku(sellerId, token, productType, sku, 'item_name', rec, 'VALIDATION_PREVIEW')
    if (!prev.ok) return { healed: false, usedTitle: rec, error: `title preview rejected: ${(prev.error ?? '').slice(0, 240)}` }
    const live = await patchSku(sellerId, token, productType, sku, 'item_name', rec, 'LIVE')
    if (!live.ok) return { healed: false, usedTitle: rec, error: `title live push rejected: ${(live.error ?? '').slice(0, 240)}` }
    return { healed: true, usedTitle: rec }
  } catch (e) {
    return { healed: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// ─── PATCH one SKU's DETAIL attribute (validation-preview, then live) ──────────
async function patchSkuDetail(
  sellerId: string, token: string, productType: string, sku: string,
  attribute: DetailAttribute, value: string, mode: 'VALIDATION_PREVIEW' | 'LIVE',
  valueShape?: DetailValueShape | null,
  /** Calibrated patch value (a specific write-form variant) — overrides the builders. */
  patchValue?: Record<string, unknown>[],
): Promise<PatchResult> {
  await spApiWriteBucket.acquire()   // global 5-rps ceiling (task #23)
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

// ─── SELF-HEALING ITEM HIGHLIGHTS PROBE ────────────────────────────────────────
// Classify whether Amazon's Listings API currently accepts title_differentiation (Item Highlights)
// writes — WITHOUT ever writing (VALIDATION_PREVIEW only). Persists the marketplace-wide verdict to
// app_settings so the write-gate (isWriteBlockedPreLaunch) is driven by fact, not a hardcoded date.

/** Probe whether Amazon currently accepts Listings-API writes to title_differentiation
 *  (Item Highlights) for a representative LIVE SKU — WITHOUT writing (VALIDATION_PREVIEW only).
 *    'supported' → preview.ok (Amazon validated the write clean)
 *    'blocked'   → preview failed AND joined error matches /currently unsupported/i
 *    'unknown'   → no live SKU, no productType, HTTP transport failure, or any other rejection
 *                  (do NOT persist as blocked — a transient blip must never flip the flag). */
export async function probeItemHighlightsWritable(): Promise<'supported' | 'blocked' | 'unknown'> {
  try {
    const sellerId = await getSellerId()
    const token = await getAccessToken()
    const db = await createAdminClient()

    // Pick ONE confirmed-live child SKU (marketplace-wide flag → any live SKU answers the question).
    const { data: rows } = await db
      .from('listing_content').select('sku, asin').limit(200)
    const candidates = dedupByAsin((rows ?? []) as { sku: string; asin: string }[])
    let liveSku: string | null = null
    for (const c of candidates) {
      const skus = await discoverSkusForAsin(sellerId, token, c.asin)   // null=failed, []=offerless, [..]=live
      if (skus && skus.length > 0) { liveSku = skus[0].sku; break }
    }
    if (!liveSku) return 'unknown'                       // no confirmed-live SKU → inconclusive

    const productType = await tryGetProductType(sellerId, token, liveSku)
    if (!productType) return 'unknown'                   // wrong-schema preview is meaningless (#244/#245 trap)

    const attribute: DetailAttribute = { spApiKey: 'title_differentiation', scope: 'broadcast' }
    // Benign, non-empty free-text highlight (≤125 chars). Content is irrelevant — Amazon returns
    // "currently unsupported" BEFORE value validation; the flat buildDetailPatchValue shape suffices.
    const probeValue = 'Everyday comfort and a clean, versatile look that pairs easily with the rest of your wardrobe.'
    const preview = await patchSkuDetail(sellerId, token, productType, liveSku, attribute, probeValue, 'VALIDATION_PREVIEW')

    if (preview.ok) return 'supported'
    if (/^HTTP \d+:/.test(preview.error ?? '')) return 'unknown'          // transport wrapper — not a verdict
    if (preview.error && /currently unsupported/i.test(preview.error)) return 'blocked'
    return 'unknown'                                     // some OTHER validation error — don't flip the flag
  } catch { return 'unknown' }
}

const IH_PROBE_THROTTLE_MS = 24 * 60 * 60 * 1000

/** Fire-and-forget daily refresh of the Item Highlights flag. Never blocks the caller,
 *  never throws, never overwrites a good flag on a transient/inconclusive ('unknown') result. */
export function maybeRefreshItemHighlightsProbe(
  db: SupabaseClient,
  state: ItemHighlightsApiState | null,
): void {
  const fresh = state && (Date.now() - Date.parse(state.probed_at)) < IH_PROBE_THROTTLE_MS
  if (fresh) return
  void (async () => {
    try {
      const verdict = await probeItemHighlightsWritable()      // 'supported' | 'blocked' | 'unknown'
      if (verdict === 'supported') await setItemHighlightsApiState(db, true)
      else if (verdict === 'blocked') await setItemHighlightsApiState(db, false)
      // 'unknown' → leave the last-known flag untouched (transient/no-productType/HTTP)
    } catch { /* best-effort */ }
  })()
}

// ─── DETERMINISTIC AUTO-HEAL — inherit a missing BROADCAST attribute onto the parent hub ───────
// The non-buyable variation PARENT (e.g. Custom-Cup-TS-Parent) gets rejected on EVERY content/detail
// PATCH when a required BROADCAST attribute (shirt_size#?.size_system / size_class, department,
// age_range_description) is missing on the hub while its CHILDREN carry valid values. We READ a live
// child's value and PATCH it onto the parent (VALIDATION_PREVIEW → LIVE). GUARDRAILS: broadcast-scope
// ONLY (never per-variant color/size/capacity); a passing VALIDATION_PREVIEW gates every LIVE write;
// ABSTAIN when children DISAGREE or none carries the value; everything is best-effort/non-throwing.

/** Broadcast-scoped attribute keys the auto-heal is allowed to inherit onto the parent hub. STRICTLY
 *  FLAT, parent-shared SCALAR attributes whose absence rejects the hub — NEVER per-variant axes
 *  (color/size/capacity) whose value differs per child, and NEVER a COMPOSITE container.
 *
 *  COMPOSITES ARE DELIBERATELY EXCLUDED (adversarial review 2026-06-28). `shirt_size` is a per-variant
 *  COMPOSITE container: its ITEM carries the per-child size, and `size_system`/`size_class` are
 *  SUB-fields nested inside that container, not top-level attributes. The generic read
 *  (currentDetailValue) and write (buildShapedDetailValue) pick a sub-field by DIFFERENT ambiguous
 *  preference orders, so healing a composite can write a value into the WRONG sub-field of the live
 *  parent hub — and VALIDATION_PREVIEW does NOT catch a wrong-shaped composite (Amazon accepts it,
 *  then silently drops it). Because the allowlist is now flat scalars only, the fix-#2 read-back
 *  compare is a reliable exact string match. Composite healing must be a SEPARATE, purpose-built,
 *  read-back-verified follow-up (per-sub-field resolve + shaped write + re-read each sub-field) — it
 *  must NOT ride this generic flat-scalar path. */
const BROADCAST_HEALABLE = new Set<string>([
  'department', 'age_range_description',
])

/** COMPOSITE auto-heal registry (self-healing composite). A parent hub rejection can name a COMPOSITE
 *  CONTAINER (`shirt_size`) OR its invariant SUB-fields (`size_system`/`size_class`) directly — Amazon's
 *  issue.attributeNames varies. Both map to the same purpose-built healParentComposite (verbatim-mirror +
 *  read-back), NOT the flat healParentAttributes path. `subKeys` are the parent-INVARIANT sub-objects to
 *  mirror; the per-variant `size` is deliberately NOT listed (never inherited onto the shared hub).
 *  `perVariantField` names that per-variant field INSIDE the container ('size' for shirt_size) — it is
 *  NEVER written to the hub; it exists ONLY to build the strategy-2 (delete-partial-container)
 *  conditional-requirement signature regex (see conditionalRequirementRegex). */
interface CompositeHealSpec { containerKey: string; subKeys: string[]; perVariantField: string }
const COMPOSITE_HEAL_SPECS: CompositeHealSpec[] = [
  /* v10 (2026-08-06, the catch-22 verdict): body_type/height_type are UNWRITABLE via this API —
   * LIVE validation rejects them "at most '0'" on every new submission (v9 proved it live) while
   * the standing conditional simultaneously demands them "min 1" on 3-field records. The legacy
   * five-field records are grandfathered; the 3-field write is the API-achievable cure (v7 proved
   * it persists) and the residual standing complaint is stepped over by the executor's
   * previewObjectionsUnrelated bypass — content flows regardless. So subKeys stays the 2-key
   * list: the heal must deliver the achievable fix, not chase the unwritable pair. */
  { containerKey: 'shirt_size', subKeys: ['size_system', 'size_class'], perVariantField: 'size' },
]
/** Item A (2026-07-21, PO approved): return the FIRST composite container this parent has been flagged
 *  needs_attention on, or null if no active flag stands. When non-null, the content + details push
 *  loops SKIP the parent-hub PATCH (which is doomed to silent-drop after Amazon rule 99022 traps the
 *  composite — verified live on PHE-STS-P B0FKKN8XKV, workflow wob0iqomq exhausted every API path) and
 *  emit a `skipped_manual_parent` row instead of a `failed` row. The frontend popup uses the returned
 *  container(s) to render the exact fields the operator needs to complete in Seller Central.
 *  Best-effort — DB error → bypass:false so a transient blip never silences a legitimate parent push. */
async function shouldBypassParentPush(parent_asin: string): Promise<{ bypass: boolean; containers: string[] }> {
  try {
    const { hasActiveManualHealFlag } = await import('@/lib/fba/verificationQueue')
    const hits: string[] = []
    for (const spec of COMPOSITE_HEAL_SPECS) {
      if (await hasActiveManualHealFlag(parent_asin, spec.containerKey)) hits.push(spec.containerKey)
    }
    return { bypass: hits.length > 0, containers: hits }
  } catch (e) {
    console.warn('[push] shouldBypassParentPush check failed (non-fatal, proceeding with parent PATCH):', e instanceof Error ? e.message : e)
    return { bypass: false, containers: [] }
  }
}

/** Rejected-attribute name → the composite spec that heals it (container name OR any of its subKeys). */
function compositeSpecForRejectedAttr(attr: string): CompositeHealSpec | null {
  for (const spec of COMPOSITE_HEAL_SPECS) {
    if (attr === spec.containerKey || spec.subKeys.includes(attr)) return spec
  }
  return null
}

/** STRATEGY-2 TRIGGER SIGNATURE (heal v2, LIVE evidence 2026-07-02). Amazon's CONDITIONAL requirement
 *  rejects the verbatim-mirror write with (shirt_size example, quoting the recorded task last_error):
 *    "Based on the data from '[shirt_size#?.size_system, shirt_size#?.size_class]', the field '"size"'
 *     for the attribute 'Shirt Size' does not have enough values. The required minimum is '1' value(s)."
 *  i.e. "if size_system/size_class are present then the per-variant `size` is required" — and a parent
 *  hub can never carry a per-variant `size`, so RE-writing system/class re-trips this rule forever.
 *  Built generically from the spec's perVariantField so a future composite container only needs its own
 *  registry entry. Tolerant of Amazon's mixed quoting ('"size"' / 'size' / "size" / size). */
function conditionalRequirementRegex(perVariantField: string): RegExp {
  const escaped = perVariantField.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`the field\\s+'?"?${escaped}"?'?\\s+for the attribute .* does not have enough values`, 'i')
}

/** CONTAINER-NAME test (adversarial review 2026-07-02, fix 3): the conditional-requirement signature
 *  alone does not prove the rejection is about THIS container — Amazon words the message around the
 *  per-variant field ('size'), which several containers could share. Built from the containerKey with
 *  each underscore loosened to [\s_-]? so it matches Amazon's prose forms of the same name
 *  ("Shirt Size" in the attribute label, "shirt_size" in the data path, "shirt-size" defensively). */
function containerNameRegex(containerKey: string): RegExp {
  const escaped = containerKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(escaped.replace(/_/g, '[\\s_-]?'), 'i')
}

/** UNRELATED-ATTRIBUTE ECHO BYPASS (2026-08-06, the Later-Gator incident-closer).
 *  VALIDATION_PREVIEW re-validates the WHOLE listing, so a listing carrying a standing defect
 *  (live specimen: the shirt_size body_type catch-22 — required "min 1" by the standing
 *  conditional yet rejected "at most 0" on every new submission, i.e. unfixable via this API)
 *  parrots that defect at EVERY preview — including content pushes that never touch the
 *  defective attribute. This is what blocked all 280 Later-Gator content pushes while the
 *  content itself was valid. A preview objection that never NAMES the attribute being written
 *  is a verdict on the standing state, not on this submission → proceed to LIVE. Live remains
 *  a real synchronous validator (proven tonight: it rejects genuinely-invalid payloads), and
 *  the verify cron's read-back stays the delivery gate. Scoped tightly: requires ≥1 STRUCTURED
 *  issue and EVERY issue silent about the written attribute (prose or snake_case form). */
function previewObjectionsUnrelated(
  preview: { issues?: Array<{ message?: string }> | null }, attribute: string,
): boolean {
  const issues = preview.issues ?? []
  if (issues.length === 0) return false
  const nameRe = containerNameRegex(attribute)
  return issues.every((i) => !nameRe.test(i.message ?? ''))
}

/** The outcome of one heal pass over a parent hub. `healed` = attrs written live; `abstained` =
 *  skipped on child disagreement / no child value / non-broadcast; `failed` = validation or write
 *  rejected. Never thrown — the caller (cron/trigger) rides the queue's attempts/backoff on failures. */
export interface HealResult {
  healed: string[]; abstained: string[]; failed: string[]
  /** Observability (heal E2E 2026-07-02): WHY each failed key failed — the Amazon preview/live error,
   *  read-back mismatch detail, or thrown message. Persisted onto the queue task row by the cron so a
   *  failed heal attempt is diagnosable from the DB instead of only the server console. */
  errors?: Record<string, string>
}

/** Max children sampled to detect broadcast-value agreement. A handful is enough to catch a
 *  disagreeing child; walking all N would be O(N) live SP-API GETs for no extra safety. */
const HEAL_SAMPLE_CAP = 5

/** Fetch each SAMPLED child's listing ONCE and return a Map<sku, attributesObject>. Caps the sample
 *  at HEAL_SAMPLE_CAP live children (enough to detect disagreement — we don't walk all N). One GET per
 *  child (NOT one per child×attribute): the caller extracts every eligible key from this single payload.
 *  Best-effort: a failed GET simply omits that sku from the map (treated as "no value"). */
async function fetchChildAttributesMap(
  sellerId: string, token: string, childSkus: string[],
): Promise<Map<string, Record<string, unknown> | null>> {
  const map = new Map<string, Record<string, unknown> | null>()
  for (const sku of childSkus.slice(0, HEAL_SAMPLE_CAP)) {
    try {
      const url =
        `${ENDPOINT}/listings/2021-08-01/items/${sellerId}/${encodeURIComponent(sku)}` +
        `?marketplaceIds=${MARKETPLACE_ID}&includedData=attributes`
      await spApiReadBucket.acquire()   // global 5-rps ceiling for getListingsItem reads (task #23) — 1 token per GET
    const resp = await fetch(url, { headers: { 'x-amz-access-token': token } })
      if (resp.ok) {
        const json = (await resp.json()) as { attributes?: Record<string, unknown> }
        map.set(sku, json.attributes ?? null)
      } else {
        map.set(sku, null)
      }
    } catch { map.set(sku, null) }
    await sleep(PATCH_DELAY_MS)
  }
  return map
}

/** From a PRE-FETCHED child-attributes map, return the agreed value for one broadcast attribute or
 *  null. ABSTAIN (null) when NO sampled child carries it OR the children DISAGREE — never guess a hub
 *  value. No SP-API calls here: the map was built once by fetchChildAttributesMap (fixes the fan-out
 *  of one GET per child×attribute). */
function inheritChildValue(
  childAttrs: Map<string, Record<string, unknown> | null>, spApiKey: string,
): string | null {
  const seen = new Set<string>()
  for (const attrs of childAttrs.values()) {
    const v = currentDetailValue(attrs ?? null, spApiKey).trim()
    if (v) seen.add(v)
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

    // FAN-OUT FIX (adversarial review 2026-06-28): fetch each SAMPLED child's listing ONCE and extract
    // EVERY eligible key from that single attributes payload — instead of one full getListingsItem GET
    // per (child × attribute). Capped at HEAL_SAMPLE_CAP live children (enough to detect disagreement).
    const childAttrs = await fetchChildAttributesMap(sellerId, token, childSkus)

    for (const spApiKey of eligible) {
      try {
        const inherited = inheritChildValue(childAttrs, spApiKey)
        if (!inherited) { out.abstained.push(spApiKey); continue }   // disagreement / none carries it
        const attribute: DetailAttribute = { spApiKey, scope: 'broadcast' }
        // Allowlist is FLAT SCALARS only (composites are excluded — see BROADCAST_HEALABLE), so the
        // legacy flat builder applies and valueShape stays null. We still probe defensively; a flat
        // attr returns null and the read-back below is an exact string match.
        let valueShape: DetailValueShape | null = null
        try { valueShape = await getDetailValueShape(productType, spApiKey, ptOpts) } catch { /* flat */ }

        const preview = await patchSkuDetail(sellerId, token, productType, parentSku, attribute, inherited, 'VALIDATION_PREVIEW', valueShape)
        if (!preview.ok) { out.failed.push(spApiKey); (out.errors ??= {})[spApiKey] = `preview: ${preview.error ?? 'rejected'}`; await sleep(PATCH_DELAY_MS); continue }
        const live = await patchSkuDetail(sellerId, token, productType, parentSku, attribute, inherited, 'LIVE', valueShape)
        if (!live.ok) { out.failed.push(spApiKey); (out.errors ??= {})[spApiKey] = `live: ${live.error ?? 'rejected'}`; await sleep(PATCH_DELAY_MS); continue }

        // READ-BACK VERIFICATION (adversarial review 2026-06-28): a LIVE patch that returns ok does NOT
        // prove the value persisted — Amazon can accept then SILENTLY DROP a value (the composite failure
        // mode; also possible for a flat attr under a schema quirk). Re-READ the parent's attribute and
        // only count this healed IF the hub now actually reflects the inherited value (exact string match
        // after .trim() — reliable because the allowlist is flat scalars). If it did NOT persist, push to
        // out.failed (do NOT learn a rule, do NOT log accepted) so the queue's attempts/backoff/
        // needs_attention surface it, rather than looping on a false 'converged'.
        await sleep(PATCH_DELAY_MS)
        const readBack = (await fetchCurrentDetail(sellerId, token, parentSku, spApiKey)).trim()
        if (readBack !== inherited.trim()) {
          console.warn(`[push-heal] read-back MISMATCH for ${spApiKey} on ${parentSku}: expected "${inherited.trim()}", hub reads "${readBack}" - Amazon accepted then dropped it; marking failed.`)
          out.failed.push(spApiKey)
          ;(out.errors ??= {})[spApiKey] = `read-back mismatch: wrote "${inherited.trim().slice(0, 120)}", hub reads "${readBack.slice(0, 120)}"`
          await sleep(PATCH_DELAY_MS)
          continue
        }

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
        ;(out.errors ??= {})[spApiKey] = `threw: ${e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200)}`
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

// ─── COMPOSITE AUTO-HEAL — mirror a parent hub's missing COMPOSITE sub-fields from a live child ─────
// PURPOSE-BUILT, FAIL-SAFE path for the `shirt_size` container (size_system/size_class). SEPARATE from
// the flat healParentAttributes above BECAUSE the generic read/write path picks composite sub-fields by
// ambiguous preference orders and VALIDATION_PREVIEW does NOT catch a wrong-shaped composite (Amazon
// accepts then silently drops it — the 0/89 neck/closure incident). This path is safe because it
//   (a) copies the child's OWN Amazon-validated sub-objects VERBATIM (no shape guessing / no builder), and
//   (b) READS BACK the parent to confirm each sub-field actually persisted before it learns/logs.

// The CompositeItem type (the shirt_size composite as Amazon returns it: an ARRAY of composite items,
// each carrying the per-variant `size` plus the invariant sub-objects + marketplace_id) now lives in
// healEvidence.ts and is imported above — the pure evidence helpers share it.

/** From a PRE-FETCHED child-attributes map, build ONE composite item for the parent hub that mirrors the
 *  children's agreed invariant sub-objects VERBATIM — plus marketplace_id. AGREEMENT GUARD: every sampled
 *  child must carry EVERY subKey and all children must agree (JSON-stringified compare) on each; otherwise
 *  ABSTAIN (never inherit a per-variant / disagreeing value). Never includes the per-variant `size`. No
 *  SP-API calls here — the map was built once by fetchChildAttributesMap. SHARED by heal + Tier-2 pre-fill
 *  so both write the byte-identical payload. Returns null on abstain. */
function buildCompositeMirrorItem(
  childAttrs: Map<string, Record<string, unknown> | null>,
  containerKey: string,
  subKeys: string[],
): { item: CompositeItem; agreedByKey: Record<string, string> } | null {
  // Collect the FIRST composite item's verbatim sub-object for each subKey, per sampled child.
  const perKeyValues: Record<string, unknown[]> = Object.fromEntries(subKeys.map((k) => [k, []]))
  let samples = 0
  for (const attrs of childAttrs.values()) {
    const raw = attrs?.[containerKey]
    if (!Array.isArray(raw) || raw.length === 0) continue
    const first = raw[0]
    if (first == null || typeof first !== 'object') continue
    samples++
    const firstObj = first as Record<string, unknown>
    for (const k of subKeys) perKeyValues[k].push(firstObj[k])   // undefined if the child lacks this subKey
  }
  // Need >=2 sampled children carrying the container to cross-check agreement.
  if (samples < 2) return null

  const item: CompositeItem = {}
  const agreedByKey: Record<string, string> = {}
  for (const k of subKeys) {
    const vals = perKeyValues[k]
    // Every sampled child must carry this subKey (no undefined) AND agree on it (one distinct JSON).
    if (vals.length !== samples) return null
    const jsons = new Set<string>()
    for (const v of vals) {
      if (v === undefined || v === null) return null   // a child is missing this subKey → abstain whole heal
      try { jsons.add(JSON.stringify(v)) } catch { return null }
    }
    if (jsons.size !== 1) return null                  // children disagree → abstain
    item[k] = vals[0]                                  // VERBATIM copy of the child's own sub-object
    agreedByKey[k] = [...jsons][0]
  }
  item.marketplace_id = MARKETPLACE_ID
  return { item, agreedByKey }
}

// compositeItemCarries + subsetDeepEqual moved VERBATIM to healEvidence.ts (adversarial review
// 2026-07-02): the bounded-convergence evidence check (fix 2) needs them inside the pure,
// dependency-free module so the whole decision path is smokeable standalone. Imported above.

/**
 * Inherit a parent hub's missing COMPOSITE sub-fields (size_system/size_class of shirt_size) VERBATIM
 * from live children, then READ BACK the parent to confirm they persisted. Purpose-built + fail-safe;
 * NON-THROWING (any failure lands in the returned buckets). Learns a push_heal_rules row ONLY after a
 * confirmed read-back so the Tier-2 pre-fill mirrors it on future pushes. If Amazon accepts but silently
 * drops (read-back mismatch) it does NOT learn/log accepted — it returns failed and flags the parent for
 * seller attention so the dead-end is visible rather than looping on a false "converged".
 */
export async function healParentComposite(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  args: {
    parent_asin: string; parentSku: string; productType: string; containerKey: string; subKeys: string[]
    /** The queue task's `attempts` counter (0 on the first heal attempt). FIX 1 (adversarial review
     *  2026-07-02): the strategy-3 escalation requires a PERSISTENT internal-error verdict, so the
     *  cron threads this through — strategy 3 is only reachable on the 2nd+ attempt. Defaults to 0
     *  (the conservative polarity: an unthreaded caller can never escalate on its first attempt). */
    attemptNumber?: number
  },
): Promise<HealResult> {
  const { parent_asin, parentSku, productType, containerKey, subKeys } = args
  const attemptNumber = args.attemptNumber ?? 0
  const out: HealResult = { healed: [], abstained: [], failed: [] }
  if (!parent_asin || !parentSku || !productType || !containerKey || !(subKeys?.length)) {
    if (containerKey) out.abstained.push(containerKey)
    return out
  }

  try {
    const token = await getAccessToken()
    const sellerId = await getSellerId()

    // 1) Load >=2 live child SKUs (exclude the parent hub). <2 → cannot cross-check agreement → abstain.
    const { data: childRows } = await db.from('listing_content')
      .select('sku')
      .eq('parent_asin', parent_asin)
      .neq('sku', parentSku)
    const childSkus = [...new Set(((childRows ?? []) as { sku: string }[]).map((r) => r.sku).filter(Boolean))]
    if (childSkus.length < 2) { out.abstained.push(containerKey); return out }

    // 2) Fetch each SAMPLED child ONCE (capped at HEAL_SAMPLE_CAP) — the raw attributes object per child.
    const childAttrs = await fetchChildAttributesMap(sellerId, token, childSkus)

    // 3) AGREEMENT GUARD + verbatim mirror (never reshaped). Abstains on any absent/disagreeing subKey.
    const built = buildCompositeMirrorItem(childAttrs, containerKey, subKeys)
    if (!built) { out.abstained.push(containerKey); return out }

    // 4) Build the parent write — ONLY the agreed invariant sub-objects + marketplace_id (NO per-variant
    //    `size`). Raw ops via patchSkuMulti so NO shape builder ever touches the child's verbatim objects.
    const ops = [{ op: 'replace' as const, path: `/attributes/${containerKey}`, value: [built.item] }]
    const preview = await patchSkuMulti(sellerId, token, productType, parentSku, ops, 'VALIDATION_PREVIEW')
    if (!preview.ok) {
      // STRATEGY 2 — delete-partial-container (heal v2, LIVE evidence 2026-07-02). When the mirror
      // write's preview fails with Amazon's CONDITIONAL-requirement signature ("if size_system/size_class
      // present then the per-variant `size` is required" — a value the shared hub can NEVER carry),
      // strategy 1 is a dead end FOREVER: re-writing system/class re-arms the very rule that rejects it.
      // The correct heal is to DELETE the partial container from the parent hub — with the container
      // absent the conditional rule never fires and parent PATCHes (title etc.) validate clean.
      // Gated on the spec being registered in COMPOSITE_HEAL_SPECS (that lookup is also where the
      // signature's perVariantField comes from) AND on the preview error matching the signature.
      //
      // PER-ISSUE SIGNATURE TEST (adversarial review 2026-07-02, fix 3): preview.error is the
      // '; '-JOINED all-issues string, and the signature regex carries a greedy .* — tested against
      // the joined string it can SPLICE across issue boundaries ("the field 'size' for the attribute
      // <issue A>...<issue B> does not have enough values") or match a DIFFERENT attribute's message.
      // So test each STRUCTURED issue individually and require EXACTLY ONE issue whose message BOTH
      // matches the conditional-requirement signature AND names THIS container (containerNameRegex).
      // Only when issues[] is empty (HTTP-level failure path returns no structured issues) fall back
      // to the joined string — and then the container-name test must ALSO pass on that same string.
      const spec = COMPOSITE_HEAL_SPECS.find((s) => s.containerKey === containerKey)
      if (spec) {
        const sigRe = conditionalRequirementRegex(spec.perVariantField)
        const nameRe = containerNameRegex(containerKey)
        const issues = preview.issues ?? []
        const triggered = issues.length > 0
          ? issues.filter((i) => sigRe.test(i.message ?? '') && nameRe.test(i.message ?? '')).length === 1
          : sigRe.test(preview.error ?? '') && nameRe.test(preview.error ?? '')
        if (triggered) {
          // childAttrs rides along so the strategy-3 complete-write fallback can reuse the already-
          // fetched sampled-child map instead of re-issuing HEAL_SAMPLE_CAP live GETs; attemptNumber
          // rides along so the strategy-3 escalation can require persistence (fix 1).
          return await healCompositeDeletePartial(db, { parent_asin, parentSku, productType, spec, sellerId, token, childAttrs, attemptNumber })
        }
      }
      out.failed.push(containerKey); (out.errors ??= {})[containerKey] = `preview: ${preview.error ?? 'rejected'}`; return out
    }
    const live = await patchSkuMulti(sellerId, token, productType, parentSku, ops, 'LIVE')
    if (!live.ok) { out.failed.push(containerKey); (out.errors ??= {})[containerKey] = `live: ${live.error ?? 'rejected'}`; return out }

    // 5) READ-BACK (critical fail-safe): re-fetch the parent's container and confirm EACH subKey now
    //    reflects the agreed value VERBATIM (JSON-stringify compare of the parent's first composite item's
    //    sub-object). Amazon can accept then SILENTLY DROP a composite — a LIVE ok does NOT prove persistence.
    await sleep(PATCH_DELAY_MS)
    const parentAttrs = await fetchChildAttributesMap(sellerId, token, [parentSku])
    const parentRaw = parentAttrs.get(parentSku)?.[containerKey]
    const parentFirst = Array.isArray(parentRaw) && parentRaw.length > 0 && typeof parentRaw[0] === 'object'
      ? (parentRaw[0] as Record<string, unknown>)
      : null
    // TOLERANT SUBSET compare (not byte-exact JSON): Amazon may normalize what we wrote (default
    // language_tag, marketplace_id, reordered keys) — a genuinely dropped sub-key is still absent in
    // `got` and fails. `built.item[k]` is the verbatim sub-object we wrote for this subKey.
    const persisted = parentFirst != null && subKeys.every((k) => {
      const got = parentFirst[k]
      if (got === undefined || got === null) return false
      return subsetDeepEqual((built.item as Record<string, unknown>)[k], got)
    })
    if (!persisted) {
      console.warn(`[push-heal] composite read-back MISMATCH for ${containerKey} on ${parentSku}: Amazon accepted then dropped one or more sub-fields; marking failed + flagging for attention.`)
      out.failed.push(containerKey)
      ;(out.errors ??= {})[containerKey] = 'read-back mismatch: Amazon accepted the PATCH then silently dropped one or more sub-fields'
      // UNLEARN (adversarial review): the value did NOT persist, so the Tier-2 pre-fill must STOP
      // LIVE-writing it on every future parent push (it has no read-back of its own). Delete the learned
      // push_heal_rules row for (product_type, containerKey) — leaving only the durable heal:manual
      // needs_attention signal below. Best-effort / non-throwing.
      try {
        await db.from('push_heal_rules')
          .delete().eq('product_type', productType).eq('attr_key', containerKey)
      } catch (e) { console.warn('[push-heal] composite push_heal_rules unlearn (delete) failed (non-fatal):', e instanceof Error ? e.message : e) }
      // Durable, seller-visible alert (the silent-drop dead-end must not be invisible).
      try {
        const { flagParentAttrsNeedAttention } = await import('@/lib/fba/verificationQueue')
        await flagParentAttrsNeedAttention(parent_asin, [containerKey])
      } catch (e) { console.warn('[push-heal] composite flag-attention failed (non-fatal):', e instanceof Error ? e.message : e) }
      return out
    }

    // 6) Confirmed persisted → mark healed, log accepted (SYSTEM_ACTOR), learn the rule for pre-fill.
    out.healed.push(containerKey)
    try {
      await db.from('keyword_push_log').insert({
        parent_asin, sku: parentSku, field: `heal:${containerKey}`,
        previous_value: null, new_value: JSON.stringify(built.item),
        submission_id: live.submissionId, status: 'accepted', error_message: null,
        pushed_by: SYSTEM_ACTOR.id,
      })
    } catch (e) { console.warn('[push-heal] composite keyword_push_log insert failed (non-fatal):', e instanceof Error ? e.message : e) }
    try {
      const { data: existing } = await db.from('push_heal_rules')
        .select('hit_count').eq('product_type', productType).eq('attr_key', containerKey).maybeSingle()
      const prevHits = (existing as { hit_count?: number } | null)?.hit_count ?? 0
      await db.from('push_heal_rules').upsert({
        product_type: productType, attr_key: containerKey,
        sub_keys: subKeys,
        resolution: 'inherit_from_child', resolved_value: null,
        last_seen_at: new Date().toISOString(), hit_count: prevHits + 1,
      }, { onConflict: 'product_type,attr_key' })
    } catch (e) { console.warn('[push-heal] composite push_heal_rules upsert failed (non-fatal):', e instanceof Error ? e.message : e) }
  } catch (e) {
    console.warn('[push-heal] healParentComposite prep failed (non-fatal):', e instanceof Error ? e.message : e)
    if (!out.healed.includes(containerKey) && !out.failed.includes(containerKey)) out.abstained.push(containerKey)
  }
  return out
}

/** One live attributes GET for ONE SKU (uncapped sibling of fetchChildAttributesMap — the twin heal
 *  reads specific SKUs, not an agreement sample). Best-effort: null on any failure. */
async function fetchSkuAttributes(
  sellerId: string, token: string, sku: string,
): Promise<Record<string, unknown> | null> {
  try {
    const url =
      `${ENDPOINT}/listings/2021-08-01/items/${sellerId}/${encodeURIComponent(sku)}` +
      `?marketplaceIds=${MARKETPLACE_ID}&includedData=attributes`
    await spApiReadBucket.acquire()
    const resp = await fetch(url, { headers: { 'x-amz-access-token': token } })
    if (!resp.ok) return null
    const json = (await resp.json()) as { attributes?: Record<string, unknown> }
    return json.attributes ?? null
  } catch { return null }
}

/** Per-run cap for the twin heal: 4 SP-API calls per healed SKU (twin read + preview + live +
 *  read-back) under the cron's 4-minute budget alongside other tasks. Remainder rides the queue's
 *  attempts/backoff — the cron re-claims the task and the healer skips already-complete SKUs. */
const TWIN_HEAL_BATCH = 25

/**
 * TWIN HEAL (2026-08-05 — the Later-Gator incident, PO: "ALL parents failing, ~50 heal attempts").
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * THE CLASS: a CHILD SKU whose OWN composite container is incomplete on Amazon (live specimen: all
 * 70 FBM twins of B0GML5V7KZ missing shirt_size.size_system/size_class) rejects EVERY content
 * write — Amazon re-validates the whole listing on any PATCH, so title/bullets/description/keywords
 * all bounce with "The field 'size_class' for the attribute 'Shirt Size' does not have enough
 * values" while the content itself is fine. The verify cron then re-pushes forever (the seller's
 * "50 attempts").
 *
 * THE CURE: mirror the container VERBATIM from the SKU's same-ASIN twin — the FBA SKU that accepts
 * writes carries a complete container, and a same-ASIN twin is the same size/color BY DEFINITION,
 * so unlike the parent heal there is no agreement problem and the per-variant field (`size`) is
 * copied too. Preview → live → tolerant read-back (subsetDeepEqual), the same discipline as
 * healParentComposite. Once healed, the EXISTING verify/re-push cron delivers the blocked content —
 * no new re-push machinery.
 *
 * Never throws; the cron rides the queue's attempts/backoff on a non-converged result. Already-
 * complete SKUs (healed by a prior attempt or by hand) read back as complete and are skipped as
 * healed-no-op, which is what makes re-claimed attempts idempotent.
 */
export async function healChildTwinComposite(
  db: SupabaseClient,
  opts: { parent_asin: string; productType: string; containerKey: string; subKeys: string[]; skus: string[] },
): Promise<HealResult> {
  const { parent_asin, productType, containerKey, subKeys, skus } = opts
  const out: HealResult = { healed: [], abstained: [], failed: [], errors: {} }
  try {
    const token = await getAccessToken()
    const sellerId = await getSellerId()
    // sku → asin for the whole family in ONE query; twins = other SKUs sharing the ASIN.
    const { data: famRows } = await db.from('listing_content')
      .select('sku, asin').eq('parent_asin', parent_asin)
    const skuAsin = new Map<string, string>()
    for (const r of (famRows ?? []) as { sku: string; asin: string }[]) {
      if (r.sku && r.asin) skuAsin.set(r.sku, r.asin)
    }
    const blocked = new Set(skus)
    const spec = COMPOSITE_HEAL_SPECS.find((s) => s.containerKey === containerKey)
    const wantedKeys = [...subKeys, ...(spec ? [spec.perVariantField] : [])]
    const twinItemByAsin = new Map<string, Record<string, unknown> | null>()   // one twin read per ASIN
    // v2 source caches: ONE family-invariant broadcast source per run; one sized source per size token.
    let familySource: { sku: string; item: Record<string, unknown> } | null | undefined = undefined
    const sizeSourceBySize = new Map<string, Record<string, unknown> | null>()
    let twinDebugLogged = false   // ONE payload-forensics line per run (TWIN_HEAL_DEBUG)

    /* The batch cap counts WRITES, not list positions: every run walks the WHOLE list (the
     * already-healed no-op check is one cheap read each), so the write window ADVANCES across
     * attempts. A slice-based cap would re-process the same healed head forever and never reach
     * the tail (caught in adversarial review before shipping). */
    let writes = 0
    for (const sku of skus) {
      const asin = skuAsin.get(sku)
      if (!asin) { out.abstained.push(sku); continue }
      // IDEMPOTENCE: a SKU healed by a prior attempt (or by hand in Seller Central) reads back
      // complete — count it healed without writing anything.
      const ownAttrs = await fetchSkuAttributes(sellerId, token, sku)
      const ownRaw = ownAttrs?.[containerKey]
      const ownFirst = Array.isArray(ownRaw) && ownRaw[0] && typeof ownRaw[0] === 'object'
        ? ownRaw[0] as Record<string, unknown> : null
      if (ownFirst && wantedKeys.every((k) => ownFirst[k] !== undefined && ownFirst[k] !== null)) {
        out.healed.push(sku)
        continue
      }
      // Needs a WRITE — respect the per-run write cap; the remainder rides the queue's next attempt.
      if (writes >= TWIN_HEAL_BATCH) { out.failed.push(sku); if (out.errors) out.errors[sku] = 'deferred: beyond per-run write cap'; continue }
      writes++
      /* SOURCE SELECTION v2 (2026-08-05, from the FIRST live tick: healed:0/abstained:25 — the
       * Later-Gator "FBM twins" turned out to be SEPARATE child ASINs, so a same-ASIN twin often
       * does not exist). Three sources in preference order:
       *  1. Same-ASIN twin, complete container → verbatim whole-object copy (fully correct).
       *  2. The SKU's OWN item carries the per-variant field (Amazon's live errors complain only
       *     about size_system/size_class) → merge JUST the broadcast subKeys from ANY complete
       *     family sibling (they are family-invariant) over the own item — own `size` preserved.
       *  3. Own item lacks the per-variant field too → a sibling whose SKU carries the SAME size
       *     token (…-2XL-… matches 60142XL-…) → verbatim copy of that sibling's item.
       * No source → abstain (never guess a size). */
      const siblings = [...skuAsin.entries()].filter(([s, a]) => a === asin && s !== sku).map(([s]) => s)
      const twinSku = siblings.find((s) => !blocked.has(s)) ?? siblings[0]
      let twinItem: Record<string, unknown> | null = null
      if (twinSku) {
        const cached = twinItemByAsin.get(asin)
        if (cached !== undefined) twinItem = cached
        else {
          const twinAttrs = await fetchSkuAttributes(sellerId, token, twinSku)
          const raw = twinAttrs?.[containerKey]
          const first = Array.isArray(raw) && raw[0] && typeof raw[0] === 'object'
            ? raw[0] as Record<string, unknown> : null
          twinItem = first && wantedKeys.every((k) => first[k] !== undefined && first[k] !== null) ? first : null
          twinItemByAsin.set(asin, twinItem)
        }
      }
      let item: Record<string, unknown> | null = null
      if (twinItem) {
        item = { ...twinItem, marketplace_id: MARKETPLACE_ID }
      } else {
        // Family-invariant broadcast source: ONE complete sibling anywhere in the family, read once
        // and cached for the whole run (size_system/size_class are the same on every child).
        if (familySource === undefined) {
          familySource = null
          for (const [s] of [...skuAsin.entries()].filter(([s2]) => !blocked.has(s2)).slice(0, 5)) {
            const attrs = await fetchSkuAttributes(sellerId, token, s)
            const raw = attrs?.[containerKey]
            const first = Array.isArray(raw) && raw[0] && typeof raw[0] === 'object'
              ? raw[0] as Record<string, unknown> : null
            if (first && wantedKeys.every((k) => first[k] !== undefined && first[k] !== null)) { familySource = { sku: s, item: first }; break }
          }
        }
        if (ownFirst && spec && ownFirst[spec.perVariantField] !== undefined && ownFirst[spec.perVariantField] !== null && familySource) {
          /* v5 (2026-08-05, the SC-form revelation): the composite has MORE family-invariant
           * sub-fields than the ones Amazon's error names — the Seller Central Edit modal shows
           * FIVE required fields (size_system, size_class, size, body_type, height_type), and the
           * healthy FBA siblings carry all five. v2's merge copied only the two subKeys from the
           * error, so the written item was a 4-key partial — and the parent saga proved Amazon
           * peels conditional layers one at a time and discards incomplete composites whole
           * (plausibly THE accepted-then-dropped cause). Cure: copy the complete sibling's item
           * VERBATIM (all sub-fields ride along) and override only the per-variant size with the
           * blocked SKU's own — the same proven-shape semantic rungs 1 and 3 already use. */
          item = { ...familySource.item, [spec.perVariantField]: ownFirst[spec.perVariantField], marketplace_id: MARKETPLACE_ID }
        } else if (familySource) {
          // Size-token match: the blocked SKU's size (…-2XL-…) must appear in the source SKU
          // (60142XL-… carries it glued). Search a size-matched sibling; verbatim copy its item.
          const sizeRe = /(?:^|[-_])(XXS|XS|S|M|L|XL|XXL|2XL|3XL|4XL|5XL|6XL)(?=[-_]|$)/i
          const ownSize = sizeRe.exec(sku)?.[1]?.toUpperCase()
          // CLEAN-token match only ("-2XL-"), never glued prefixes: "6014XL" is ambiguous between
          // 6014+XL and 601+4XL, and a wrong-size copy would be a real defect — abstain over guess.
          const matched = ownSize
            ? [...skuAsin.keys()].filter((s) => !blocked.has(s) && new RegExp(`(?:^|[-_])${ownSize}(?=[-_]|$)`, 'i').test(s))
            : []
          let sizedItem: Record<string, unknown> | null = null
          for (const s of matched.slice(0, 3)) {
            const cachedSized = sizeSourceBySize.get(ownSize ?? '')
            if (cachedSized !== undefined) { sizedItem = cachedSized; break }
            const attrs = await fetchSkuAttributes(sellerId, token, s)
            const raw = attrs?.[containerKey]
            const first = Array.isArray(raw) && raw[0] && typeof raw[0] === 'object'
              ? raw[0] as Record<string, unknown> : null
            if (first && wantedKeys.every((k) => first[k] !== undefined && first[k] !== null)) { sizedItem = first; break }
          }
          if (ownSize) sizeSourceBySize.set(ownSize, sizedItem)
          if (sizedItem) item = { ...sizedItem, marketplace_id: MARKETPLACE_ID }
        }
      }
      if (!item) { out.abstained.push(sku); if (out.errors) out.errors[sku] = `no usable ${containerKey} source (no twin, no own size + family source, no size-matched sibling)`; continue }
      /* v9 (2026-08-06, the GROUND-TRUTH probe): v6 obeyed the preview's "body_type … is not
       * allowed. Expected at most '0'" and stripped body/height — but the sku-attributes probe
       * proved that objection is a LIE: the only ZERO-ISSUE record shape in the family is the
       * FIVE-field inline item ({size, size_system, size_class, body_type, height_type} — the
       * healthy FBA siblings), while every 3-field record (including the PO's Seller-Central-fixed
       * row, whose body/height SC ALSO silently dropped) still carries the standing 99022. So the
       * strip-negotiation is DELETED: write the proven sibling shape verbatim, and the bypass
       * below treats a not-allowed objection about a sub-key the zero-issue sibling carries as
       * one more preview artifact. Read-back after delete+rewrite remains the only real gate. */
      const ops = [{ op: 'replace' as const, path: `/attributes/${containerKey}`, value: [item] }]
      const preview = await patchSkuMulti(sellerId, token, productType, sku, ops, 'VALIDATION_PREVIEW')
      if (!preview.ok) {
        /* PREVIEW-ECHO BYPASS (v3, 2026-08-05 — the forensics verdict). The payload is
         * schema-perfect (flat strings, valid enums, both required sub-fields present — verified
         * against the raw SHIRT subschema), yet preview returns the SAME "size_system/size_class
         * does not have enough values" complaint the patch cures. VALIDATION_PREVIEW echoes the
         * listing's STANDING issues — these listings carry the defect right now, so every preview
         * parrots it back regardless of the submission. The sleeve saga already proved preview
         * unreliable in BOTH directions; read-back below is the only real gate. Therefore: when
         * EVERY preview issue matches the exact disease signature this heal cures (this container's
         * subKey conditional-requirement), proceed to LIVE anyway. Any OTHER preview failure still
         * blocks — the bypass is scoped to the echo of the defect being fixed. */
        const subRes = subKeys.map((k) => conditionalRequirementRegex(k))
        const nameRe = containerNameRegex(containerKey)
        const msgs = (preview.issues ?? []).map((i) => i.message ?? '')
        // v9: a "not allowed / at most '0'" objection about a sub-key we DELIBERATELY carry
        // (because the zero-issue sibling shape carries it) is a preview artifact, not a verdict —
        // the probe proved five-field is the only healthy stored shape. Bypassable like the echo.
        const notAllowedLie = (m: string) => subKeys.some((k) =>
          item[k] !== undefined && new RegExp(`field\\s+'"?${k}"?'.{0,160}?(?:is not allowed|at most '0')`, 'i').test(m))
        const allEcho = msgs.length > 0 && msgs.every((m) => (nameRe.test(m) && subRes.some((re) => re.test(m))) || notAllowedLie(m))
        const errEcho = msgs.length === 0 && !!preview.error &&
          ((nameRe.test(preview.error) && subRes.some((re) => re.test(preview.error ?? ''))) || notAllowedLie(preview.error))
        if (!allEcho && !errEcho) {
          out.failed.push(sku)
          if (out.errors) out.errors[sku] = `preview: ${preview.error ?? 'rejected'}`
          if (!twinDebugLogged) {
            twinDebugLogged = true
            console.log(JSON.stringify({ tag: 'TWIN_HEAL_DEBUG', sku, own: ownFirst, wrote: item, previewIssues: (preview.issues ?? []).slice(0, 3) }).slice(0, 2000))
          }
          continue
        }
        console.log(JSON.stringify({ tag: 'TWIN_HEAL_PREVIEW_ECHO_BYPASS', sku, containerKey }))
      }
      let live = await patchSkuMulti(sellerId, token, productType, sku, ops, 'LIVE')
      if (!live.ok) { out.failed.push(sku); if (out.errors) out.errors[sku] = `live: ${live.error ?? 'rejected'}`; continue }
      await sleep(PATCH_DELAY_MS)
      // Tolerant read-back — same subsetDeepEqual discipline as the parent heal (Amazon normalizes).
      const readBack = async (): Promise<boolean> => {
        const after = await fetchSkuAttributes(sellerId, token, sku)
        const afterRaw = after?.[containerKey]
        const afterFirst = Array.isArray(afterRaw) && afterRaw[0] && typeof afterRaw[0] === 'object'
          ? afterRaw[0] as Record<string, unknown> : null
        // v8: gate only on the keys we actually WROTE — the v6 negotiation may have stripped
        // sub-keys the standing conditional bans (pre-heal state), and demanding them at
        // read-back would fail a legitimately persisted partial-stage write.
        return afterFirst != null && wantedKeys.filter((k) => item[k] !== undefined).every((k) => {
          const got = afterFirst[k]
          if (got === undefined || got === null) return false
          return subsetDeepEqual(item[k], got)
        })
      }
      let persisted = await readBack()
      if (!persisted) {
        /* PARTIAL-CONTAINER TRAP ESCALATION (v4, 2026-08-05 — attempt 5 verdict: all 25 live
         * writes ACCEPTED then sub-fields silently DROPPED). This is the PHE-STS-P rule-99022
         * class verbatim: a container that exists PARTIALLY (these items carry only `size`)
         * swallows merged writes. The cure proven there: scoped DELETE of the partial container,
         * then the complete write. Two-step live, then re-read-back — still the only real gate. */
        /* v7 (2026-08-05, the InvalidInput discovery): Amazon's patch dialect is NOT RFC 6902 —
         * a delete op MUST carry `value` naming what is stored, or the call 400s with
         * "Invalid empty value provided in patch at index of 0". Every prior delete (this
         * escalation AND the parent saga's scoped-delete endpoint) omitted value, so the
         * delete-then-complete-write cure has never actually executed. Read the CURRENT stored
         * array and delete exactly that. */
        const curAttrs = await fetchSkuAttributes(sellerId, token, sku)
        const curRaw = curAttrs?.[containerKey]
        const delOps = [{
          op: 'delete' as const, path: `/attributes/${containerKey}`,
          value: Array.isArray(curRaw) && curRaw.length > 0 ? curRaw : [item],
        }]
        const del = await patchSkuMulti(sellerId, token, productType, sku, delOps as unknown as typeof ops, 'LIVE')
        // Observability gap closed (v6): a failed DELETE used to fall through silently, making a
        // blocked escalation indistinguishable from a swallowed rewrite (the parent saga's
        // strategy-2 internal-error class). One line names it.
        if (!del.ok) console.log(JSON.stringify({ tag: 'TWIN_HEAL_DELETE_FAILED', sku, err: (del.error ?? 'rejected').slice(0, 200) }))
        if (del.ok) {
          await sleep(PATCH_DELAY_MS)
          live = await patchSkuMulti(sellerId, token, productType, sku, ops, 'LIVE')
          if (live.ok) {
            await sleep(PATCH_DELAY_MS)
            persisted = await readBack()
            if (persisted) console.log(JSON.stringify({ tag: 'TWIN_HEAL_DELETE_REWRITE_OK', sku, containerKey }))
          }
        }
      }
      if (!persisted) {
        out.failed.push(sku)
        // Name the NEXT conditional layer instead of failing silently: after a swallowed write the
        // listing's standing issues are the only place Amazon says WHY (the peel-one-layer pattern).
        let issueNote = ''
        try {
          const iUrl = `${ENDPOINT}/listings/2021-08-01/items/${sellerId}/${encodeURIComponent(sku)}` +
            `?marketplaceIds=${MARKETPLACE_ID}&includedData=issues`
          await spApiReadBucket.acquire()
          const iResp = await fetch(iUrl, { headers: { 'x-amz-access-token': token } })
          if (iResp.ok) {
            const iJson = (await iResp.json()) as { issues?: { message?: string }[] }
            issueNote = (iJson.issues ?? []).slice(0, 2).map((i) => i.message ?? '').filter(Boolean).join(' | ').slice(0, 300)
          }
        } catch { /* observability only */ }
        if (out.errors) out.errors[sku] = `read-back mismatch persisted through delete+rewrite (accepted-then-dropped)${issueNote ? `; standing issues now: ${issueNote}` : ''}`
        continue
      }
      out.healed.push(sku)
      try {
        await db.from('keyword_push_log').insert({
          parent_asin, sku, field: `heal:twin:${containerKey}`,
          previous_value: null, new_value: JSON.stringify(item),
          submission_id: live.submissionId, status: 'accepted', error_message: null,
          pushed_by: SYSTEM_ACTOR.id,
        })
      } catch (e) { console.warn('[twin-heal] keyword_push_log insert failed (non-fatal):', e instanceof Error ? e.message : e) }
    }
    // firstErrors: the diagnosis payload — attempt 2 live showed failed:70 with NO reason visible
    // anywhere (the queue note carries SKU names only). Three examples name the wall exactly.
    const firstErrors = Object.entries(out.errors ?? {}).slice(0, 3).map(([s, e]) => `${s}: ${e}`)
    console.log(JSON.stringify({ tag: 'TWIN_HEAL', parent_asin, containerKey, healed: out.healed.length, abstained: out.abstained.length, failed: out.failed.length, writes, firstErrors }))
  } catch (e) {
    console.warn('[twin-heal] failed (non-fatal):', e instanceof Error ? e.message : e)
    for (const sku of skus) if (!out.healed.includes(sku) && !out.failed.includes(sku) && !out.abstained.includes(sku)) out.failed.push(sku)
  }
  return out
}

/** PARENTAGE CONFIRMATION for the delete-partial heal (adversarial review 2026-07-02, fix 2).
 *  findParentSku equality only proves LOOKUP CONSISTENCY (both sides resolved the same row for the
 *  ASIN) — it does NOT prove the SKU is a variation-parent hub. Positively confirm via a live GET with
 *  includedData=summaries,relationships that the SKU is a NON-BUYABLE VARIATION PARENT — EITHER:
 *   (a) a VARIATION relationship in the PARENT direction: type='VARIATION' carrying non-empty
 *       childSkus/childAsins (a CHILD's VARIATION entry carries parentSkus/parentAsins instead and
 *       must NOT confirm), OR
 *   (b) summaries present and NONE carrying a BUYABLE status (a variation hub is never buyable).
 *  Neither confirmable → { confirmed:false } and the caller REFUSES the delete (never delete on
 *  uncertainty). `fetchFailed` distinguishes a dead GET (transient — failed bucket only, the queue
 *  retries) from a positive "this does not look like a variation parent" (failed bucket + a durable
 *  needs_attention flag so a human decides). Response shapes are handled defensively — any field can
 *  be absent/malformed without throwing.
 *  `childCount` (fix 3, adversarial review 2026-07-02): the LARGEST child count any VARIATION
 *  parent-direction relationship reports (0 when none) — recorded at heal time as the shrink baseline
 *  for the delayed family-integrity check, and read again by that check 6h later. */
async function confirmNonBuyableVariationParent(
  sellerId: string, token: string, sku: string,
): Promise<{ confirmed: boolean; fetchFailed: boolean; reason: string; childCount: number }> {
  try {
    const url =
      `${ENDPOINT}/listings/2021-08-01/items/${sellerId}/${encodeURIComponent(sku)}` +
      `?marketplaceIds=${MARKETPLACE_ID}&includedData=summaries,relationships`
    await spApiReadBucket.acquire()   // global 5-rps ceiling for getListingsItem reads (task #23) — 1 token per GET
    const resp = await fetch(url, { headers: { 'x-amz-access-token': token } })
    if (!resp.ok) return { confirmed: false, fetchFailed: true, reason: `parentage GET HTTP ${resp.status}`, childCount: 0 }
    const json = (await resp.json()) as {
      summaries?: { status?: string[] }[]
      relationships?: { relationships?: { type?: string; childSkus?: string[]; childAsins?: string[] }[] }[]
    }
    const relGroups = Array.isArray(json.relationships) ? json.relationships : []
    let childCount = 0
    for (const g of relGroups) {
      for (const r of (Array.isArray(g?.relationships) ? g.relationships : [])) {
        if (r?.type !== 'VARIATION') continue
        const n = Math.max(
          Array.isArray(r.childSkus) ? r.childSkus.length : 0,
          Array.isArray(r.childAsins) ? r.childAsins.length : 0,
        )
        if (n > childCount) childCount = n
      }
    }
    const isVariationParent = childCount > 0
    if (isVariationParent) return { confirmed: true, fetchFailed: false, reason: 'VARIATION parent relationship with children', childCount }
    const summaries = Array.isArray(json.summaries) ? json.summaries : []
    const nonBuyable = summaries.length > 0 &&
      summaries.every((s) => !(Array.isArray(s?.status) && s.status.includes('BUYABLE')))
    if (nonBuyable) return { confirmed: true, fetchFailed: false, reason: 'summaries present with no BUYABLE status', childCount: 0 }
    return {
      confirmed: false, fetchFailed: false,
      reason: 'no VARIATION parent relationship with children and summaries do not show non-buyable - cannot positively confirm this SKU is the variation-parent hub',
      childCount: 0,
    }
  } catch (e) {
    return { confirmed: false, fetchFailed: true, reason: `parentage GET threw: ${e instanceof Error ? e.message.slice(0, 120) : String(e).slice(0, 120)}`, childCount: 0 }
  }
}

/**
 * FIX 3 (adversarial review 2026-07-02) — the DELAYED family-integrity check the cron runs ~6h after a
 * confirmed strategy-3 complete write. The feared harm of writing a per-variant `size` onto the hub is
 * variation DE-LINKING, which manifests on Amazon's 15min-6hr catalog lag — invisible to the heal's own
 * preview/read-back. Re-reads the live relationships via confirmNonBuyableVariationParent:
 *  - VARIATION parent relationship GONE (childCount 0) → NOT intact (flag: verify in Seller Central);
 *  - live child count SHRANK vs the count recorded at heal time → NOT intact;
 *  - otherwise intact. `fetchFailed` = OUR read failed (soft-fail + re-check next tick, no verdict).
 * NON-THROWING — every failure lands in the returned shape.
 */
export async function checkHealFamilyIntegrity(
  args: { parentSku: string; recordedChildCount: number },
): Promise<{ intact: boolean; fetchFailed: boolean; detail: string }> {
  try {
    const token = await getAccessToken()
    const sellerId = await getSellerId()
    const parentage = await confirmNonBuyableVariationParent(sellerId, token, args.parentSku)
    if (parentage.fetchFailed) return { intact: false, fetchFailed: true, detail: parentage.reason }
    if (parentage.childCount === 0) {
      return { intact: false, fetchFailed: false, detail: 'the VARIATION parent relationship is gone - the live record reports no variation children' }
    }
    if (args.recordedChildCount > 0 && parentage.childCount < args.recordedChildCount) {
      return { intact: false, fetchFailed: false, detail: `the live variation child count shrank to ${parentage.childCount} (was ${args.recordedChildCount} at heal time)` }
    }
    return { intact: true, fetchFailed: false, detail: `VARIATION family intact: ${parentage.childCount} live children (recorded ${args.recordedChildCount} at heal time)` }
  } catch (e) {
    return { intact: false, fetchFailed: true, detail: `family-integrity check threw: ${e instanceof Error ? e.message.slice(0, 160) : String(e).slice(0, 160)}` }
  }
}

/**
 * STRATEGY 2 — delete the PARTIAL composite container from the parent hub (heal v2, LIVE evidence
 * 2026-07-02). Reached ONLY from healParentComposite when strategy 1's (verbatim-mirror) preview fails
 * with the conditional-requirement signature: the hub carries size_system/size_class but can never carry
 * the per-variant `size`, so ANY write that keeps the container present re-trips Amazon's "if system/class
 * present then size required" rule. Deleting the container makes the conditional rule unreachable and
 * parent PATCHes validate clean.
 *
 * HARD GUARDRAILS (a delete is destructive — every one is enforced here, not just documented):
 *  - PARENT HUB ONLY: the SKU being patched is ALWAYS args.parentSku (no other SKU variable exists in
 *    this scope), and the caller guarantees parentSku IS the variation-parent hub (it came from the
 *    failed push row with isParent=true). Defensively RE-CONFIRMED live below via findParentSku on the
 *    parent ASIN — a mismatch (stale/malformed payload) or a failed lookup ABORTS: NEVER delete an
 *    attribute from a child.
 *  - PARENTAGE-CONFIRMED (fix 2): equality alone proves lookup consistency, not parentage — the SKU
 *    must ALSO be positively confirmed as a non-buyable variation parent via
 *    confirmNonBuyableVariationParent (VARIATION-with-children relationship OR non-buyable summaries);
 *    anything unconfirmable REFUSES the delete.
 *  - LIVE-STATE-GATED (fix 1, TOCTOU): the trigger only proved the SUBMITTED mirror payload was
 *    partial (it always is — strategy 1 writes subKeys only), NOT that the LIVE container is. The
 *    container is re-READ here first: already ABSENT → healed as a no-op (no write); GENUINELY PARTIAL
 *    (perVariantField empty on every item) → proceed; COMPLETE (any item carries it — e.g. the seller
 *    just fixed it in Seller Central while the task was pending) → REFUSE + flag for a human; a dead
 *    pre-read GET → failure (retry), never "safe to proceed".
 *  - REGISTRY-GATED: only containers listed in COMPOSITE_HEAL_SPECS can reach here (the caller resolves
 *    `spec` from that registry; unregistered containers have no spec and fall to the failed bucket).
 *  - PREVIEW-GATED: the delete op runs VALIDATION_PREVIEW first, like every write in this module.
 *  - INTENT-LOGGED (fix 4a): a keyword_push_log row (status 'attempted', new_value 'DELETE-INTENT') is
 *    written BEFORE the LIVE delete so a crash between the PATCH and the read-back still leaves durable
 *    evidence a delete was issued; the row flips to 'accepted' on confirmed read-back.
 *  - READ-BACK-VERIFIED: success is the container being ABSENT on a live re-read — a failed re-read is
 *    a FAILURE (retry), never assumed success.
 *  - STRATEGY-3 FALLBACK (heal v3, LIVE evidence 2026-07-02; TIGHTENED by adversarial review fix 1):
 *    when the DELETE's VALIDATION_PREVIEW fails with Amazon's STRUCTURED "An internal error has
 *    occurred" issues[] verdict (NOT an HTTP-prefixed transport body) — an Amazon-side PROCESSING
 *    failure, not a validation verdict (observed 3 consecutive times over 40 min on the recorded task
 *    rows) — AND this is already the 2nd+ queue attempt (persistence, matching that evidence), fall
 *    through IN THE SAME ATTEMPT to healCompositeCompleteWrite (write ONE COMPLETE container item
 *    instead). The FIRST structured internal error rides the failed bucket so the queue retries the
 *    cleaner delete once. A NON-internal preview error keeps the existing failed-bucket path.
 * NON-THROWING; failures land in the returned buckets with errors[] observability. Learns a
 * push_heal_rules row (resolution 'delete_partial_container') ONLY after the confirmed read-back, which
 * also OVERWRITES any stale 'inherit_from_child' rule for this container so the Tier-2 pre-fill stops
 * re-adding the partial container on future pushes (pre-fill itself never deletes — see
 * resolvePrefillAttrs).
 */
async function healCompositeDeletePartial(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  args: {
    parent_asin: string; parentSku: string; productType: string; spec: CompositeHealSpec
    sellerId: string; token: string
    /** Strategy 1's already-fetched sampled-child attributes map — passed through so the strategy-3
     *  complete-write fallback can REUSE it instead of re-issuing HEAL_SAMPLE_CAP live GETs. */
    childAttrs: Map<string, Record<string, unknown> | null>
    /** The queue task's `attempts` counter (fix 1): strategy-3 escalation requires attemptNumber >= 1
     *  — the FIRST structured internal error only earns one more clean delete retry. */
    attemptNumber: number
  },
): Promise<HealResult> {
  const { parent_asin, parentSku, productType, spec, sellerId, token, childAttrs, attemptNumber } = args
  const containerKey = spec.containerKey
  const out: HealResult = { healed: [], abstained: [], failed: [] }
  try {
    // GUARDRAIL: live re-confirmation that parentSku is THE variation-parent hub SKU of this ASIN.
    // findParentSku resolves the parent ASIN's own listing SKU from Listings Items — if it disagrees
    // (or cannot be resolved), abort to the failed bucket; the queue's backoff retries a transient
    // lookup failure, and a genuine mismatch surfaces as needs_attention instead of a wrong-target delete.
    const liveParentSku = await findParentSku(sellerId, token, parent_asin)
    if (!liveParentSku || liveParentSku !== parentSku) {
      out.failed.push(containerKey)
      ;(out.errors ??= {})[containerKey] = liveParentSku
        ? `delete guardrail: live parent-hub SKU "${liveParentSku}" does not match task parentSku "${parentSku}" - refusing to delete`
        : 'delete guardrail: could not confirm the parent-hub SKU via live lookup - refusing to delete'
      return out
    }

    // PARENTAGE CONFIRMATION (adversarial review 2026-07-02, fix 2): the equality above proves both
    // lookups resolved the SAME row — not that the row is a variation-parent hub. Positively confirm
    // (VARIATION-with-children relationship OR non-buyable summaries) before any delete. Unconfirmable
    // → REFUSE: a dead GET rides the failed bucket (queue retries); a positive "does not look like a
    // variation parent" additionally flags durable needs_attention so a human decides.
    const parentage = await confirmNonBuyableVariationParent(sellerId, token, parentSku)
    if (!parentage.confirmed) {
      out.failed.push(containerKey)
      ;(out.errors ??= {})[containerKey] = `delete parentage guardrail: ${parentage.reason} - refusing to delete`
      if (!parentage.fetchFailed) {
        try {
          const { flagParentAttrsNeedAttention } = await import('@/lib/fba/verificationQueue')
          await flagParentAttrsNeedAttention(parent_asin, [containerKey])
        } catch (e) { console.warn('[push-heal] delete parentage flag-attention failed (non-fatal):', e instanceof Error ? e.message : e) }
      }
      return out
    }

    // LIVE-STATE GATE (adversarial review 2026-07-02, fix 1 — TOCTOU): the strategy-2 trigger only
    // proved the SUBMITTED mirror payload was partial — strategy 1 always writes subKeys only, so that
    // is ALWAYS true — NOT that the LIVE container is partial. A seller may have just completed Shirt
    // Size manually in Seller Central while this heal task was pending; deleting then would destroy
    // their fix. Re-read the LIVE parent container and gate the delete on its ACTUAL state.
    await sleep(PATCH_DELAY_MS)
    const preRead = await fetchChildAttributesMap(sellerId, token, [parentSku])
    const preAttrs = preRead.get(parentSku)
    if (!preAttrs) {
      // A dead pre-read GET must never look like "safe to proceed" (same polarity rule as the
      // read-back below) — failed bucket, the queue's backoff retries it.
      out.failed.push(containerKey)
      ;(out.errors ??= {})[containerKey] = 'delete pre-read fetch failed - cannot confirm the live container state; refusing to delete'
      return out
    }
    const preRaw = preAttrs[containerKey]
    if (preRaw === undefined || preRaw === null || (Array.isArray(preRaw) && preRaw.length === 0)) {
      // Container ALREADY ABSENT. This is a legitimate "goal state already holds" ONLY when WE issued a
      // delete for this parent+container (a retry after a successful delete whose read-back confirmation
      // was lost). Absent WITHOUT our own delete evidence means the record was REJECTING while the
      // container was absent — deletion cannot be the cure (a schema-level requirement, not the
      // partial-container disease) — and silently reporting healed would false-converge in a polite
      // infinite loop with no alert (verification workflow 2026-07-02, convergence-hole audit).
      let weDeletedIt = false
      try {
        const { data: ev } = await db.from('keyword_push_log')
          .select('id').eq('parent_asin', parent_asin).eq('sku', parentSku)
          .eq('field', `heal:delete:${containerKey}`).in('status', ['attempted', 'accepted']).limit(1)
        weDeletedIt = Array.isArray(ev) && ev.length > 0
      } catch { /* evidence unreadable -> treat as NOT ours (the safe polarity: surface, don't converge) */ }
      if (weDeletedIt) {
        out.healed.push(containerKey)
        return out
      }
      out.failed.push(containerKey)
      ;(out.errors ??= {})[containerKey] = 'container is absent on the live record yet the record still rejects - deletion cannot be the cure (schema-level requirement); needs human review'
      try {
        const { flagParentAttrsNeedAttention } = await import('@/lib/fba/verificationQueue')
        await flagParentAttrsNeedAttention(parent_asin, [containerKey])
      } catch (e) { console.warn('[push-heal] absent-branch flag-attention failed (non-fatal):', e instanceof Error ? e.message : e) }
      return out
    }
    const preItems = Array.isArray(preRaw)
      ? preRaw.filter((it): it is Record<string, unknown> => it != null && typeof it === 'object' && !Array.isArray(it))
      : []
    // GENUINELY PARTIAL = the per-variant field ('size') absent/empty on EVERY item of the container.
    // If ANY item carries it the live container is COMPLETE — this is NOT the partial-container disease
    // and the delete would destroy a real value: refuse + flag so a human decides. A present-but-
    // uninspectable shape (not an array of item objects) is UNCERTAINTY and refuses the same way.
    if (preItems.length === 0 || preItems.some((it) => compositeItemCarries(it, spec.perVariantField))) {
      // COMPLETE-container convergence (heal v3): a complete container IS the GOAL STATE of the
      // strategy-3 complete-write fallback. If WE issued a complete-write for this parent+container
      // (a retry after a successful strategy-3 write whose read-back confirmation was lost) AND the
      // live first item still subset-matches what that intent row says we wrote, the disease is cured —
      // report healed instead of a false-alarm needs_attention. Same our-own-evidence pattern as the
      // absent-branch's weDeletedIt above; anything weaker (no row, unparseable/vacuous payload, live
      // state diverged, evidence too old) falls through to refuse+flag so a human decides.
      // BOUNDED EVIDENCE (adversarial review 2026-07-02, fix 2): the old query was unbounded in time,
      // unordered, .limit(1) — one eternal accepted row would mask every FUTURE different rejection as
      // healed forever. Now: newest-first, only rows within HEAL_EVIDENCE_WINDOW_MS, ANY matching row
      // wins, the written payload must COVER subKeys + perVariantField (no vacuous convergence), and a
      // matched row still sitting at 'attempted' is flipped to 'accepted' so the audit trail stops
      // reading as a crash. The evaluation itself is the pure findCompleteWriteEvidence (healEvidence.ts).
      if (preItems.length > 0) {
        let evidence: { id?: string; status?: string } | null = null
        try {
          const sinceIso = new Date(Date.now() - HEAL_EVIDENCE_WINDOW_MS).toISOString()
          const { data: ev } = await db.from('keyword_push_log')
            .select('id, new_value, status, pushed_at')
            .eq('parent_asin', parent_asin).eq('sku', parentSku)
            .eq('field', `heal:complete:${containerKey}`).in('status', ['attempted', 'accepted'])
            .gte('pushed_at', sinceIso)
            .order('pushed_at', { ascending: false })
            .limit(HEAL_EVIDENCE_MAX_ROWS)
          evidence = findCompleteWriteEvidence(
            (ev ?? []) as { id?: string; new_value?: string | null; status?: string; pushed_at?: string | null }[],
            preItems[0],
            spec,
          )
        } catch { /* evidence unreadable/unparseable -> treat as NOT ours (surface, don't converge) */ }
        if (evidence) {
          // (fix 2d) Flip a still-'attempted' intent row to 'accepted': convergence IS the lost
          // read-back confirmation, and the audit trail must say so. Best-effort — the heal verdict
          // stands either way; pushed_at is deliberately NOT touched (it is the evidence timestamp).
          if (evidence.status === 'attempted' && evidence.id) {
            try {
              await db.from('keyword_push_log').update({ status: 'accepted' }).eq('id', evidence.id)
            } catch (e) { console.warn('[push-heal] convergence intent-row accept-flip failed (non-fatal):', e instanceof Error ? e.message : e) }
          }
          out.healed.push(containerKey)
          return out
        }
      }
      out.failed.push(containerKey)
      ;(out.errors ??= {})[containerKey] = preItems.length === 0
        ? 'live container has an uninspectable shape - cannot prove it is partial; refusing to delete'
        : `live container carries ${spec.perVariantField} - not the partial-container disease; refusing to delete`
      try {
        const { flagParentAttrsNeedAttention } = await import('@/lib/fba/verificationQueue')
        await flagParentAttrsNeedAttention(parent_asin, [containerKey])
      } catch (e) { console.warn('[push-heal] delete live-state flag-attention failed (non-fatal):', e instanceof Error ? e.message : e) }
      return out
    }

    // Delete the container for THIS marketplace — preview first, exactly like every other write here.
    // Amazon's patchListingsItem is NOT plain RFC-6902: a delete op REQUIRES a `value` acting as a
    // SELECTOR for which attribute instances to remove (a value-less delete op is rejected with
    // HTTP 400 InvalidInput "Invalid empty value provided in patch at index of 0" — recorded live
    // 2026-07-02 on attempt 2). The marketplace_id selector matches the container instances written
    // for this marketplace (the documented delete pattern; SP-API partially-update-a-listing).
    const ops = [{ op: 'delete' as const, path: `/attributes/${containerKey}`, value: [{ marketplace_id: MARKETPLACE_ID }] }]
    const preview = await patchSkuMulti(sellerId, token, productType, parentSku, ops, 'VALIDATION_PREVIEW')
    if (!preview.ok) {
      // STRATEGY-3 TRIGGER (heal v3, LIVE evidence 2026-07-02): "An internal error has occurred.
      // Please try again." on the delete preview is an AMAZON-SIDE PROCESSING failure, not a
      // validation verdict — recorded 3 consecutive times over 40 min (19:41 / 19:49 / 20:17) on the
      // task rows: Amazon's validator cannot process this delete, so more delete-only retries burn
      // queue attempts for nothing. Escalate to the complete-write fallback (SP-API semantics: the
      // conditional rule is only "size must have >=1 value WHEN size_system/size_class are present",
      // so ONE COMPLETE item satisfies it). All the guardrails above (parent identity + parentage
      // proof + proven-partial pre-read) have already passed in this very attempt.
      // TIGHTENED TRIGGER (adversarial review 2026-07-02, fix 1): the old bare `/internal error/i`
      // on preview.error (a) also matched HTTP-prefixed TRANSPORT bodies (patchSkuMulti returns
      // 'HTTP 500: {...}' for a non-ok response — a proxy blip must never trigger a LIVE composite
      // write), and (b) fired on the FIRST occurrence while the recorded evidence was a PERSISTENT
      // verdict. classifyDeletePreviewFailure (pure, healEvidence.ts) now requires a STRUCTURED
      // issues[] internal-error message with no HTTP prefix, AND attemptNumber >= 1 — the first
      // structured internal error rides the failed bucket so the queue retries the cleaner delete
      // once before any escalation. A NON-internal preview error is a real validation verdict and
      // keeps the existing failed-bucket path unchanged.
      const action = classifyDeletePreviewFailure(preview, attemptNumber)
      if (action === 'escalate-complete-write') {
        console.warn(`[push-heal] delete preview for ${containerKey} on ${parentSku} failed with a PERSISTENT Amazon INTERNAL error (attempt ${attemptNumber + 1}, "${(preview.error ?? '').slice(0, 120)}") - falling through to the complete-write fallback in the same attempt.`)
        return await healCompositeCompleteWrite(db, { parent_asin, parentSku, productType, spec, sellerId, token, childAttrs, provenPartialItems: preItems, liveChildCount: parentage.childCount })
      }
      if (action === 'retry-delete') {
        console.warn(`[push-heal] delete preview for ${containerKey} on ${parentSku} hit an Amazon INTERNAL error on the FIRST attempt - recording failed so the queue retries the cleaner delete once before escalating.`)
        out.failed.push(containerKey)
        ;(out.errors ??= {})[containerKey] = `delete preview: Amazon internal error on attempt ${attemptNumber + 1} - the queue will retry the delete once before escalating to the complete-write strategy: ${preview.error ?? 'internal error'}`
        return out
      }
      out.failed.push(containerKey); (out.errors ??= {})[containerKey] = `delete preview: ${preview.error ?? 'rejected'}`; return out
    }

    // INTENT AUDIT ROW (adversarial review 2026-07-02, fix 4a): record that a LIVE delete is about to
    // be issued BEFORE issuing it, so a crash between the PATCH and the read-back still leaves durable
    // evidence. Best-effort: a failed intent insert PROCEEDS (the audit trail must not block the heal)
    // but warns loudly. On confirmed read-back the row is flipped to 'accepted' below; a delete that
    // fails read-back deliberately leaves it at 'attempted' — that IS the audit signal.
    let intentRowId: string | null = null
    try {
      const { data: intentData, error: intentErr } = await db.from('keyword_push_log').insert({
        parent_asin, sku: parentSku, field: `heal:delete:${containerKey}`,
        previous_value: null, new_value: 'DELETE-INTENT',
        submission_id: null, status: 'attempted', error_message: null,
        pushed_by: SYSTEM_ACTOR.id,
      }).select('id')
      if (intentErr) console.warn('[push-heal] delete INTENT log insert failed (best-effort, proceeding):', intentErr?.message ?? intentErr)
      else intentRowId = (intentData as { id?: string }[] | null)?.[0]?.id ?? null
    } catch (e) { console.warn('[push-heal] delete INTENT log insert threw (best-effort, proceeding):', e instanceof Error ? e.message : e) }

    const live = await patchSkuMulti(sellerId, token, productType, parentSku, ops, 'LIVE')
    if (!live.ok) { out.failed.push(containerKey); (out.errors ??= {})[containerKey] = `delete live: ${live.error ?? 'rejected'}`; return out }

    // READ-BACK: success = the container is now ABSENT on the hub. NOTE the polarity trap: for a delete,
    // a FAILED re-read would look identical to "absent" — so an unreadable attributes payload is treated
    // as NOT CONFIRMED (failed bucket → queue retries), never as success.
    await sleep(PATCH_DELAY_MS)
    const parentAttrs = await fetchChildAttributesMap(sellerId, token, [parentSku])
    const attrs = parentAttrs.get(parentSku)
    if (!attrs) {
      out.failed.push(containerKey)
      ;(out.errors ??= {})[containerKey] = 'delete read-back fetch failed - cannot confirm the container was removed'
      return out
    }
    const raw = attrs[containerKey]
    const absent = raw === undefined || raw === null || (Array.isArray(raw) && raw.length === 0)
    if (!absent) {
      console.warn(`[push-heal] delete read-back for ${containerKey} on ${parentSku}: container still present; marking failed.`)
      out.failed.push(containerKey)
      ;(out.errors ??= {})[containerKey] = 'delete accepted but container still present on read-back'
      return out
    }

    // Confirmed absent → healed. Flip the INTENT row to 'accepted' (fix 4a — or insert the accepted
    // row directly if the intent write failed) + learn the delete rule so this (product_type,
    // container) resolution is remembered; the upsert REPLACES a stale inherit_from_child rule, which
    // also stops the Tier-2 pre-fill from re-adding the partial container.
    out.healed.push(containerKey)
    try {
      if (intentRowId) {
        await db.from('keyword_push_log').update({
          new_value: JSON.stringify({ action: 'delete' }),
          submission_id: live.submissionId, status: 'accepted',
          pushed_at: new Date().toISOString(),
        }).eq('id', intentRowId)
      } else {
        await db.from('keyword_push_log').insert({
          parent_asin, sku: parentSku, field: `heal:delete:${containerKey}`,
          previous_value: null, new_value: JSON.stringify({ action: 'delete' }),
          submission_id: live.submissionId, status: 'accepted', error_message: null,
          pushed_by: SYSTEM_ACTOR.id,
        })
      }
    } catch (e) { console.warn('[push-heal] delete keyword_push_log accept-log failed (non-fatal):', e instanceof Error ? e.message : e) }
    try {
      const { data: existing } = await db.from('push_heal_rules')
        .select('hit_count').eq('product_type', productType).eq('attr_key', containerKey).maybeSingle()
      const prevHits = (existing as { hit_count?: number } | null)?.hit_count ?? 0
      await db.from('push_heal_rules').upsert({
        product_type: productType, attr_key: containerKey,
        sub_keys: spec.subKeys,
        resolution: 'delete_partial_container', resolved_value: { action: 'delete' },
        last_seen_at: new Date().toISOString(), hit_count: prevHits + 1,
      }, { onConflict: 'product_type,attr_key' })
    } catch (e) { console.warn('[push-heal] delete push_heal_rules upsert failed (non-fatal):', e instanceof Error ? e.message : e) }
  } catch (e) {
    // A throw mid-delete is NOT a safe abstain (the parent is known-broken and this path is its only
    // fix) — ride the failed bucket so the queue's attempts/backoff retry it.
    console.warn('[push-heal] healCompositeDeletePartial threw (non-fatal):', e instanceof Error ? e.message : e)
    if (!out.healed.includes(containerKey) && !out.failed.includes(containerKey)) {
      out.failed.push(containerKey)
      ;(out.errors ??= {})[containerKey] = `delete threw: ${e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200)}`
    }
  }
  return out
}

/**
 * STRATEGY 3 — write ONE COMPLETE composite item to the parent hub (heal v3, LIVE evidence 2026-07-02).
 * Reached ONLY from healCompositeDeletePartial when the DELETE's VALIDATION_PREVIEW fails with Amazon's
 * "An internal error has occurred" — an Amazon-side PROCESSING failure, not a validation verdict, so
 * strategy 2 is unprocessable no matter how often the queue retries it. SP-API semantics research
 * blessed the alternative: the conditional rule is only "size must have >=1 value WHEN
 * size_system/size_class are present" — so ONE COMPLETE shirt_size item (size_system + size_class +
 * size) satisfies the validator. The live children carry complete items and PATCH fine; a per-variant
 * `size` on a NON-BUYABLE variation hub is display-inert.
 *
 * GUARDRAILS (the ONLY call site sits BEHIND all of these in the SAME attempt):
 *  - the parent-identity guard (findParentSku equality), the confirmNonBuyableVariationParent
 *    parentage proof, AND the live pre-read that proved the container GENUINELY PARTIAL have all
 *    already passed. Strategy 3 only makes sense when the live container is partial (a complete
 *    container has nothing to complete); `provenPartialItems` is that exact pre-read state and is
 *    RE-ASSERTED here before any write.
 *  - DONOR REUSE: the donor item comes from strategy 1's already-fetched sampled-child map (no
 *    re-fetch); the FIRST sampled child whose first container item carries EVERY invariant subKey AND
 *    a non-empty per-variant field wins. Its item is copied VERBATIM — only marketplace_id is
 *    normalized to OUR marketplace.
 *  - PREVIEW-GATED; INTENT-LOGGED (keyword_push_log 'attempted' row, field 'heal:complete:<container>',
 *    written BEFORE the LIVE write — same pattern as strategy 2's DELETE-INTENT); READ-BACK-VERIFIED
 *    (tolerant subsetDeepEqual on EVERY written sub-key INCLUDING the per-variant `size`).
 *  - NO RULE LEARNING: deliberately does NOT learn a push_heal_rules pre-fill rule — this is a
 *    ONE-TIME fix for THIS hub. The Tier-2 pre-fill runs on EVERY future parent push and must NEVER
 *    re-write the per-variant `size` onto shared hubs (that is exactly the per-variant-on-shared-hub
 *    mistake the composite registry exists to prevent).
 *  - STALE-RULE UNLEARN (adversarial review fix 4): on confirmed success, DELETE any product-type-wide
 *    'inherit_from_child' push_heal_rules row for this container — left standing it would keep
 *    pre-filling PARTIAL (subKeys-only) replaces OVER the completed container on every future push,
 *    re-arming the very disease this write just cured. Best-effort, logged.
 *  - DELAYED FAMILY-INTEGRITY CHECK (adversarial review fix 3): the feared harm of a per-variant
 *    `size` on the hub is variation DE-LINKING, which manifests on Amazon's 15min-6hr catalog lag —
 *    invisible to this attempt's preview/read-back. On confirmed success a ONE-SHOT queue task
 *    (field 'heal:family-check', next_check_at now+6h, max_attempts 1) is enqueued; the cron re-reads
 *    the live relationships and flags needs_attention if the VARIATION family is gone or shrank.
 *  - STRATEGY-4 NEGOTIATION (heal v4, LIVE evidence 2026-07-02): when THIS write's preview fails
 *    WITH STRUCTURED ISSUES (a real validation verdict, not transport), the fail-out is replaced by
 *    negotiateParentRecordFix — the record can be a CONDITIONAL WEB (the complete shirt_size
 *    satisfied the size rule, which then DISALLOWED shirt_body_type/shirt_height_type "at most 0")
 *    where fixing one rule arms another, so the preview is iterated as a negotiation instead of
 *    giving up. Issue-free (transport-level) preview failures keep the plain failed bucket.
 * NON-THROWING; every failure lands in the failed bucket with an errors[] string prefixed
 * 'delete preview internal error -> complete-write fallback: <stage>: <reason>' so the task rows
 * distinguish this path from a plain strategy-2 failure. A read-back mismatch additionally flags
 * durable needs_attention (Amazon accepted then silently dropped — a dead-end a human must see).
 */

/** DONOR SELECTION shared by strategy 3 (complete-write) and strategy 4's other-composite extension:
 *  the FIRST sampled live child whose FIRST container item is COMPLETE — every invariant subKey
 *  present AND the per-variant field non-empty. Reuses strategy 1's already-fetched map; no GETs. */
function selectCompleteDonorItem(
  childAttrs: Map<string, Record<string, unknown> | null>, spec: CompositeHealSpec,
): { donor: CompositeItem; donorSku: string } | null {
  for (const [sku, attrs] of childAttrs) {
    const raw = attrs?.[spec.containerKey]
    if (!Array.isArray(raw) || raw.length === 0) continue
    const first = raw[0]
    if (first == null || typeof first !== 'object' || Array.isArray(first)) continue
    const firstObj = first as CompositeItem
    if ([...spec.subKeys, spec.perVariantField].every((k) => compositeItemCarries(firstObj, k))) {
      return { donor: firstObj, donorSku: sku }
    }
  }
  return null
}

/** CONFIRMED-success side-effects shared by strategy 3 (complete-write) and strategy 4 (negotiation)
 *  — both end with the SAME live state (a complete container on the hub), so both need:
 *  (a) FIX 4 (adversarial review 2026-07-02): unlearn a stale product-type-wide 'inherit_from_child'
 *      push_heal_rules row for this container — left standing it would keep pre-filling PARTIAL
 *      (subKeys-only) replaces OVER the completed container on every future push, re-arming the very
 *      disease this write just cured. Scoped: ONLY resolution='inherit_from_child' (a learned
 *      'delete_partial_container' rule is a DIFFERENT, still-valid lesson and stays).
 *  (b) FIX 3 (adversarial review 2026-07-02): enqueue the ONE-SHOT delayed family-integrity check
 *      (now + 6h, max_attempts 1) — variation de-linking caused by a per-variant `size` on the hub
 *      only manifests on Amazon's 15min-6hr catalog lag, invisible to the heal's own read-back.
 *      Baseline: the parentage confirmation's live child count; when that path confirmed via
 *      summaries only (count 0), the sampled-child map size (a floor, never an overcount).
 *  Best-effort, non-throwing, logged either way. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function completeWriteSuccessSideEffects(db: any, args: {
  parent_asin: string; parentSku: string; productType: string; containerKey: string
  liveChildCount: number; sampledChildCount: number
}): Promise<void> {
  const { parent_asin, parentSku, productType, containerKey, liveChildCount, sampledChildCount } = args
  try {
    const { data: unlearned, error: unlearnErr } = await db.from('push_heal_rules')
      .delete()
      .eq('product_type', productType)
      .eq('attr_key', containerKey)
      .eq('resolution', 'inherit_from_child')
      .select('attr_key')
    if (unlearnErr) {
      console.warn('[push-heal] complete-write inherit-rule unlearn failed (non-fatal):', unlearnErr?.message ?? unlearnErr)
    } else {
      const n = ((unlearned ?? []) as { attr_key: string }[]).length
      if (n > 0) console.warn(`[push-heal] complete-write: unlearned ${n} stale inherit_from_child push_heal_rules row(s) for (${productType}, ${containerKey}) - the pre-fill must not re-arm the partial container over the completed one.`)
    }
  } catch (e) { console.warn('[push-heal] complete-write inherit-rule unlearn threw (non-fatal):', e instanceof Error ? e.message : e) }

  try {
    const recordedChildCount = liveChildCount > 0 ? liveChildCount : sampledChildCount
    const { enqueueFamilyIntegrityCheck } = await import('@/lib/fba/verificationQueue')
    await enqueueFamilyIntegrityCheck(parent_asin, {
      parentSku, productType, childCount: recordedChildCount, containerKey,
    })
  } catch (e) { console.warn('[push-heal] complete-write family-check enqueue failed (non-fatal):', e instanceof Error ? e.message : e) }
}

async function healCompositeCompleteWrite(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  args: {
    parent_asin: string; parentSku: string; productType: string; spec: CompositeHealSpec
    sellerId: string; token: string
    childAttrs: Map<string, Record<string, unknown> | null>
    /** The delete gate's pre-read container items — the PROVEN-PARTIAL live state this fallback
     *  requires; re-asserted below so a future caller cannot skip the gate. */
    provenPartialItems: CompositeItem[]
    /** The live VARIATION child count from the caller's parentage confirmation (fix 3): recorded on
     *  the delayed family-integrity task as the shrink baseline. 0 = the parentage was confirmed via
     *  non-buyable summaries only; the sampled-child count is used as the fallback baseline then. */
    liveChildCount: number
  },
): Promise<HealResult> {
  const { parent_asin, parentSku, productType, spec, sellerId, token, childAttrs, provenPartialItems, liveChildCount } = args
  const containerKey = spec.containerKey
  const out: HealResult = { healed: [], abstained: [], failed: [] }
  const fail = (stage: string, reason: string) => {
    out.failed.push(containerKey)
    ;(out.errors ??= {})[containerKey] = `delete preview internal error -> complete-write fallback: ${stage}: ${reason}`
  }
  try {
    // ASSERT the state in hand: the caller's pre-read must have proven a PRESENT, GENUINELY PARTIAL
    // container (per-variant field empty on every item). Anything else means the gate was bypassed or
    // the state was misread — refuse to write.
    if (provenPartialItems.length === 0 || provenPartialItems.some((it) => compositeItemCarries(it, spec.perVariantField))) {
      fail('partial-assert', 'pre-read state is not a present, genuinely partial container - strategy 3 only applies to a proven-partial live container')
      return out
    }

    // DONOR SELECTION: first sampled live child whose FIRST container item is COMPLETE — every
    // invariant subKey present AND the per-variant field non-empty. Reuses strategy 1's map; no GETs.
    const selected = selectCompleteDonorItem(childAttrs, spec)
    if (!selected) {
      fail('child-selection', `no sampled live child carries a COMPLETE ${containerKey} item (every sub-key + non-empty ${spec.perVariantField})`)
      return out
    }
    console.warn(`[push-heal] complete-write fallback for ${containerKey} on ${parentSku}: donor child ${selected.donorSku}`)

    // Copy ONLY the schema-required sub-fields from the donor: spec.subKeys (size_system, size_class)
    // + spec.perVariantField (size) + marketplace_id. Strip every OTHER sub-field the donor carries
    // (body_type, height_type, size_to, etc.). Live probe 2026-07-20T21Z on PHE-STS-P (B0FKKN8XKV)
    // proved the disease: the parent's stored shirt_size[0] carries {body_type:'regular',
    // height_type:'regular', size_class:'alpha', size_system:'as1'} with NO size — Amazon's rule
    // 99022 fires ("size does not have enough values"), then every complete-write we tried copied
    // the donor's body_type/height_type verbatim, which armed the NEXT rule ("body_type Expected at
    // most '0'" once size is present) and stalled Strategy 4 for lack of a top-level attribute to
    // delete. Sending ONLY the schema-required sub-fields satisfies rule 99022 AND avoids arming the
    // "at most 0" rules, because op=replace on the whole container overwrites the stored state.
    const requiredKeys = new Set<string>([...spec.subKeys, spec.perVariantField])
    const item: CompositeItem = { marketplace_id: MARKETPLACE_ID }
    for (const k of requiredKeys) if (selected.donor[k] !== undefined) item[k] = selected.donor[k]
    const ops = [{ op: 'replace' as const, path: `/attributes/${containerKey}`, value: [item] }]
    const preview = await patchSkuMulti(sellerId, token, productType, parentSku, ops, 'VALIDATION_PREVIEW')
    if (!preview.ok) {
      // STRATEGY 4 — iterative preview negotiation (heal v4, LIVE evidence 2026-07-02): a STRUCTURED
      // rejection of the complete write means the record is a CONDITIONAL WEB (completing shirt_size
      // ARMED the "shirt_body_type/shirt_height_type not allowed - at most 0" rules on the recorded
      // Custom-Cup-TS-Parent case). Replace the fail-out with the negotiation loop — it starts from
      // THIS op set and THIS failed preview (no duplicate SP-API call), so the negotiation runs behind
      // the exact same gate chain that admitted strategy 3 (parent identity, parentage proof, proven-
      // partial pre-read, attemptNumber >= 1 persistence). An issue-free failure is transport-level
      // (HTTP wrapper) — transient, plain failed bucket, the queue's backoff retries it.
      if ((preview.issues ?? []).length > 0) {
        return await negotiateParentRecordFix(db, {
          parent_asin, parentSku, productType, spec, sellerId, token, childAttrs,
          donorItem: item, initialOps: ops, initialPreview: preview, liveChildCount,
        })
      }
      fail('preview', preview.error ?? 'rejected'); return out
    }

    // INTENT AUDIT ROW — same pattern as strategy 2's DELETE-INTENT: durable evidence BEFORE the LIVE
    // write so a crash between the PATCH and the read-back is still visible (and the pre-read's
    // COMPLETE-container convergence can recognize our own write on retry). new_value carries the
    // exact item written. Best-effort: a failed insert proceeds but warns loudly; the row flips to
    // 'accepted' only on confirmed read-back.
    let intentRowId: string | null = null
    try {
      const { data: intentData, error: intentErr } = await db.from('keyword_push_log').insert({
        parent_asin, sku: parentSku, field: `heal:complete:${containerKey}`,
        previous_value: null, new_value: JSON.stringify(item),
        submission_id: null, status: 'attempted', error_message: null,
        pushed_by: SYSTEM_ACTOR.id,
      }).select('id')
      if (intentErr) console.warn('[push-heal] complete-write INTENT log insert failed (best-effort, proceeding):', intentErr?.message ?? intentErr)
      else intentRowId = (intentData as { id?: string }[] | null)?.[0]?.id ?? null
    } catch (e) { console.warn('[push-heal] complete-write INTENT log insert threw (best-effort, proceeding):', e instanceof Error ? e.message : e) }

    const live = await patchSkuMulti(sellerId, token, productType, parentSku, ops, 'LIVE')
    if (!live.ok) { fail('live', live.error ?? 'rejected'); return out }

    // READ-BACK: EVERY sub-key we wrote (INCLUDING the per-variant `size`) must persist on the hub's
    // first container item — tolerant subset compare (Amazon may normalize/enrich what we wrote);
    // marketplace_id excluded (Amazon returns its own). A failed re-read is a FAILURE (queue retries),
    // never assumed success.
    await sleep(PATCH_DELAY_MS)
    const parentAttrs = await fetchChildAttributesMap(sellerId, token, [parentSku])
    const attrs = parentAttrs.get(parentSku)
    if (!attrs) {
      fail('read-back', 'read-back fetch failed - cannot confirm the complete container persisted')
      return out
    }
    const raw = attrs[containerKey]
    const parentFirst = Array.isArray(raw) && raw.length > 0 && raw[0] != null && typeof raw[0] === 'object' && !Array.isArray(raw[0])
      ? (raw[0] as CompositeItem)
      : null
    const writtenKeys = Object.keys(item).filter((k) => k !== 'marketplace_id')
    const persisted = parentFirst != null && writtenKeys.every((k) => {
      const got = parentFirst[k]
      if (got === undefined || got === null) return false
      return subsetDeepEqual(item[k], got)
    })
    if (!persisted) {
      console.warn(`[push-heal] complete-write read-back MISMATCH for ${containerKey} on ${parentSku}: Amazon accepted then dropped one or more sub-fields; marking failed + flagging for attention.`)
      fail('read-back mismatch', 'Amazon accepted the complete-container PATCH then silently dropped one or more sub-fields')
      try {
        const { flagParentAttrsNeedAttention } = await import('@/lib/fba/verificationQueue')
        await flagParentAttrsNeedAttention(parent_asin, [containerKey])
      } catch (e) { console.warn('[push-heal] complete-write flag-attention failed (non-fatal):', e instanceof Error ? e.message : e) }
      return out
    }

    // Confirmed persisted -> healed. Flip the INTENT row to 'accepted' (or insert the accepted row
    // directly if the intent write failed). Deliberately NO push_heal_rules learning here — see the
    // NO RULE LEARNING guardrail in the doc comment: the pre-fill must never re-write `size`.
    out.healed.push(containerKey)
    try {
      if (intentRowId) {
        await db.from('keyword_push_log').update({
          submission_id: live.submissionId, status: 'accepted',
          pushed_at: new Date().toISOString(),
        }).eq('id', intentRowId)
      } else {
        await db.from('keyword_push_log').insert({
          parent_asin, sku: parentSku, field: `heal:complete:${containerKey}`,
          previous_value: null, new_value: JSON.stringify(item),
          submission_id: live.submissionId, status: 'accepted', error_message: null,
          pushed_by: SYSTEM_ACTOR.id,
        })
      }
    } catch (e) { console.warn('[push-heal] complete-write keyword_push_log accept-log failed (non-fatal):', e instanceof Error ? e.message : e) }

    // Shared confirmed-success side-effects (FIX 4 stale inherit-rule unlearn + FIX 3 delayed
    // family-integrity check) — extracted to completeWriteSuccessSideEffects so strategy 4's
    // negotiation success runs the identical pair. Best-effort, non-throwing.
    await completeWriteSuccessSideEffects(db, { parent_asin, parentSku, productType, containerKey, liveChildCount, sampledChildCount: childAttrs.size })
  } catch (e) {
    // A throw mid-write is NOT a safe abstain (the parent is known-broken and this fallback is its
    // last automated fix) — ride the failed bucket so the queue's attempts/backoff retry it.
    console.warn('[push-heal] healCompositeCompleteWrite threw (non-fatal):', e instanceof Error ? e.message : e)
    if (!out.healed.includes(containerKey) && !out.failed.includes(containerKey)) {
      fail('threw', e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200))
    }
  }
  return out
}

/**
 * STRATEGY 4 — ITERATIVE PREVIEW NEGOTIATION (heal v4, LIVE evidence 2026-07-02). Reached ONLY from
 * healCompositeCompleteWrite when strategy 3's complete-write preview fails WITH STRUCTURED ISSUES —
 * so the entire strategy-3 gate chain (parent-identity guard, non-buyable parentage proof, live
 * pre-read proving the container GENUINELY PARTIAL, and the attemptNumber >= 1 persistence gate that
 * admits strategy 3 at all) has ALREADY passed in this same attempt. The negotiation replaces the
 * plain complete-write's preview fail-out EVERYWHERE strategy 3 runs; strategy 3's trigger is
 * unchanged.
 *
 * WHY (recorded on Custom-Cup-TS-Parent, SHIRT): "Based on the data from '[shirt_size#?.size_system,
 * age_range_description.value, shirt_size#?.size_class]', the field '"body_type"' for the attribute
 * 'Shirt Body Type' is not allowed. Expected at most '0' of field '"body_type"' ..." (identically
 * 'Shirt Height Type'). The complete shirt_size SATISFIED the size rule — which then DISALLOWED the
 * shirt_body_type/shirt_height_type attributes the record also carries. The record is a CONDITIONAL
 * WEB: fixing one rule arms another, so fixed per-error strategies cannot converge. Amazon's
 * VALIDATION_PREVIEW is free/synchronous, so we NEGOTIATE (runNegotiationLoop, healEvidence.ts):
 * preview -> parse the issues -> add the narrowest safe op per issue -> preview again (max
 * NEGOTIATION_MAX_ITERATIONS, ~200ms apart); ONLY a fully green preview earns the ONE live write.
 *
 * GUARDRAILS:
 *  - DELETES are triple-gated (planNotAllowedDeletes): the disallowed attribute must EXIST on the
 *    parent's LIVE attributes map (fetched ONCE here via the single-GET pattern), must NOT be
 *    protected (item_name/brand/bullet_point/product_description/generic_keyword/identifiers/
 *    variation_theme + anything with a child_ or parent prefix — the variation-family plumbing),
 *    and must NOT be
 *    the container being written. An iteration that adds NO new op (unrecognized/protected/absent
 *    issues) ABORTS to the failed bucket with ALL issue texts recorded + flagParentAttrsNeedAttention.
 *  - EXTRA REPLACES are limited to OTHER registered COMPOSITE_HEAL_SPECS containers whose
 *    conditional-requirement signature names them (complete-donor item, same selection as strategy 3).
 *  - INTENT-LOGGED: ONE keyword_push_log row (field 'heal:negotiate:<container>', new_value = the
 *    FULL final ops list as JSON, status 'attempted') BEFORE the LIVE write; flipped to 'accepted'
 *    only after the read-back confirms.
 *  - READ-BACK-VERIFIED (verifyNegotiationReadBack): the container's written sub-keys persisted
 *    (tolerant subsetDeepEqual) AND every deleted attribute is ABSENT. Any miss -> failed + errors +
 *    flag; no rule learning.
 *  - NO RULE LEARNING (same as strategy 3): a one-time fix for THIS hub. On confirmed success the
 *    shared strategy-3 side-effects run (stale inherit-rule unlearn + delayed family-integrity check).
 * NON-THROWING; every failure records errors[containerKey] with stage prefixes
 * 'negotiation iter N: ...' inside the 'complete-write fallback ->' wrapper, so the cron's terminal
 * copy can tell that BOTH the complete write AND the negotiation ran.
 */
async function negotiateParentRecordFix(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  args: {
    parent_asin: string; parentSku: string; productType: string; spec: CompositeHealSpec
    sellerId: string; token: string
    childAttrs: Map<string, Record<string, unknown> | null>
    /** The complete donor item strategy 3 is writing (initialOps' replace value) — the read-back
     *  re-verifies its sub-keys persisted. */
    donorItem: CompositeItem
    /** Strategy 3's op set (replace containerKey with the donor's complete item) — the loop's start. */
    initialOps: NegotiationOp[]
    /** Strategy 3's ALREADY-FAILED structured preview — iteration 1's verdict (no duplicate call). */
    initialPreview: PatchResult
    liveChildCount: number
  },
): Promise<HealResult> {
  const { parent_asin, parentSku, productType, spec, sellerId, token, childAttrs, donorItem, initialOps, initialPreview, liveChildCount } = args
  const containerKey = spec.containerKey
  const out: HealResult = { healed: [], abstained: [], failed: [] }
  const fail = (detail: string) => {
    out.failed.push(containerKey)
    ;(out.errors ??= {})[containerKey] = `complete-write fallback -> ${detail}`
  }
  const flagAttention = async () => {
    try {
      const { flagParentAttrsNeedAttention } = await import('@/lib/fba/verificationQueue')
      await flagParentAttrsNeedAttention(parent_asin, [containerKey])
    } catch (e) { console.warn('[push-heal] negotiation flag-attention failed (non-fatal):', e instanceof Error ? e.message : e) }
  }
  let stageIter = 1   // last known preview iteration, for stage-prefixing failures outside the loop
  try {
    // The parent's LIVE attributes map, fetched ONCE (the existing single-GET pattern): the delete
    // planner's existence gate. A dead GET must never look like "safe to plan deletes" — failed
    // bucket (transient; the queue's backoff retries), never a guessed delete.
    const liveRead = await fetchChildAttributesMap(sellerId, token, [parentSku])
    const liveParentAttrs = liveRead.get(parentSku) ?? null
    if (!liveParentAttrs) {
      fail('negotiation iter 1: live parent attributes fetch failed - cannot verify delete safety; aborting negotiation')
      return out
    }

    const loop = await runNegotiationLoop({
      initialOps,
      initialPreview,
      containerKey,
      marketplaceId: MARKETPLACE_ID,
      liveParentAttrs,
      preview: async (ops) => {
        await sleep(PATCH_DELAY_MS)   // ~200ms between previews (Amazon patchListingsItem 5 rps)
        return await patchSkuMulti(sellerId, token, productType, parentSku, ops, 'VALIDATION_PREVIEW')
      },
      // TIGHT-SCOPE extension: an issue the delete planner skipped may be ANOTHER registered
      // composite's conditional-requirement ("the field '<perVariantField>' ... does not have enough
      // values" naming that container) — add ITS complete-donor replace, exactly strategy 3's own op
      // shape. ONLY COMPOSITE_HEAL_SPECS containers; anything else contributes no op (and an
      // op-less iteration trips the abort above).
      extraOpsForSkippedIssue: (message) => {
        for (const other of COMPOSITE_HEAL_SPECS) {
          if (other.containerKey === containerKey) continue
          if (!conditionalRequirementRegex(other.perVariantField).test(message)) continue
          if (!containerNameRegex(other.containerKey).test(message)) continue
          const sel = selectCompleteDonorItem(childAttrs, other)
          if (!sel) return null
          return [{ op: 'replace' as const, path: `/attributes/${other.containerKey}`, value: [{ ...sel.donor, marketplace_id: MARKETPLACE_ID }] }]
        }
        return null
      },
    })
    stageIter = loop.iterations

    if (loop.kind !== 'converged') {
      // STRATEGY 5 (Path Z, 2026-07-20, feature-flagged): before the final flag_attention, try a
      // JSON_LISTINGS_FEED PARTIAL_UPDATE submission. The Feeds path returns machine-readable
      // snake_case attribute names in its async business-validation issues report — the exact class
      // patchListingsItem swallows (spec §submission_flow, developer-docs.amazon.com update-
      // json_listings_feed…). If Feeds accepts + read-back confirms the composite persisted, we've
      // cured a case Strategies 1-4 could not. If Feeds surfaces errors, we get real snake_case for
      // a more actionable flag_attention message. Feature flag off = ZERO behavior change — the whole
      // block below is skipped and the pre-fix behavior runs identically. Runtime env read (like
      // PUSH_QUEUE_ALL) so it can be flipped in Coolify without a rebuild.
      let extraDetail = ''
      if (process.env.PUSH_HEAL_FEEDS_FALLBACK === 'on' && (loop.kind === 'no-progress' || loop.kind === 'exhausted')) {
        try {
          const { submitJsonListingsFeed, mapFeedIssuesToRejectedKeys } = await import('@/lib/fba/feedsSubmit')
          // ENHANCED (2026-07-20 workflow #wi9onywfg): also bundle the parent's recommended item_name
          // in the SAME PARTIAL_UPDATE so a successful heal LANDS THE TITLE too — otherwise the
          // composite gets healed but the seller still needs a second push to ship the title, and
          // Strategies 1-4 already-run means that second push would face the same PATCH silent-drop
          // wall. Read recommended_title with loadDiff's same parent-title rule (:592-597): apply
          // stripCapacity for multi-child-title families to keep the parent hub capacity-agnostic;
          // cap 200 chars. Uses buildPatchValue for the exact same shape every PATCH write uses.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          let parentTitleForFeed = ''
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const { data: recRow } = await (db as any).from('listing_seo_recommendations')
              .select('recommended_title, per_child_titles')
              .eq('parent_asin', parent_asin).maybeSingle()
            const rec = recRow as { recommended_title?: string; per_child_titles?: unknown } | null
            const rawTitle = (rec?.recommended_title ?? '').trim()
            const multiChildTitles = Array.isArray(rec?.per_child_titles) && (rec!.per_child_titles as unknown[]).length > 1
            parentTitleForFeed = (multiChildTitles ? stripCapacity(rawTitle) : rawTitle).slice(0, 200)
          } catch (e) { console.warn('[push-heal] Strategy 5 recommended_title lookup failed (non-fatal, will ship composite only):', e instanceof Error ? e.message : e) }
          const feedAttributes: Record<string, unknown> = {
            [containerKey]: [{ ...donorItem, marketplace_id: MARKETPLACE_ID }],
          }
          if (parentTitleForFeed.length > 0) {
            feedAttributes.item_name = buildPatchValue(parentTitleForFeed, MARKETPLACE_ID)
          }
          const feedResult = await submitJsonListingsFeed({
            sku: parentSku,
            productType,
            attributes: feedAttributes,
          })
          console.warn(`[push-heal] Strategy 5 (Feeds) for ${containerKey}${parentTitleForFeed ? '+item_name' : ''} on ${parentSku}: ${feedResult.processingStatus}, feedId=${feedResult.feedId}, errors=${feedResult.errorIssues.length}, accepted=${feedResult.messagesAccepted}/${feedResult.messagesProcessed}`)
          if (feedResult.processingStatus === 'DONE' && feedResult.messagesAccepted === 1 && feedResult.errorIssues.length === 0) {
            // Feeds ACCEPTED — read back to confirm BOTH composite AND item_name actually persisted
            // (Feeds can silent-drop too — spec §error_handling SILENT NO-OP class). Composite silent-
            // drop → SP-API cannot cure this parent. Title silent-drop with composite persisted → a
            // NEW failure mode this enhancement newly exposes (was invisible on composite-only probe).
            await sleep(PATCH_DELAY_MS)
            const postRead = await fetchChildAttributesMap(sellerId, token, [parentSku])
            const postAttrs = postRead.get(parentSku)
            const persistedArr = postAttrs?.[containerKey]
            const compositePersisted = Array.isArray(persistedArr) && persistedArr.length > 0
            let titlePersisted = true
            let liveTitle = ''
            if (parentTitleForFeed.length > 0) {
              liveTitle = await readbackItemName(sellerId, token, parentSku)
              titlePersisted = liveTitle === parentTitleForFeed
            }
            if (compositePersisted && titlePersisted) {
              console.warn(`[push-heal] Strategy 5 (Feeds) HEALED ${containerKey}${parentTitleForFeed ? ' + item_name' : ''} on ${parentSku} — feedId=${feedResult.feedId}`)
              out.healed.push(containerKey)
              // Belt-and-suspenders audit trail: a SECOND keyword_push_log row for the title write
              // (the existing intent-audit row at :2547 records composite finalOps only). Best-effort;
              // never blocks the healed return.
              if (parentTitleForFeed.length > 0) {
                try {
                  await db.from('keyword_push_log').insert({
                    parent_asin, sku: parentSku, field: 'title',
                    previous_value: null, new_value: parentTitleForFeed,
                    submission_id: feedResult.feedId, status: 'accepted', error_message: null,
                    pushed_by: SYSTEM_ACTOR.id,
                  })
                } catch (e) { console.warn('[push-heal] Strategy 5 title keyword_push_log insert failed (non-fatal):', e instanceof Error ? e.message : e) }
              }
              try { await completeWriteSuccessSideEffects(db, { parent_asin, parentSku, productType, containerKey, liveChildCount, sampledChildCount: childAttrs.size }) } catch { /* best-effort */ }
              return out
            }
            if (!compositePersisted) {
              extraDetail = ` | Strategy 5 (Feeds) accepted-no-op on composite: feedId=${feedResult.feedId} DONE with 0 errors but ${containerKey} still absent on read-back → SP-API cannot cure this parent hub. Seller Central Variations form (5 fields) required.`
            } else {
              extraDetail = ` | Strategy 5 (Feeds) SILENT-DROP item_name: feedId=${feedResult.feedId} accepted the write but live title still reads "${liveTitle.slice(0, 80)}" (sent "${parentTitleForFeed.slice(0, 80)}"). Composite healed but title did not persist — parent hub structurally rejects item_name via Feeds too.`
            }
          } else if (feedResult.errorIssues.length > 0) {
            const rejectedKeys = mapFeedIssuesToRejectedKeys(feedResult.errorIssues)
            const detail = feedResult.errorIssues.slice(0, 2).map((i) => i.message ?? '').join(' | ').slice(0, 280)
            extraDetail = ` | Strategy 5 (Feeds) surfaced ERRORS: attributeNames=[${rejectedKeys.join(', ')}]; ${detail}`
          } else {
            extraDetail = ` | Strategy 5 (Feeds) ${feedResult.processingStatus}: ${feedResult.errorMessage ?? '(no detail)'}`
          }
        } catch (e) {
          console.warn('[push-heal] Strategy 5 (Feeds) threw (non-fatal, falling through to flagAttention):', e instanceof Error ? e.message : e)
          extraDetail = ` | Strategy 5 (Feeds) threw: ${e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200)}`
        }
      }
      fail((loop.failureDetail ?? `negotiation iter ${loop.iterations}: preview did not converge`) + extraDetail)
      // 'no-progress' / 'exhausted' are durable dead-ends a human must see (observability: the
      // failureDetail above carries every blocking issue text). 'transport' is a transient preview
      // failure — the queue's backoff retries it; no false-alarm flag.
      if (loop.kind === 'no-progress' || loop.kind === 'exhausted') await flagAttention()
      return out
    }
    console.warn(`[push-heal] negotiation for ${containerKey} on ${parentSku} converged in ${loop.iterations} preview iteration(s): ${loop.finalOps.length} op(s), deleting [${loop.deletedKeys.join(', ') || 'none'}]`)

    // INTENT AUDIT ROW — same pattern as strategies 2/3: durable evidence of EVERY op BEFORE the
    // LIVE write (a crash between the PATCH and the read-back must still be visible). new_value
    // carries the FULL final ops list as JSON. previous_value snapshots the DELETED attributes'
    // prior live values (delete-safety review 2026-07-02: a converged delete must have a restore
    // path — liveParentAttrs holds the values in memory right now, so record them durably).
    // Best-effort: a failed insert proceeds but warns.
    const deletedPrior: Record<string, unknown> = {}
    for (const k of loop.deletedKeys) deletedPrior[k] = liveParentAttrs[k] ?? null
    const deletedPriorJson = loop.deletedKeys.length ? JSON.stringify(deletedPrior).slice(0, 4000) : null
    let intentRowId: string | null = null
    try {
      const { data: intentData, error: intentErr } = await db.from('keyword_push_log').insert({
        parent_asin, sku: parentSku, field: `heal:negotiate:${containerKey}`,
        previous_value: deletedPriorJson, new_value: JSON.stringify(loop.finalOps),
        submission_id: null, status: 'attempted', error_message: null,
        pushed_by: SYSTEM_ACTOR.id,
      }).select('id')
      if (intentErr) console.warn('[push-heal] negotiation INTENT log insert failed (best-effort, proceeding):', intentErr?.message ?? intentErr)
      else intentRowId = (intentData as { id?: string }[] | null)?.[0]?.id ?? null
    } catch (e) { console.warn('[push-heal] negotiation INTENT log insert threw (best-effort, proceeding):', e instanceof Error ? e.message : e) }

    const live = await patchSkuMulti(sellerId, token, productType, parentSku, loop.finalOps, 'LIVE')
    if (!live.ok) { fail(`negotiation iter ${loop.iterations}: live: ${live.error ?? 'rejected'}`); return out }

    // READ-BACK: (i) the container's written sub-keys persisted (tolerant subsetDeepEqual) AND
    // (ii) every deleted attribute is ABSENT. A failed re-read is a FAILURE (queue retries), never
    // assumed success; a mismatch fails + flags (no rule learning) — Amazon accepted then diverged.
    await sleep(PATCH_DELAY_MS)
    const postRead = await fetchChildAttributesMap(sellerId, token, [parentSku])
    const postAttrs = postRead.get(parentSku)
    if (!postAttrs) {
      fail(`negotiation iter ${loop.iterations}: read-back: fetch failed - cannot confirm the negotiated ops persisted`)
      return out
    }
    const verdict = verifyNegotiationReadBack(postAttrs, containerKey, donorItem, loop.deletedKeys)
    if (!verdict.ok) {
      console.warn(`[push-heal] negotiation read-back MISMATCH for ${containerKey} on ${parentSku}: ${verdict.detail}; marking failed + flagging for attention.`)
      fail(`negotiation iter ${loop.iterations}: read-back mismatch: ${verdict.detail}`)
      await flagAttention()
      return out
    }

    // Confirmed -> healed. Flip the INTENT row to 'accepted' (or insert the accepted row directly if
    // the intent write failed), then the SHARED strategy-3 success side-effects (stale inherit-rule
    // unlearn + delayed family-integrity check). Deliberately NO push_heal_rules learning — the
    // negotiated ops are a one-time fix for THIS hub's conditional web.
    out.healed.push(containerKey)
    try {
      if (intentRowId) {
        await db.from('keyword_push_log').update({
          submission_id: live.submissionId, status: 'accepted',
          pushed_at: new Date().toISOString(),
        }).eq('id', intentRowId)
      } else {
        await db.from('keyword_push_log').insert({
          parent_asin, sku: parentSku, field: `heal:negotiate:${containerKey}`,
          previous_value: deletedPriorJson, new_value: JSON.stringify(loop.finalOps),
          submission_id: live.submissionId, status: 'accepted', error_message: null,
          pushed_by: SYSTEM_ACTOR.id,
        })
      }
    } catch (e) { console.warn('[push-heal] negotiation keyword_push_log accept-log failed (non-fatal):', e instanceof Error ? e.message : e) }

    await completeWriteSuccessSideEffects(db, { parent_asin, parentSku, productType, containerKey, liveChildCount, sampledChildCount: childAttrs.size })
  } catch (e) {
    // A throw mid-negotiation is NOT a safe abstain (the parent is known-broken and this is its last
    // automated fix) — ride the failed bucket so the queue's attempts/backoff retry it.
    console.warn('[push-heal] negotiateParentRecordFix threw (non-fatal):', e instanceof Error ? e.message : e)
    if (!out.healed.includes(containerKey) && !out.failed.includes(containerKey)) {
      fail(`negotiation iter ${stageIter}: threw: ${e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200)}`)
    }
  }
  return out
}

/** PATCH MULTIPLE attributes on one SKU in a SINGLE submission (the bulk Auto Push efficiency
 *  core — Amazon's patchListingsItem accepts many ops per call). Each op is a fully-built
 *  {op,path,value} — or a value-less {op:'delete',path} that removes the whole attribute (heal v2
 *  delete-partial-container; the ONLY delete caller is the guardrailed healParentComposite strategy 2).
 *  Amazon validates the submission ATOMICALLY: any ERROR-severity issue →
 *  status INVALID and NOTHING applies — so the caller previews first and falls back to
 *  per-attribute pushes when a batch preview fails, preserving failure isolation. */
async function patchSkuMulti(
  sellerId: string, token: string, productType: string, sku: string,
  ops: ({ op: 'replace'; path: string; value: unknown } | { op: 'delete'; path: string; value?: unknown })[],
  mode: 'VALIDATION_PREVIEW' | 'LIVE',
): Promise<PatchResult> {
  if (ops.length === 0) return { ok: true, submissionId: null }
  await spApiWriteBucket.acquire()   // global 5-rps ceiling (task #23) — after the no-op guard
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
    await spApiReadBucket.acquire()   // global 5-rps ceiling for getListingsItem reads (task #23) — 1 token per GET
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
  /** Bulk "Ship all core" (field==='core_bulk'): the subset of the four core content fields to ship
   *  together in ONE PATCH per SKU. Absent/empty → every core field that currently has a diff. */
  core_fields?: PushField[]
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
      : parent?.status === 'skipped_manual_parent'
        ? ' (Parent hub skipped — manual completion required in Seller Central; a popup is showing you the exact fields. Children still shipped.)'
        : parent?.status === 'failed'
        ? ' (The variation parent hub was rejected — usually an incomplete required attribute like its Shirt Size System/Class; complete it in Seller Central. The buyable variants shoppers see were updated.)'
        : ''
  return { accepted, failed, childTotal: children.length, parentNote }
}

/** If the variation PARENT row FAILED with a rejection naming a BROADCAST-healable attribute, enqueue
 *  a self-heal task (migration 042 kind='heal'). Non-blocking and best-effort — it NEVER flips the
 *  push outcome (the parentNote stays the seller-facing signal); it just schedules the cron to inherit
 *  the missing attribute from a live child.
 *
 *  NON-ELIGIBLE ATTRS SURFACE, they do NOT silently vanish (adversarial review 2026-06-28): when the
 *  rejection names attributes that are NOT auto-healable (e.g. shirt_size — a composite/per-variant axis
 *  the auto-heal deliberately excludes), we write a DURABLE, VISIBLE needs_attention row via
 *  flagParentAttrsNeedAttention instead of the previous invisible silent abstain. */
/** Derive the rejected attribute keys from a failed parent row. Amazon FREQUENTLY omits the structured
 *  issues[].attributeNames array and names the attribute ONLY in the message text — e.g. "Based on the
 *  data from '[shirt_size#?.size_system, shirt_size#?.size_class]' ... the attribute 'Shirt Size' does
 *  not have enough values." Keying the heal solely off attributeNames therefore made the trigger a silent
 *  NO-OP on exactly the Custom-apparel shirt_size case (verified live 2026-07-01: the verification queue
 *  stayed empty right after a rejecting push). So combine BOTH sources: the structured attributeNames AND
 *  a parse of the error + issue-message text (known healable keys that appear verbatim, plus any snake_case
 *  base/leaf token inside a bracketed data-path so new attributes are picked up without a code change). */
function rejectedAttrKeysFrom(parent: PushResultRow): string[] {
  const structured = (parent.issues ?? []).flatMap((i) => i.attributeNames ?? [])
  const text = `${parent.error ?? ''} ${(parent.issues ?? []).map((i) => i.message ?? '').join(' ')}`.toLowerCase()
  const fromText = new Set<string>()
  for (const key of [...BROADCAST_HEALABLE, ...COMPOSITE_HEAL_SPECS.flatMap((s) => [s.containerKey, ...s.subKeys])]) {
    if (text.includes(key)) fromText.add(key)
  }
  const bracket = text.match(/\[([a-z0-9_#?.,\s]+)\]/)
  if (bracket) {
    for (const tok of bracket[1].split(/[,\s]+/).filter(Boolean)) {
      const base = tok.split(/[#.]/)[0].trim()
      const leaf = tok.includes('.') ? (tok.split('.').pop() ?? '').replace(/[#?]/g, '').trim() : ''
      for (const t of [base, leaf]) if (/^[a-z][a-z0-9_]{2,}$/.test(t)) fromText.add(t)
    }
  }
  return [...new Set([...structured, ...fromText])]
}

/** Parent-rejected note used INSTEAD of the "complete it in Seller Central" wording when a self-heal
 *  was actually scheduled (live-notice): the system fixes this one itself, and a re-push would only
 *  reset the in-flight heal. The Seller-Central wording stays ONLY for the no-heal case (non-healable
 *  attrs / enqueue failed) — summarizePush still produces it as the default. */
const HEAL_SCHEDULED_PARENT_NOTE =
  ' The variation parent hub was rejected (missing SHIRT SIZE data) - a SELF-HEAL is scheduled: the system will inherit the missing values from a live child automatically within ~5 minutes. No action needed - do not re-push.'

/** What maybeEnqueueParentHeal reports back to the push's FINAL result emit (live-notice):
 *  healScheduled = a flat or composite heal task is genuinely in flight for this parent (freshly
 *  inserted OR already active from a prior push — either way the seller must NOT re-push);
 *  healAttrs = the attribute/container names the heal will inherit. */
interface ParentHealOutcome { healScheduled: boolean; healAttrs: string[] }

async function maybeEnqueueParentHeal(
  parent_asin: string, productType: string | null, results: PushResultRow[],
): Promise<ParentHealOutcome> {
  const none: ParentHealOutcome = { healScheduled: false, healAttrs: [] }
  try {
    const parent = results.find((r) => r.isParent && r.status === 'failed')
    if (!parent?.sku || (!parent.issues?.length && !parent.error)) return none
    const rejectedAttrs = rejectedAttrKeysFrom(parent)
    /* POPUP REGRESSION FIX (PO 2026-08-04: "the Update Parent Manually popup is not showing
     * anymore" + "ALL parents failing, ~50 heal attempts"). An UNPARSEABLE parent rejection — no
     * structured attributeNames and no known key in the message text — used to produce ZERO
     * signal here: no heal, no flag, no popup. The parent just failed as an anonymous red row on
     * every push while the verify cron re-pushed it forever. A structurally-failed parent must
     * ALWAYS leave a durable seller-visible signal: flag the 'parent_update' sentinel so the
     * standing heal:manual row exists and the popup fires with the generic Seller-Central
     * instructions. Transport-class blips (throttle/5xx/timeout) are excluded — those genuinely
     * deserve a silent retry, not a manual-action alert. */
    if (rejectedAttrs.length === 0) {
      const text = `${parent.error ?? ''} ${(parent.issues ?? []).map((i) => i.message ?? '').join(' ')}`
      const transient = /HTTP (429|5\d\d)|timed? ?out|ETIMEDOUT|ECONN|throttl/i.test(text)
      if (!transient) {
        const { flagParentAttrsNeedAttention } = await import('@/lib/fba/verificationQueue')
        await flagParentAttrsNeedAttention(parent_asin, ['parent_update'])
        console.log(JSON.stringify({ tag: 'PARENT_MANUAL_FLAG', parent_asin, sku: parent.sku, reason: 'unparseable-structural-rejection', error: text.slice(0, 200) }))
      }
      return none
    }
    // Classify each rejected attr: flat-healable (department/age_range) vs composite-healable (shirt_size
    // container OR its size_system/size_class sub-fields → healParentComposite) vs genuinely not healable.
    const healable = rejectedAttrs.filter((k) => BROADCAST_HEALABLE.has(k))
    // De-dupe composite hits to ONE spec per container (a rejection can name the container AND its subKeys).
    const compositeContainers = new Map<string, { containerKey: string; subKeys: string[] }>()
    for (const k of rejectedAttrs) {
      const spec = compositeSpecForRejectedAttr(k)
      if (spec) compositeContainers.set(spec.containerKey, spec)
    }
    const nonHealable = rejectedAttrs.filter(
      (k) => !BROADCAST_HEALABLE.has(k) && !compositeSpecForRejectedAttr(k),
    )
    const { enqueueHeal, flagParentAttrsNeedAttention, hasActiveManualHealFlag, hasActiveHealTask, clearManualHealFlagIfStale } = await import('@/lib/fba/verificationQueue')
    let healScheduled = false
    const healAttrs: string[] = []
    // Auto-heal the flat-scalar broadcast attrs (needs a resolved productType to schedule the heal).
    if (productType && healable.length > 0) {
      // RE-PUSH GUARD (live-notice): an ACTIVE flat heal is already in flight — re-enqueuing would
      // abandon-and-reinsert it, resetting its attempt budget on every user re-push. Skip the enqueue
      // but STILL report it (the heal IS scheduled — that is exactly what the seller must hear).
      let scheduled = await hasActiveHealTask(parent_asin, 'heal')
      if (!scheduled) {
        scheduled = await enqueueHeal(parent_asin, { parentSku: parent.sku, productType, missingAttrKeys: healable })
      }
      if (scheduled) { healScheduled = true; healAttrs.push(...healable) }
    }
    // COMPOSITE heal (self-healing composite): enqueue a purpose-built composite task per container. Needs
    // a resolved productType; missingAttrKeys carries the container name so enqueueHeal's guard passes and
    // the cron dispatches to healParentComposite via the `composite` discriminator.
    if (productType) {
      for (const spec of compositeContainers.values()) {
        // FIX 3: a prior read-back may have already GIVEN UP on this container (durable heal:manual
        // needs_attention row). Re-enqueuing would reset the 3-attempt budget every push instead of
        // letting the standing alert stand — SKIP if that durable signal already exists for this
        // parent+container. Best-effort (a failed check falls through to enqueue — safe default).
        //
        // STALE-FLAG RETRY (2026-07-20, Path X): the parent-baseline PATCH now surfaces the REAL
        // Amazon rejection (composite subKeys) instead of silent-dropping — genuinely fresh evidence
        // the composite heal deserves another attempt on. If the flag is >=1 hour old, CLEAR it and
        // let the enqueue proceed. Bounded by the composite heal's own 3-attempt budget per task; a
        // rapid-fire re-push within the hour still respects the standing flag (no attempt-reset loop).
        try {
          if (await hasActiveManualHealFlag(parent_asin, spec.containerKey)) {
            const cleared = await clearManualHealFlagIfStale(parent_asin, spec.containerKey, 60 * 60 * 1000)
            if (!cleared) continue   // flag is fresh — respect the guard
          }
        } catch { /* non-fatal — fall through to enqueue */ }
        // RE-PUSH GUARD (live-notice): same as the flat path — protect an in-flight composite heal's
        // attempts/next_check_at from being reset by a user re-push, but still count it as scheduled.
        let scheduled = await hasActiveHealTask(parent_asin, 'heal:composite')
        if (!scheduled) {
          // FIX 4: composite heals use a DISTINCT field ('heal:composite') so a flat heal ('heal')
          // enqueued in the SAME push is not silently abandoned on the shared (parent, field) queue slot.
          scheduled = await enqueueHeal(parent_asin, {
            parentSku: parent.sku, productType, missingAttrKeys: [spec.containerKey],
            composite: { containerKey: spec.containerKey, subKeys: spec.subKeys },
          }, 3, 'heal:composite')
        }
        if (scheduled) { healScheduled = true; healAttrs.push(spec.containerKey) }
      }
    }
    // Surface the rest as a standing, seller-visible "not auto-healable" signal (durable, non-blocking).
    if (nonHealable.length > 0) {
      await flagParentAttrsNeedAttention(parent_asin, nonHealable)
    }
    return { healScheduled, healAttrs: [...new Set(healAttrs)] }
  } catch (e) {
    console.warn('[push-heal] enqueue trigger failed (non-fatal):', e instanceof Error ? e.message : e)
    return none
  }
}

/** TWIN-HEAL TRIGGER (2026-08-05, the Later-Gator incident). Scans FAILED CHILD rows for the
 *  incomplete-composite signature — Amazon rejecting a content write because the SKU's OWN
 *  composite container lacks its sub-fields ("The field 'size_class' for the attribute 'Shirt
 *  Size' does not have enough values"). NOTE the child errors name the SUBKEYS, not the
 *  per-variant field the parent-hub signature uses — conditionalRequirementRegex is built per
 *  subKey here. Matching SKUs get ONE batched heal:twin task (verbatim mirror from the same-ASIN
 *  twin, healChildTwinComposite). Never throws; an in-flight task is never reset (re-enqueue
 *  would zero its attempt budget on every user re-push — the same guard the parent heals use). */
async function maybeEnqueueChildTwinHeal(
  parent_asin: string, productType: string | null, results: PushResultRow[],
): Promise<{ scheduled: boolean; containerKey?: string; count: number }> {
  try {
    if (!productType) return { scheduled: false, count: 0 }
    for (const spec of COMPOSITE_HEAL_SPECS) {
      const nameRe = containerNameRegex(spec.containerKey)
      const subRes = spec.subKeys.map((k) => conditionalRequirementRegex(k))
      const skus = results
        .filter((r) => !r.isParent && r.status === 'failed' && r.sku)
        .filter((r) => {
          const text = `${r.error ?? ''} ${(r.issues ?? []).map((i) => i.message ?? '').join(' ')}`
          return nameRe.test(text) && subRes.some((re) => re.test(text))
        })
        .map((r) => r.sku)
      if (skus.length === 0) continue
      const { enqueueHeal, hasActiveHealTask } = await import('@/lib/fba/verificationQueue')
      if (await hasActiveHealTask(parent_asin, 'heal:twin')) {
        // Already in flight — report it as scheduled (that IS what the seller must hear) without
        // resetting the running task's budget.
        return { scheduled: true, containerKey: spec.containerKey, count: skus.length }
      }
      const parentSku = results.find((r) => r.isParent)?.sku ?? parent_asin
      // maxAttempts 6: TWIN_HEAL_BATCH=25 SKUs per run → 3 productive runs for a 70-SKU family,
      // doubled for transient headroom. Idempotent re-runs skip already-complete SKUs.
      const scheduled = await enqueueHeal(parent_asin, {
        parentSku, productType, missingAttrKeys: [spec.containerKey],
        composite: { containerKey: spec.containerKey, subKeys: spec.subKeys },
        twin: { skus },
      }, 6, 'heal:twin')
      if (scheduled) {
        console.log(JSON.stringify({ tag: 'TWIN_HEAL_ENQUEUED', parent_asin, containerKey: spec.containerKey, blocked: skus.length }))
        return { scheduled: true, containerKey: spec.containerKey, count: skus.length }
      }
    }
    return { scheduled: false, count: 0 }
  } catch (e) {
    console.warn('[twin-heal] enqueue trigger failed (non-fatal):', e instanceof Error ? e.message : e)
    return { scheduled: false, count: 0 }
  }
}

/**
 * Re-score a parent purely from the (now-current) `listing_content` cache and persist the fresh scores +
 * display title onto `listing_seo_scores`. Single implementation of the re-score, routed through
 * `pickRescoreRepresentative` (standing rule) — called by (a) push success and (b) heal-on-verify.
 * Returns the score + the rows so the push path can fingerprint + append score-history. Best-effort caller.
 */
export async function rescoreParentFromCache(
  db: any,   // eslint-disable-line @typescript-eslint/no-explicit-any
  parent_asin: string,
): Promise<{ score: any; topChildRow: Record<string, unknown> | undefined; representative: unknown; rows: Record<string, unknown>[] } | null> {  // eslint-disable-line @typescript-eslint/no-explicit-any
  const { scoreListingContent, fetchScoringContext } = await import('@/lib/sync/syncListingContent')
  const { data: kids } = await db.from('listing_content')
    .select('sku, asin, title, bullet_1, bullet_2, bullet_3, bullet_4, bullet_5, description, backend_keywords, image_count, has_aplus, aplus_module_count, aplus_has_brand_story, aplus_has_headline, aplus_images_missing_alt')
    .eq('parent_asin', parent_asin)
  const rows = (kids ?? []) as Record<string, unknown>[]
  if (rows.length === 0) return null
  const { data: sc } = await db.from('listing_seo_scores').select('top_child_asin').eq('parent_asin', parent_asin).single()
  const ctx = await fetchScoringContext(db, parent_asin, (sc?.top_child_asin as string) || (rows[0]?.asin as string) || null)
  const { representative, scoredRows } = pickRescoreRepresentative(rows as never[], parent_asin, (sc?.top_child_asin as string) ?? null)
  const score = scoreListingContent(representative as never, scoredRows as never, ctx)
  // Refresh the cached display title alongside the scores (top child, matching syncListingContent).
  const topChildRow = (sc?.top_child_asin ? rows.find((r) => r.asin === sc.top_child_asin) : rows[0]) ?? rows[0]
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
  return { score, topChildRow, representative, rows }
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
          // Variants now span every candidate SUB-FIELD too (SHIRT sleeve: `type` before
          // `length_description`), each carrying its own coerced enum member.
          let calibratedValueFor: ((v: string) => Record<string, unknown>[] | undefined) = () => undefined
          if (ctx.valueShape) {
            let shape = ctx.valueShape
            const formKey = `${productType}|${ctx.attribute.spApiKey}`
            const cachedId = _detailFormCache.get(formKey) ?? null
            // LIVE-SUB-FIELD HINT: when the container has several candidate sub-fields, the one
            // the LIVE listing already populates is the one Amazon demonstrably honors for THIS
            // listing — reorder so its variants are probed first. Best-effort; on any failure
            // the schema order (union-enum sub-fields first) stands. Skipped on a cache hit —
            // no probes happen then, so order doesn't matter.
            // UNION-GATED (adversarial review fix 3): derived fields (length_description) are
            // populated by Amazon's OWN derivation without honoring writes, so a populated
            // NON-union sub-field is NOT write-evidence — applyLiveDetailSubfieldHint only
            // promotes union-enum candidates; otherwise schema/band order stands untouched.
            const candList = shape.candidates ?? []
            if (!cachedId && candList.length > 1) {
              const liveSub = await detectLiveDetailSubfield(sellerId, token, diff[0].sku, ctx.attribute.spApiKey, candList.map((c) => c.path))
              const hinted = applyLiveDetailSubfieldHint(shape, liveSub)
              if (hinted.reordered) {
                shape = hinted.shape
                console.log(`[push-content] live sub-field hint: ${ctx.attribute.spApiKey}.${liveSub} is populated on ${diff[0].sku} — probing it first`)
              } else if (liveSub && candList[0].path[0] !== liveSub) {
                console.log(`[push-content] live sub-field hint ignored: ${ctx.attribute.spApiKey}.${liveSub} is populated on ${diff[0].sku} but is not a union-enum candidate (likely Amazon-derived) — keeping schema band order`)
              }
            }
            // FIX 1 (adversarial review): the calibration loop is now transport-aware
            // (calibrateVariants). A 429/5xx or thrown fetch is retried on the SAME variant
            // (1s/2s backoff); only a parsed VALIDATION rejection advances. Transport-exhausted
            // -> ABORT this attribute's calibration without advancing — variants span DIFFERENT
            // sub-fields, so advancing on transport noise could crown the derived sub-field
            // (accepted-then-dropped) and cache it process-lifetime.
            const calibrate = (probeVariants: { id: string; value: Record<string, unknown>[] }[], errs: string[]) =>
              calibrateVariants(probeVariants,
                (v) => patchSkuDetail(sellerId, token, productType, diff[0].sku, ctx.attribute, ctx.recommendedValue, 'VALIDATION_PREVIEW', shape, v.value),
                {
                  onProbe: () => emit({ type: 'progress', sku: diff[0].sku, status: 'validating', current: diff[0].current, proposed: ctx.recommendedValue }),
                  interProbeDelayMs: PATCH_DELAY_MS,
                }).then((res) => { errs.push(...res.errors); return res })
            let variants = buildShapedDetailValueVariants(shape, ctx.recommendedValue, MARKETPLACE_ID)
            let winId = cachedId && variants.some((v) => v.id === cachedId) ? cachedId : null
            if (!winId) {
              const errs: string[] = []
              const first = await calibrate(variants, errs)
              winId = first.winId
              let transportAbort = first.transportAbort
              if (!winId && !transportAbort) {
                // SELF-HEAL: when EVERY form is rejected, the likeliest systemic cause is a STALE
                // cached schema (Amazon revised the attribute's sub-fields). Bust both cache tiers
                // ONCE, re-derive the shape from the fresh schema, and retry the calibration once.
                // Deliberately NOT run on a transport abort — a 429/5xx burst is not a stale
                // schema, and more probes mid-burst only feed the throttle.
                try {
                  await bustProductTypeSchemaCache(productType, MARKETPLACE_ID)
                  const freshShape = await getDetailValueShape(productType, ctx.attribute.spApiKey, ptOpts)
                  if (freshShape) {
                    shape = freshShape
                    variants = buildShapedDetailValueVariants(shape, ctx.recommendedValue, MARKETPLACE_ID)
                    const retryErrs: string[] = []
                    const retry = await calibrate(variants, retryErrs)
                    winId = retry.winId
                    transportAbort = retry.transportAbort
                    errs.push(...retryErrs.map((e) => `fresh-schema ${e}`))
                  }
                } catch (e) {
                  errs.push(`schema-refresh: ${e instanceof Error ? e.message : String(e)}`)
                }
              }
              if (!winId) {
                // Surface EVERY variant's rejection (capped) — a single lastErr hid which
                // sub-fields/forms were tried and why each failed. A transport abort says so
                // plainly: nothing was proven wrong with the variants; Amazon was unreachable.
                const detail = errs.join(' | ').slice(0, 900)
                emit({ type: 'error', error: transportAbort
                  ? `Amazon throttled/errored while calibrating "${ctx.detailField}" (${ctx.attribute.spApiKey}) — calibration aborted after retries so a transport blip can't pick the wrong sub-field; nothing was pushed to any SKU. Try again in a minute. Probe errors: ${detail || '(none)'}`
                  : `Amazon's validator rejected every known write form for "${ctx.detailField}" (${ctx.attribute.spApiKey}) — nothing was pushed to any SKU. Variant errors: ${detail || '(none)'}` })
                return
              }
              _detailFormCache.set(formKey, winId)
              console.log(`[push-content] calibrated ${formKey} -> write form "${winId}"`)
            }
            const finalShape = shape
            const finalWinId = winId
            calibratedValueFor = (v: string) => buildShapedDetailValueVariants(finalShape, v, MARKETPLACE_ID).find((x) => x.id === finalWinId)?.value
          }

          // PHANTOM GATE (2026-07-20 details-path parity): skip confirmed-offerless rows so a PATCH
          // never materializes a phantom listing (the class of bug that split B0DQ5YZH38 into 39+8
          // variants after repeated details:title_differentiation retries on backfilled duplicates).
          // Parent hub is exempt (a non-buyable hub is normal, not phantom). Mirrors the identical
          // filter in executeBulkDetailsPush and the content-path (~line 3121).
          const skippedNotLive = diff.filter((d) => d.notLive && d.asin !== parent_asin)
          const workingDiff = skippedNotLive.length > 0
            ? diff.filter((d) => !(d.notLive && d.asin !== parent_asin))
            : diff
          if (skippedNotLive.length > 0) {
            emit({ type: 'progress', message: `Skipping ${skippedNotLive.length} SKU(s) with no live Amazon offer (backfilled duplicates) — pushing to them would create phantom listings.` })
          }

          const results: PushResultRow[] = []
          let cancelled = false
          // Item A (2026-07-21): parent-hub bypass symmetry — details branch also PATCHes the parent hub,
          // and hits the same silent-drop wall when its composite is orphaned.
          const parentBypass = await shouldBypassParentPush(parent_asin)
          for (const item of workingDiff) {
            if (pushCancelled(params.cancel_token)) { cancelled = true; break }
            const isParent = item.asin === parent_asin
            if (isParent && parentBypass.bypass) {
              const reason = `Parent-hub write skipped — composite still needs manual completion in Seller Central (${parentBypass.containers.join(', ')}). Children will still push.`
              results.push({ sku: item.sku, status: 'skipped_manual_parent', submissionId: null, error: reason, isParent: true })
              emit({ type: 'progress', sku: item.sku, status: 'skipped_manual_parent', error: reason })
              continue
            }
            const newValueStr = ctx.recommendedValue
            emit({ type: 'progress', sku: item.sku, status: 'validating', current: item.current, proposed: newValueStr })
            let preview = await patchSkuDetail(sellerId, token, productType, item.sku, ctx.attribute, newValueStr, 'VALIDATION_PREVIEW', ctx.valueShape, calibratedValueFor(newValueStr))
            // AUTO-HEAL 100476 (2026-07-20): when the IH preview is rejected because this SKU's LIVE
            // item_name is >75, push the recommended ≤75 title FOR THIS SKU and retry the highlight —
            // no manual "push title then re-push highlight" round-trip for the seller. Scoped to the IH
            // attribute and the exact 100476 error, so it cannot fire elsewhere. Failed heal falls
            // through to the friendlyErr classifier below (with the reason in the message).
            let autoHealNote: string | null = null
            if (!preview.ok
                && isItemHighlightsField(null, ctx.attribute.spApiKey)
                && isItemHighlightTitleTooLongError(preview.error)) {
              const heal = await autoHealIhLongTitle(sellerId, token, productType, item.sku, parent_asin)
              if (heal.healed) {
                autoHealNote = `auto-healed item_name to "${heal.usedTitle}" (${heal.usedTitle!.length} chars) first`
                emit({ type: 'progress', sku: item.sku, status: 'validating', current: item.current, proposed: newValueStr, note: autoHealNote })
                preview = await patchSkuDetail(sellerId, token, productType, item.sku, ctx.attribute, newValueStr, 'VALIDATION_PREVIEW', ctx.valueShape, calibratedValueFor(newValueStr))
              } else {
                autoHealNote = `auto-heal skipped: ${heal.error}`
              }
            }
            if (!preview.ok) {
              // Amazon's pre-launch wall: the attribute is in the schema + Seller Central form, but
              // Listings-API writes stay refused until the July 27, 2026 launch. Say so plainly
              // instead of leaving the seller to decode Amazon's "refer to the tool tip".
              const baseErr = preview.error && /currently unsupported/i.test(preview.error)
                ? `${preview.error} — Amazon hasn't opened API writes for this attribute yet (full launch July 27, 2026). The value is generated and saved; push it again once Amazon enables the field.`
                // Amazon 100476 on Item Highlights = this SKU's LIVE title is >75 chars (per-SKU, not the
                // pre-launch wall). Ground truth from Amazon itself — our cached title length can be stale.
                // Say the real remedy instead of leaking the raw code (which the auto-heal cron then retried
                // every ~25min for 24h+ on B0FKKN8XKV without ever explaining why).
                : isItemHighlightsField(null, ctx.attribute.spApiKey) && isItemHighlightTitleTooLongError(preview.error)
                  ? ITEM_HIGHLIGHT_TITLE_TOO_LONG_MSG
                  : preview.error
              const friendlyErr = autoHealNote ? `${baseErr} (${autoHealNote})` : baseErr
              // Belt-and-suspenders self-heal: a live "currently unsupported" on the Item Highlights
              // field is ground truth → persist blocked. Guarded by isItemHighlightsField so the same
              // generic error on some OTHER attribute never touches the IH flag.
              if (isItemHighlightsField(null, ctx.attribute.spApiKey) &&
                  preview.error && /currently unsupported/i.test(preview.error)) {
                void (async () => { try { await setItemHighlightsApiState(await createAdminClient(), false) } catch { /* best-effort */ } })()
              }
              results.push({ sku: item.sku, status: 'failed', submissionId: null, error: friendlyErr, isParent, issues: preview.issues })
              emit({ type: 'progress', sku: item.sku, status: 'failed', error: friendlyErr })
              await logPush({ parent_asin, sku: item.sku, field: `details:${ctx.attribute.spApiKey}`, previous_value: item.current, new_value: newValueStr, submission_id: null, status: 'failed', error_message: friendlyErr })
              await sleep(PATCH_DELAY_MS)
              continue
            }
            const live = await patchSkuDetail(sellerId, token, productType, item.sku, ctx.attribute, newValueStr, 'LIVE', ctx.valueShape, calibratedValueFor(newValueStr))
            const status = live.ok ? 'accepted' : 'failed'
            // Self-heal → writable: a genuine live ACCEPT of the Item Highlights field proves Amazon
            // opened writes → persist supported (the flag then unblocks the gate with no code change).
            if (live.ok && isItemHighlightsField(null, ctx.attribute.spApiKey)) {
              void (async () => { try { await setItemHighlightsApiState(await createAdminClient(), true) } catch { /* best-effort */ } })()
            }
            results.push({ sku: item.sku, status, submissionId: live.submissionId, error: live.error, isParent, issues: live.issues })
            emit({ type: 'progress', sku: item.sku, status, submissionId: live.submissionId, error: live.error })
            await logPush({ parent_asin, sku: item.sku, field: `details:${ctx.attribute.spApiKey}`, previous_value: item.current, new_value: newValueStr, submission_id: live.submissionId, status, error_message: live.ok ? null : live.error })
            await sleep(PATCH_DELAY_MS)
          }
          // Fold phantom-gated skips into results so the modal shows them per-SKU (parity with
          // content-path 3187/3422 — the seller sees WHICH SKUs were skipped and why).
          for (const s of skippedNotLive) {
            const isParent = s.asin === parent_asin
            results.push({ sku: s.sku, status: 'skipped', submissionId: null, error: 'Not a live Amazon listing yet (Missing offer/incomplete) — skipped so the push cannot create a phantom. Complete its offer in Seller Central, then re-push.', isParent })
            emit({ type: 'progress', sku: s.sku, status: 'skipped', error: 'Not a live Amazon listing yet (Missing offer/incomplete) — skipped.' })
          }

          // Pass/fail over the buyable CHILDREN; the parent hub's outcome is a non-blocking note.
          const { accepted, failed, childTotal, parentNote } = summarizePush(results)

          // SELF-HEAL trigger (self-healing-push): a parent hub rejected on a missing BROADCAST
          // attribute (the shirt_size#?.size_system/size_class case) schedules the cron to inherit it
          // from a live child. Non-blocking. Live-notice: when a heal really is in flight, the
          // parent-rejected note must say SO — not "complete it in Seller Central" (which invites the
          // re-push that would abandon the heal). The Seller-Central wording stays for the no-heal case.
          const heal = await maybeEnqueueParentHeal(parent_asin, productType, results)
          // TWIN HEAL (2026-08-05): CHILD rows blocked by their own incomplete composite get the
          // twin-mirror heal scheduled; surfaced through the same healScheduled/healAttrs UI hints.
          const twin = await maybeEnqueueChildTwinHeal(parent_asin, productType, results)
          if (twin.scheduled) { heal.healScheduled = true; heal.healAttrs = [...heal.healAttrs, `${twin.containerKey} (${twin.count} variant${twin.count === 1 ? '' : 's'})`] }
          const parentNoteFinal = heal.healScheduled ? HEAL_SCHEDULED_PARENT_NOTE : parentNote

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
                const { representative, scoredRows } = pickRescoreRepresentative(rows as never[], parent_asin, (sc?.top_child_asin as string) ?? null)
                const score = scoreListingContent(representative as never, scoredRows as never, ctxS)
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
                const topRow = (sc?.top_child_asin ? rows.find((r) => r.asin === sc.top_child_asin) : rows[0]) ?? representative ?? rows[0]
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

          // ATTRIBUTION (spec §5 Phase B): a push mirrors a product-facing change-log row (action='push',
          // source='push_executor') + a NARROW compliance audit (listing.push as a write-to-Amazon event).
          // Fires on accepted>0 (PARTIAL pushes included, so they still appear in Change History — the
          // B0FRYMM56C fix); counts ride along. Best-effort — never blocks a push that wrote to Amazon.
          // !cancelled: a STOPPED push's counts cover only attempted SKUs, so it'd mislabel as complete.
          if (accepted > 0 && !cancelled) {
            await logPushChange(db, {
              parent_asin, field: `details:${ctx.attribute.spApiKey}`, actor, accepted, failed,
              after_value: ctx.recommendedValue,
              submission_id: results.find((r) => r.status === 'accepted')?.submissionId ?? null,
            })
            await logAudit({
              userId: actor.id, action: 'listing.push', resourceType: 'listing', resourceId: parent_asin,
              details: { field: `details:${ctx.attribute.spApiKey}`, detail_field: ctx.detailField, accepted, failed, by: actor.name },
            })
          }

          // Item A (2026-07-21): details-branch parent-bypass surfacing (mirrors content-branch).
          const parentManualRow = results.find((r) => r.isParent && r.status === 'skipped_manual_parent')
          const parentManualRequired = Boolean(parentManualRow)
          const parentManualContainers = parentBypass.bypass ? parentBypass.containers : undefined
          emit({
            type: 'result',
            parent_asin, field: 'details', detail_field: ctx.detailField, attribute_key: ctx.attribute.spApiKey,
            pushed: accepted, failed, total: childTotal, cancelled: cancelled || undefined,
            healScheduled: heal.healScheduled, healAttrs: heal.healAttrs,
            parentManualRequired: parentManualRequired || undefined,
            parentManualContainers,
            message: cancelled
              ? `Stopped by you — ${accepted}/${childTotal} accepted before the stop stay pushed; ${diff.length - results.length} SKU${diff.length - results.length === 1 ? '' : 's'} untouched.`
              : `Pushed ${ctx.detailField} for ${accepted}/${childTotal} variant${childTotal === 1 ? '' : 's'}${failed ? `, ${failed} failed` : ''}.${parentNoteFinal} Changes typically reflect in 15-30 minutes.`,
            results,
          })
          return
        }

        // ── REGULAR FIELDS branch (title / bullets / description / keywords) ──
        const field: PushField = isPushField(rawField) ? rawField : 'keywords'
        const titleOv = field === 'title' && typeof title_override === 'string' && title_override.trim() ? title_override.trim() : undefined
        // COVERAGE (2026-07-06): before a FULL family push, reconcile the live family so any newly-
        // linked / never-ingested VARIATION children get a listing_content row FIRST. loadDiff reads
        // listing_content, so a child with no row is invisible to the push — the B0GQXSNQ6R 73/133 case
        // where 60 variations were pushed "a few times" but never covered because we'd never ingested
        // their rows. reconcileFamilyChildren is the SAME offer-gated, additive fn the on-open regen
        // uses (#242): it only materializes children that have a LIVE offer, so every backfilled row
        // then passes loadDiff's ground-truth gate and the full push covers it. Skipped for SELECTIVE
        // pushes (explicit skus) — the seller scoped those deliberately. One catalog call when the
        // family is already complete; the up-to-60 listings fetches fire only when there's a real gap.
        if (!Array.isArray(skus)) {
          try {
            const supaRec = await createAdminClient()
            const reconcileRes = await reconcileFamilyChildren(parent_asin, supaRec)
            if (reconcileRes.backfilled > 0 || reconcileRes.reattached > 0) {
              console.log(`[push-content] pre-push reconcile: +${reconcileRes.backfilled} backfilled, ${reconcileRes.reattached} reattached of ${reconcileRes.childAsins} live children`)
            }
          } catch (e) { console.warn('[push-content] pre-push reconcile skipped (non-fatal):', e instanceof Error ? e.message : e) }
        }
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

        // PARENT-HUB BASELINE (2026-07-20 deep-dive): fetched ONCE per push run, reused for every
        // isParent PATCH in this loop. Amazon silently drops parent PATCHes that omit the coherent
        // family attribute set — fetching + re-sending parentage_level + child_parent_sku_relationship
        // + variation_theme in one top-level replace is what makes item_name actually stick. Cached
        // locally to avoid a GET per patch; null on read failure → falls back to plain patchSku (no
        // over-block on a transient flake).
        let parentBaseline: ParentBaselineAttrs | null = null
        const parentSkuInDiff = diff.find((d) => d.asin === parent_asin)?.sku
        if (parentSkuInDiff) {
          parentBaseline = await fetchParentFamilyBaseline(sellerId, token, parentSkuInDiff)
          if (parentBaseline) console.log(`[push-content] parent-hub baseline loaded for ${parentSkuInDiff}: keys=[${Object.keys(parentBaseline).join(',')}]`)
          else console.log(`[push-content] parent-hub baseline UNREADABLE for ${parentSkuInDiff} — parent PATCH falls back to plain patchSku (may silent-drop)`)
        }

        const results: PushResultRow[] = []
        let cancelled = false
        // Item A (2026-07-21): compute the parent-bypass ONCE up-front — the flag doesn't change during a
        // single push. If the parent has an active heal:manual on any composite container, its PATCH is
        // doomed to silent-drop; skip it and surface a "manual required" note instead of a red "failed".
        const parentBypass = await shouldBypassParentPush(parent_asin)
        for (const item of diff) {
          if (pushCancelled(params.cancel_token)) { cancelled = true; break }
          const isParent = item.asin === parent_asin
          // Item A parent-hub bypass — BEFORE the prefill block so we don't waste an SP-API preview call
          // resolving broadcast attrs for a parent we're going to skip anyway.
          if (isParent && parentBypass.bypass) {
            const reason = `Parent-hub write skipped — composite still needs manual completion in Seller Central (${parentBypass.containers.join(', ')}). Children will still push.`
            results.push({ sku: item.sku, status: 'skipped_manual_parent', submissionId: null, error: reason, isParent: true })
            emit({ type: 'progress', sku: item.sku, status: 'skipped_manual_parent', error: reason })
            continue
          }
          // TIER-2 PRE-FILL: complete the parent hub's known-missing broadcast attributes (learned in
          // push_heal_rules) BEFORE the content PATCH, so the hub's re-validation no longer trips the
          // rejection. RESOLUTION IS LAZY HERE (adversarial review 2026-06-28): loadDiff (the GET preview)
          // does ZERO SP-API for this — resolvePrefillAttrs(..., resolve=true) runs only on THIS push path,
          // only for the parent row. Best-effort, VALIDATION_PREVIEW-gated; a failure here never blocks the
          // content push (the heal cron is the backstop).
          if (isParent) {
            try {
              const prefillAttrs = await resolvePrefillAttrs(db, parent_asin, item.sku, sellerId, token, true)
              for (const pf of prefillAttrs) {
                try {
                  if (pf.kind === 'composite') {
                    // COMPOSITE pre-fill (self-healing composite): write the verbatim-mirrored container via
                    // RAW ops (patchSkuMulti) — the SAME payload the heal path builds, so NO shape builder
                    // ever reshapes the child's own sub-objects. Preview-gated; read-back is not required on
                    // pre-fill (the content push's own outcome + the heal cron are the backstop).
                    const ops = [{ op: 'replace' as const, path: `/attributes/${pf.containerKey}`, value: pf.value }]
                    const pv = await patchSkuMulti(sellerId, token, productType, item.sku, ops, 'VALIDATION_PREVIEW')
                    if (pv.ok) { await patchSkuMulti(sellerId, token, productType, item.sku, ops, 'LIVE'); await sleep(PATCH_DELAY_MS) }
                    continue
                  }
                  const attr: DetailAttribute = { spApiKey: pf.spApiKey, scope: 'broadcast' }
                  const ptOpts = { token, sellerId, marketplaceId: MARKETPLACE_ID, endpoint: ENDPOINT }
                  let shape: DetailValueShape | null = null
                  try { shape = await getDetailValueShape(productType, pf.spApiKey, ptOpts) } catch { /* flat */ }
                  const pv = await patchSkuDetail(sellerId, token, productType, item.sku, attr, pf.value, 'VALIDATION_PREVIEW', shape)
                  if (pv.ok) { await patchSkuDetail(sellerId, token, productType, item.sku, attr, pf.value, 'LIVE', shape); await sleep(PATCH_DELAY_MS) }
                } catch (e) { console.warn('[push-heal] prefill patch failed (non-fatal):', e instanceof Error ? e.message : e) }
              }
            } catch (e) { console.warn('[push-heal] prefill resolution failed (non-fatal):', e instanceof Error ? e.message : e) }
          }
          // SCRUB-AT-PUSH backstop (batch 2/6): trademark-scrub the value at the moment of publish,
          // so a MANUALLY-typed mark (the title-override box bypasses the generation-time scrub #240)
          // or any stale stored content can never be WRITTEN to Amazon as a protected term ("World
          // Cup" → "World Soccer Cup"). Idempotent — already-scrubbed generated content is unchanged.
          // Applied to both shapes: title/description/keywords (string) + bullets (string[]).
          const rawValue = item.raw as string | string[]
          // Celebrity/proper-noun scrub (2026-07-21, B0H9VDCBZJ lamine-in-backend incident): a living
          // person's name in a published apparel field is a personality-rights strike and Amazon takedown
          // vector. Applied after scrubTrademarks in the same terminal-net position — idempotent, logs
          // every strip. Seed list in celebrityGuard.ts; task #104 to grow from PO-flagged drops.
          const scrubOne = (s: string) => scrubCelebrityNames(scrubTrademarks(s), `push:${field}:${item.sku}`)
          const value = Array.isArray(rawValue) ? rawValue.map(scrubOne) : scrubOne(rawValue)
          const newValueStr = asCompare(value)
          emit({ type: 'progress', sku: item.sku, status: 'validating', current: item.current, proposed: newValueStr })
          // PARENT-HUB path: augment the PATCH with the family baseline (parentage_level,
          // child_parent_sku_relationship, variation_theme) so Amazon has the coherent set inside one
          // patch. Non-parent rows keep going through plain patchSku (byte-identical to pre-fix).
          const usePartnerBaseline = isParent && parentBaseline !== null
          const preview = usePartnerBaseline
            ? await patchParentSkuWithBaseline(sellerId, token, productType, item.sku, attribute, value, 'VALIDATION_PREVIEW', parentBaseline as ParentBaselineAttrs)
            : await patchSku(sellerId, token, productType, item.sku, attribute, value, 'VALIDATION_PREVIEW')
          if (!preview.ok) {
            results.push({ sku: item.sku, status: 'failed', submissionId: null, error: preview.error, isParent, issues: preview.issues })
            emit({ type: 'progress', sku: item.sku, status: 'failed', error: preview.error })
            await logPush({ parent_asin, sku: item.sku, field, previous_value: item.current, new_value: newValueStr, submission_id: null, status: 'failed', error_message: preview.error })
            await sleep(PATCH_DELAY_MS)
            continue
          }
          const live = usePartnerBaseline
            ? await patchParentSkuWithBaseline(sellerId, token, productType, item.sku, attribute, value, 'LIVE', parentBaseline as ParentBaselineAttrs)
            : await patchSku(sellerId, token, productType, item.sku, attribute, value, 'LIVE')
          let status = live.ok ? 'accepted' : 'failed'
          let effectiveError = live.error
          const liveIssues: AmazonIssue[] | undefined = live.issues
          // PARENT-HUB SILENT-DROP DETECTOR (2026-07-20): mirror the heal-path readback pattern at
          // :1350-1352 for ordinary parent PATCHes too — Amazon can return "ACCEPTED, no issues" and
          // still discard the write async on the parent hub (research-confirmed). For TITLE pushes the
          // readback is item_name; for other content fields (bullets/description) we skip the readback
          // (a joined-first-value comparison would false-mismatch) and rely on the existing verify path.
          // If the readback shows the pushed value did NOT persist, downgrade to status='failed' with a
          // silent-drop marker so summarizePush's parentNote fires + the heal cron can retry (and next
          // pass will benefit from any additional baseline attrs we learn to include).
          if (live.ok && isParent && field === 'title') {
            await sleep(PATCH_DELAY_MS)
            const readBack = await readbackItemName(sellerId, token, item.sku)
            if (readBack.length > 0 && readBack !== (typeof value === 'string' ? value : String(value)).trim()) {
              console.warn(`[push-content] PARENT-HUB SILENT-DROP on ${item.sku} item_name: pushed "${(typeof value === 'string' ? value : String(value)).trim().slice(0, 120)}", live "${readBack.slice(0, 120)}". Amazon accepted then dropped.`)
              status = 'failed'
              effectiveError = `silent-drop:item_name — Amazon accepted the parent PATCH but the live item_name still reads "${readBack.slice(0, 120)}". Family-baseline attrs (parentage_level + variation_theme) were included; readback still mismatched — likely a required parent attr Amazon expects we haven't identified yet. Manual check may be needed.`
            }
          }
          results.push({ sku: item.sku, status, submissionId: live.submissionId, error: effectiveError, isParent, issues: liveIssues })
          emit({ type: 'progress', sku: item.sku, status, submissionId: live.submissionId, error: effectiveError })
          await logPush({ parent_asin, sku: item.sku, field, previous_value: item.current, new_value: newValueStr, submission_id: live.submissionId, status, error_message: status === 'accepted' ? null : effectiveError })
          // Gate on `status` not `live.ok`: a parent-hub silent-drop downgraded live.ok=true to
          // status='failed', and optimistically caching the pushed value there would poison the
          // downstream ship-truth (cohesion / EDIT-ONCE / score) with a value Amazon never stored.
          if (status === 'accepted') {
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
        // attribute, schedule the cron to inherit it from a live child. Non-blocking. Live-notice: a
        // scheduled heal REPLACES the "complete it in Seller Central" parent note (that wording invites
        // the re-push that would abandon the heal); it stays only when NO heal could be scheduled.
        const heal = await maybeEnqueueParentHeal(parent_asin, productType, results)
        // TWIN HEAL (2026-08-05): CHILD rows blocked by their own incomplete composite (the
        // Later-Gator class — every content write bounces off missing shirt_size sub-fields) get
        // the twin-mirror heal scheduled; surfaced through the same healScheduled/healAttrs hints.
        const twin = await maybeEnqueueChildTwinHeal(parent_asin, productType, results)
        if (twin.scheduled) { heal.healScheduled = true; heal.healAttrs = [...heal.healAttrs, `${twin.containerKey} (${twin.count} variant${twin.count === 1 ? '' : 's'})`] }
        const parentNoteFinal = heal.healScheduled ? HEAL_SCHEDULED_PARENT_NOTE : parentNote

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
            const rr = await rescoreParentFromCache(db, parent_asin)
            if (rr) {
              // Phase C: fingerprint the measured copy (fingerprintOf VERBATIM → JOINs the snapshots)
              // and conditionally append a push-trigger score-history change-point row.
              pushedFingerprint = fingerprintOf((rr.topChildRow ?? rr.representative ?? rr.rows[0]) as never)
              pushedOverall = typeof rr.score.overall_score === 'number' ? rr.score.overall_score : null
              await appendScoreHistory(db, {
                parent_asin,
                overall_score: rr.score.overall_score,
                title_score: rr.score.title_score, bullet_score: rr.score.bullet_score,
                keyword_score: rr.score.keyword_score, aplus_score: rr.score.aplus_score,
                description_score: rr.score.description_score, features_score: rr.score.features_score,
                issues: Array.isArray(rr.score.issues) ? (rr.score.issues as unknown[]) : null,
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
          // title_source='manual' LOCKS it: a whole-listing AI Audit/Regenerate then PRESERVES the
          // seller's title instead of silently overwriting it (B0FRYMM56C) — only an explicit
          // "Regenerate title" clears the lock. See the regen guard in ai-recommendations POST.
          if (!cancelled && field === 'title' && typeof title_override === 'string' && title_override.trim()) {
            try {
              const { data: rt } = await db.from('listing_seo_recommendations').select('per_child_titles, recommended_title').eq('parent_asin', parent_asin).single()
              const isCapFam = Array.isArray(rt?.per_child_titles) && rt.per_child_titles.length > 1
              const manualTitle = title_override.trim().slice(0, 200)
              // Only LOCK when the pushed title actually DIFFERS from the current AI recommendation. Pushing
              // the AI recommended_title UNCHANGED (the Ship modal seeds it) must NOT lock the AI title as
              // 'manual' — that corruption hit B0FRYMM56C: the modal seeded the AI rewrite, the seller
              // shipped it, and this block buried his real title by locking the AI one. An AUTHORED title
              // is one that differs from the AI rec (or set explicitly via the Lock-title control).
              const isAuthored = manualTitle !== ((rt as { recommended_title?: string } | null)?.recommended_title ?? '').trim()
              if (!isCapFam && isAuthored) {
                // WITH the lock flag; if migration 044 (title_source) isn't applied, supabase-js returns
                // { error } — keep the seller's title, but LOG LOUDLY (a silently un-stamped lock is exactly
                // why a later audit could overwrite his title). Never silently pretend the lock saved.
                const { error: upErr } = await db.from('listing_seo_recommendations').update({ recommended_title: manualTitle, title_source: 'manual' }).eq('parent_asin', parent_asin)
                if (upErr) { console.error('[push-content] manual title-lock column write FAILED (migration 044 applied?):', upErr.message); await db.from('listing_seo_recommendations').update({ recommended_title: manualTitle }).eq('parent_asin', parent_asin) }
              }
            } catch (e) { console.warn('[push-content] persist manual title as recommendation failed (non-fatal):', e) }
          }

          // DONE-flip DELETED (ship-truth derivation, 2026-07-09): card verdicts are now DERIVED at
          // serve time from rec-vs-listing_content (deriveActionPlan in pushFields) — the push
          // write-through above already updated the cache, so the card flips DONE on the next serve
          // with zero stamps. The old block here was ALSO the "shipped but still red" bug: its
          // failed===0 gate tripped on any straggler in a 91-SKU push and silently left REPLACE.
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

        // PR-5 ship-truth visibility: a WHOLLY-REJECTED push (Amazon rejected EVERY SKU) otherwise writes
        // only keyword_push_log 'failed' rows and NO change-log row → indistinguishable in Change History
        // from "never pushed" (the exact "did anything ship?" ambiguity). Log a 0/N row so a rejected
        // attempt is VISIBLE and distinct from silence. No verify enqueue (nothing landed to verify).
        if (accepted === 0 && failed > 0 && !cancelled) {
          await logPushChange(db, { parent_asin, field, actor, accepted: 0, failed })
        }

        // ATTRIBUTION (spec §5 Phase B): a push mirrors a product-facing change-log row (action='push',
        // source='push_executor') + a NARROW compliance audit (listing.push). The exact pushed bytes
        // live in keyword_push_log; this row is the WHO/WHEN/action timeline. Fires whenever SOMETHING
        // shipped (accepted>0) so a PARTIAL push STILL appears in Change History — it used to require
        // failed===0, so a big family's partial push (any SKU failing) wrote NO row and vanished from
        // the timeline (the B0FRYMM56C "history doesn't show my push" report). The counts ride along so
        // the row reads "pushed the title to 133/148 variants". !cancelled: a STOPPED push's counts cover
        // only attempted SKUs, so it'd mislabel as complete (adversarial review #7).
        if (accepted > 0 && !cancelled) {
          await logPushChange(db, {
            parent_asin, field, actor, accepted, failed,
            after_value: field === 'title' ? (titleOv ?? null) : null,
            submission_id: results.find((r) => r.status === 'accepted')?.submissionId ?? null,
          })
          await logAudit({
            userId: actor.id, action: 'listing.push', resourceType: 'listing', resourceId: parent_asin,
            details: { field, accepted, failed, by: actor.name },
          })
        }
        // Phase C (§4-E / Risk R3): the OUTCOME EPOCH stays on the STRICT full-accept gate — it anchors
        // the measurement to a FULLY-shipped copy (push_epoch_at=now, fingerprint=just-pushed content,
        // baseline=post-push score). A partial push is not the final content, so it must NOT reset the
        // epoch. A new full push RESETS it (upsert) to re-measure. Best-effort, never blocks the push.
        if (failed === 0 && !cancelled && accepted > 0) {
          await stampOutcomeEpoch(db, { parent_asin, fingerprint: pushedFingerprint, baseline_overall_score: pushedOverall })
        }

        const label = FIELD_CONFIG[field].label.toLowerCase()
        const skippedNote = skippedNotLive.length > 0
          ? ` ${skippedNotLive.length} skipped (not a live Amazon listing yet — Missing offer/incomplete; complete their offer in Seller Central, then re-push).`
          : ''
        const skippedResults: typeof results = skippedNotLive.map((d) => ({ sku: d.sku, status: 'skipped', submissionId: null, error: 'Not a live Amazon listing yet (Missing offer/incomplete) — skipped so the push cannot create a phantom. Complete its offer in Seller Central, then re-push.' }))
        // Item A (2026-07-21): surface the parent-bypass event so the frontend popup fires. The popup
        // uses `parentManualContainers` to render the exact fields the operator needs to fix in SC.
        const parentManualRow = results.find((r) => r.isParent && r.status === 'skipped_manual_parent')
        const parentManualRequired = Boolean(parentManualRow)
        const parentManualContainers = parentBypass.bypass ? parentBypass.containers : undefined
        emit({
          type: 'result',
          parent_asin, field,
          pushed: accepted, failed, total: childTotal, cancelled: cancelled || undefined,
          healScheduled: heal.healScheduled, healAttrs: heal.healAttrs,
          parentManualRequired: parentManualRequired || undefined,
          parentManualContainers,
          message: cancelled
            ? `Stopped by you — ${accepted}/${childTotal} accepted before the stop stay pushed; ${diff.length - results.length} SKU${diff.length - results.length === 1 ? '' : 's'} untouched.`
            : `Pushed ${label} for ${accepted}/${childTotal} variant${childTotal === 1 ? '' : 's'}${failed ? `, ${failed} failed` : ''}.${parentNoteFinal}${skippedNote} Changes typically reflect in 15-30 minutes.`,
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
    // PHANTOM GATE (2026-07-20 details-path parity): skip offerless-backfilled rows BEFORE they reach
    // Amazon's PATCH endpoint — the SAME class of bug that split B0DQ5YZH38 into 39+8 variants when
    // details:title_differentiation was retried against phantom SKUs. Mirrors the single-attribute path
    // above + the content-path (~line 3121). 50%-safety-valve already applied inside expandDetailSkuSet.
    const bulkSkippedNotLive = skuSetRaw.filter((s) => s.notLive && s.asin !== parent_asin)
    if (bulkSkippedNotLive.length > 0) {
      emit({ type: 'progress', message: `Skipping ${bulkSkippedNotLive.length} SKU(s) with no live Amazon offer (backfilled duplicates) — pushing to them would create phantom listings.` })
    }
    const skuSet = skuSetRaw.filter((s) => s.asin !== parent_asin && !s.notLive)
    if (skuSet.length === 0) { emit({ type: 'error', error: 'No SKUs found for this parent. Run a Sync first.' }); return }
    const spKeys = checkedPlans.map((p) => p.attribute.spApiKey)

    // ── PHASE 2 — calibrate each composite's write-form ONCE (reuse the validator-probe + cache).
    //    A field that can't calibrate is excluded (others proceed) — never a whole-run abort.
    for (const p of checkedPlans) {
      if (!p.valueShape) { p.patchValue = buildDetailPatchValue(p.attribute, p.value, MARKETPLACE_ID) as unknown as Record<string, unknown>[]; continue }
      const formKey = `${productType}|${p.attribute.spApiKey}`
      const variants = buildShapedDetailValueVariants(p.valueShape, p.value, MARKETPLACE_ID)
      // Cache lookup is by variant ID (the list is value-dependent) — a stale/missing id recalibrates.
      const cachedId = _detailFormCache.get(formKey) ?? null
      let winIdx = cachedId ? variants.findIndex((v) => v.id === cachedId) : -1
      let transportAbortErr: string | null = null
      if (winIdx < 0) {
        // FIX 1 (adversarial review): transport-aware probing (calibrateVariants) — a 429/5xx or
        // thrown fetch retries the SAME variant; only a validation rejection advances. Transport-
        // exhausted -> abort THIS field's calibration (skipped, loud) without advancing into a
        // different sub-field's variants; the other fields proceed as before.
        const res = await calibrateVariants(variants,
          (v) => patchSkuMulti(sellerId, token, productType, skuSet[0].sku,
            [{ op: 'replace', path: `/attributes/${p.attribute.spApiKey}`, value: v.value }], 'VALIDATION_PREVIEW'),
          { interProbeDelayMs: PATCH_DELAY_MS })
        if (res.winId) { winIdx = variants.findIndex((v) => v.id === res.winId); _detailFormCache.set(formKey, res.winId) }
        else if (res.transportAbort) transportAbortErr = res.errors[res.errors.length - 1] ?? 'transport failure'
      }
      if (winIdx < 0) {
        skipped.push({ field: p.field, reason: transportAbortErr
          ? `Amazon throttled/errored during calibration (${transportAbortErr}) — field skipped this run so a transport blip can't pick the wrong sub-field; push again in a minute`
          : 'Amazon rejected every known write form (calibration failed)' })
        p.patchValue = undefined; p.value = '__CALIBRATION_FAILED__'
      }
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
          perFieldStatus = await pushPerFieldFallback(sellerId, token, productType, s.sku, changedPlans, parent_asin)
        }
      } else {
        // Atomic batch rejected (≥1 bad attribute) → per-field so the good ones still land.
        perFieldStatus = await pushPerFieldFallback(sellerId, token, productType, s.sku, changedPlans, parent_asin)
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
          const { representative, scoredRows } = pickRescoreRepresentative(rows as never[], parent_asin, (sc?.top_child_asin as string) ?? null)
          const score = scoreListingContent(representative as never, scoredRows as never, ctxS)
          await db.from('listing_seo_scores').update({
            title_score: score.title_score, bullet_score: score.bullet_score, keyword_score: score.keyword_score,
            aplus_score: score.aplus_score, description_score: score.description_score, features_score: score.features_score,
            overall_score: score.overall_score, issues: score.issues, child_override_count: score.child_override_count,
            scored_at: new Date().toISOString(),
          }).eq('parent_asin', parent_asin)
          // Phase C §4-D: append a push-trigger score-history change-point. A BULK-DETAILS push changes
          // attributes, NOT content COPY, so (like the single-details branch) we do NOT stamp/reset the
          // outcome epoch — only the score move is recorded. Fingerprint current content so it JOINs.
          const topRow = (sc?.top_child_asin ? rows.find((r) => r.asin === sc.top_child_asin) : rows[0]) ?? representative ?? rows[0]
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

    // ATTRIBUTION (spec §5 Phase B): a bulk push mirrors a change-log row per accepted field
    // (action='push', source='push_executor') + ONE narrow logAudit('listing.push') for the batch.
    // Fires on totalAccepted>0 (PARTIAL bulk pushes included, so they still appear in Change History —
    // the B0FRYMM56C fix); per-field counts ride along. Best-effort — never blocks a written push.
    // !cancelled: a STOPPED bulk push's counts cover only attempted SKUs, so it'd mislabel as complete.
    if (totalAccepted > 0 && !cancelled) {
      for (const p of acceptedFields) {
        await logPushChange(db, { parent_asin, field: `details:${p.attribute.spApiKey}`, actor, after_value: p.value, accepted: tally[p.field].accepted, failed: tally[p.field].failed })
      }
      await logAudit({
        userId: actor.id, action: 'listing.push', resourceType: 'listing', resourceId: parent_asin,
        details: { mode: 'details_bulk', fields: acceptedFields.map((p) => p.field), accepted: totalAccepted, failed: totalFailed, by: actor.name },
      })
    }
    emit({
      type: 'result', mode: 'details_bulk', parent_asin, perField,
      pushed: totalAccepted, failed: totalFailed, total: skusTouched, cancelled: cancelled || undefined,
      message: cancelled
        ? `Stopped by you — ${skusTouched} SKU(s) processed before the stop; accepted fields stay pushed, the rest are untouched.`
        : `Auto Push done — ${livePlans.length} field(s) across ${skusTouched} SKU(s) that needed it${skipped.length ? `; ${skipped.length} field(s) skipped` : ''}.${bulkParentDropped ? ' (Variation parent skipped — non-buyable hub.)' : ''}${bulkSkippedNotLive.length > 0 ? ` (${bulkSkippedNotLive.length} SKU${bulkSkippedNotLive.length === 1 ? '' : 's'} skipped — no live Amazon offer; complete the offer${bulkSkippedNotLive.length === 1 ? '' : 's'} in Seller Central, then re-push.)` : ''} Changes reflect in 15min–6hr; use Verify live to confirm.`,
    })
  } catch (err) {
    emit({ type: 'error', error: err instanceof Error ? err.message : 'Auto Push failed' })
  }
}

// ─── BULK "Ship all core": Title + Bullets + Description + Keywords in ONE PATCH per SKU ──────────
// The CONTENT analog of executeBulkDetailsPush. Where the details bulk batches product-detail
// ATTRIBUTES, this batches the four CORE content fields — but with a MIXED body: title/bullets/
// description are BROADCAST (one value to every child) while keywords are PER-CHILD (each SKU its own
// backend string). The value for each (field, SKU) comes from that field's OWN loadDiff row, so the
// broadcast-vs-per-child split is resolved per field and merged per SKU into ONE submission. Failure
// isolation mirrors the details bulk (atomic batch → per-field fallback). UNLIKE the details bulk,
// this DOES change the copy under measurement, so a FULL accept STAMPS the outcome epoch (exactly as
// executePush does for a single core field). The non-buyable variation parent is DROPPED (it carries
// no per-child keywords and re-validates its whole record on a content PATCH), so `generic_keyword`
// is never built for it.
export async function executeBulkCorePush(params: PushParams, emit: PushEmit): Promise<void> {
  const { parent_asin } = params
  const actor: PushActor = params.actor ?? SYSTEM_ACTOR  // attribution (spec §5 Phase B)
  try {
    // Requested core fields (default = all four; a field with no diff is dropped after loadDiff). Deduped
    // so a direct POST with a repeated field can't double-push an attribute for a SKU.
    const requested: PushField[] = [...new Set((Array.isArray(params.core_fields) && params.core_fields.length > 0)
      ? params.core_fields.filter(isPushField)
      : [...PUSH_FIELDS])]
    if (requested.length === 0) { emit({ type: 'error', error: 'No core fields selected to ship.' }); return }

    // Reconcile the live family ONCE (mirror executePush's full-push reconcile) so any newly-linked /
    // never-ingested variation child gets a listing_content row BEFORE loadDiff reads it — a child with
    // no row is invisible to the push. Offer-gated + additive (only materializes children with a LIVE
    // offer), so every backfilled row then passes loadDiff's ground-truth gate.
    try {
      const supaRec = await createAdminClient()
      const reconcileRes = await reconcileFamilyChildren(parent_asin, supaRec)
      if (reconcileRes.backfilled > 0 || reconcileRes.reattached > 0) {
        console.log(`[bulk-core] pre-push reconcile: +${reconcileRes.backfilled} backfilled, ${reconcileRes.reattached} reattached of ${reconcileRes.childAsins} live children`)
      }
    } catch (e) { console.warn('[bulk-core] pre-push reconcile skipped (non-fatal):', e instanceof Error ? e.message : e) }

    // Load each requested field's per-SKU diff. loadDiff already: resolves broadcast-vs-per-child
    // values, adds FBA/FBM twins, tags offerless rows notLive, and (for broadcast fields) appends the
    // variation PARENT row. We DROP the parent here (bulk-core never ships the non-buyable hub — same
    // as the details bulk) and SKIP notLive rows (never PATCH an offerless SKU → phantom listing). Each
    // field's OWN diff row for the SKU drives its value — THAT is the mixed body.
    interface CorePlanRow { field: PushField; value: string | string[]; current: string }
    interface SkuPlan { sku: string; asin: string | undefined; rows: CorePlanRow[] }
    const bySku = new Map<string, SkuPlan>()
    const notLiveSkus = new Set<string>()
    const activeFields: PushField[] = []
    let parentDropped = false
    for (const field of requested) {
      const rows = (await loadDiff(parent_asin, field)).filter((d) => d.raw != null)
      let fieldHasChange = false
      for (const d of rows) {
        // DROP the non-buyable variation parent (asin === parent_asin OR the isParent flag loadDiff set
        // on the broadcast parent row) — no per-child keywords, and it re-validates its whole record.
        if (d.asin === parent_asin || d.isParent) { parentDropped = true; continue }
        if (d.notLive) { notLiveSkus.add(d.sku); continue }   // confirmed-offerless → phantom-prevention
        if (!d.changed) continue                              // only fields that differ from live push
        fieldHasChange = true
        // SCRUB-AT-PUSH backstop (mirror executePush): trademark-scrub the value at publish time so a
        // manually-typed or stale mark can never be written to Amazon. Idempotent on generated copy.
        // Celebrity-scrub mirrored here too (2026-07-21) — the bulk-push path must not become a
        // policy-scrub gap. Idempotent, logs every strip.
        const raw = d.raw as string | string[]
        const scrubOne = (s: string) => scrubCelebrityNames(scrubTrademarks(s), `bulk-push:${field}:${d.sku}`)
        const value = Array.isArray(raw) ? raw.map(scrubOne) : scrubOne(raw)
        let plan = bySku.get(d.sku)
        if (!plan) { plan = { sku: d.sku, asin: d.asin, rows: [] }; bySku.set(d.sku, plan) }
        plan.rows.push({ field, value, current: d.current })
      }
      if (fieldHasChange) activeFields.push(field)
    }
    // A SKU any field flagged offerless must NEVER be PATCHed (even if another field's diff added it
    // before the flag was seen) — drop it entirely so we can't half-push a phantom.
    for (const sku of notLiveSkus) bySku.delete(sku)

    const skuPlans = [...bySku.values()].filter((p) => p.rows.length > 0)
    if (skuPlans.length === 0) {
      emit({
        type: 'result', mode: 'core_bulk', parent_asin, perField: [],
        pushed: 0, failed: 0, total: 0,
        message: notLiveSkus.size > 0
          ? `Nothing pushed — ${notLiveSkus.size} variant${notLiveSkus.size === 1 ? '' : 's'} skipped (not a live Amazon listing yet — Missing offer/incomplete). Complete the offer${notLiveSkus.size === 1 ? '' : 's'} in Seller Central, then re-ship.`
          : `Nothing to ship — every core field already matches live.`,
      })
      return
    }

    const token       = await getAccessToken()
    const sellerId    = await getSellerId()
    const productType = await getProductType(sellerId, token, skuPlans[0].sku)
    const supabase    = await createAdminClient()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = supabase as any
    const logPush = async (rowIn: Record<string, unknown>) => {
      const row: Record<string, unknown> = { ...rowIn, pushed_by: actor.id }  // attribution (spec §5 Phase B)
      try {
        const { error } = await db.from('keyword_push_log').insert(row)
        if (!error) return
        const rest = { ...row }; delete rest.field
        const { error: error2 } = await db.from('keyword_push_log').insert(rest)
        if (error2) console.error('[bulk-core] keyword_push_log insert FAILED both attempts — ship date will be missing. first:', error?.message ?? error, '| second:', error2?.message ?? error2)
      } catch (e) { console.error('[bulk-core] keyword_push_log insert threw:', e) }
    }

    // per-field tally (accepted/failed across SKUs) — drives write-through, verify enqueue, epoch.
    const tally: Record<string, { accepted: number; failed: number }> = {}
    for (const f of activeFields) tally[f] = { accepted: 0, failed: 0 }

    emit({ type: 'started', mode: 'core_bulk', fields: activeFields.map((f) => FIELD_CONFIG[f].label), total: skuPlans.length, broadcast: false })

    let cancelled = false
    let skusTouched = 0
    // ── per SKU: batch the changed core fields into ONE PATCH; per-field fallback on atomic rejection.
    for (const plan of skuPlans) {
      if (pushCancelled(params.cancel_token)) { cancelled = true; break }
      skusTouched++
      const rowByField = new Map(plan.rows.map((r) => [r.field, r]))
      const changedLabels = plan.rows.map((r) => FIELD_CONFIG[r.field].label)
      emit({ type: 'progress', sku: plan.sku, status: 'validating', fields: changedLabels })

      // MIXED body: each field's own resolved (scrubbed) value → one replace op. The parent is already
      // dropped, so no row is isParent; buildCoreOps still asserts keywords-never-for-parent.
      const ops = buildCoreOps(plan.rows.map((r) => ({ field: r.field, value: r.value })), MARKETPLACE_ID)
      const preview = await patchSkuMulti(sellerId, token, productType, plan.sku, ops, 'VALIDATION_PREVIEW')
      let perFieldStatus: { field: PushField; ok: boolean; submissionId: string | null; error?: string }[]
      if (preview.ok) {
        const live = await patchSkuMulti(sellerId, token, productType, plan.sku, ops, 'LIVE')
        if (live.ok) {
          perFieldStatus = plan.rows.map((r) => ({ field: r.field, ok: true, submissionId: live.submissionId }))
        } else {
          // Valid preview but live rejected (race / throttle) → isolate per field for THIS sku.
          perFieldStatus = await pushCoreFieldFallback(sellerId, token, productType, plan.sku, plan.rows)
        }
      } else {
        // Atomic batch rejected (≥1 bad field) → per-field so the good ones still land.
        perFieldStatus = await pushCoreFieldFallback(sellerId, token, productType, plan.sku, plan.rows)
      }

      // Log every (field, SKU) attempt with field UNPREFIXED (the `details:` prefix is details-only) +
      // previous_value = the row's cached current, and WRITE-THROUGH the accepted fields into
      // listing_content (ship-truth: omitting this leaves the card red). One cache UPDATE per SKU.
      const cachePatch: Record<string, string | null> = {}
      for (const r of perFieldStatus) {
        const planRow = rowByField.get(r.field)
        if (!planRow) continue
        tally[r.field][r.ok ? 'accepted' : 'failed']++
        await logPush({ parent_asin, sku: plan.sku, field: r.field, previous_value: planRow.current, new_value: asCompare(planRow.value), submission_id: r.submissionId, status: r.ok ? 'accepted' : 'failed', error_message: r.ok ? null : r.error })
        if (r.ok) Object.assign(cachePatch, cacheUpdateFor(r.field, planRow.value))
      }
      if (Object.keys(cachePatch).length > 0) {
        try {
          await db.from('listing_content').update({ ...cachePatch, content_synced_at: new Date().toISOString() }).eq('sku', plan.sku)
        } catch (e) { console.warn('[bulk-core] listing_content cache update failed:', e) }
      }
      const skuFailed = perFieldStatus.filter((r) => !r.ok)
      emit({ type: 'progress', sku: plan.sku, status: skuFailed.length === 0 ? 'accepted' : (skuFailed.length === perFieldStatus.length ? 'failed' : 'partial'),
        fields: changedLabels, failedFields: skuFailed.map((r) => FIELD_CONFIG[r.field].label), error: skuFailed[0]?.error })
      await sleep(PATCH_DELAY_MS)
    }

    // ── ONE re-score for the whole batch + a push-trigger score-history change-point. Capture the
    // fingerprint + post-push overall EXACTLY as executePush does so the epoch + history row measure the
    // just-shipped copy.
    const totalAccepted = activeFields.reduce((n, f) => n + tally[f].accepted, 0)
    const totalFailed   = activeFields.reduce((n, f) => n + tally[f].failed, 0)
    let pushedFingerprint: string | null = null
    let pushedOverall: number | null = null
    if (totalAccepted > 0) {
      emit({ type: 'rescore', message: 'Re-scoring listing…' })
      try {
        const rr = await rescoreParentFromCache(db, parent_asin)
        if (rr) {
          pushedFingerprint = fingerprintOf((rr.topChildRow ?? rr.representative ?? rr.rows[0]) as never)
          pushedOverall = typeof rr.score.overall_score === 'number' ? rr.score.overall_score : null
          await appendScoreHistory(db, {
            parent_asin,
            overall_score: rr.score.overall_score,
            title_score: rr.score.title_score, bullet_score: rr.score.bullet_score,
            keyword_score: rr.score.keyword_score, aplus_score: rr.score.aplus_score,
            description_score: rr.score.description_score, features_score: rr.score.features_score,
            issues: Array.isArray(rr.score.issues) ? (rr.score.issues as unknown[]) : null,
          }, { trigger: 'push', scoredBy: actor.id, scoredByName: actor.name, fingerprint: pushedFingerprint })
        }
      } catch (e) { console.warn('[bulk-core] re-score failed (non-fatal):', e) }

      // AUTO-VERIFY: one task per CORE field that got ≥1 accept. Cron re-pushes stale SKUs to 100%.
      if (!cancelled) try {
        const { enqueueVerification } = await import('@/lib/fba/verificationQueue')
        for (const f of activeFields) {
          if (tally[f].accepted > 0) await enqueueVerification({ parent_asin, field: f })
        }
      } catch (e) { console.warn('[bulk-core] verify enqueue failed (non-fatal):', e) }

      // ATTRIBUTION (spec §5 Phase B): a change-log row per accepted field + ONE narrow logAudit for the
      // batch. Fires on totalAccepted>0 (partial included) so it still appears in Change History.
      if (!cancelled) {
        for (const f of activeFields) {
          if (tally[f].accepted > 0) {
            await logPushChange(db, { parent_asin, field: f, actor, accepted: tally[f].accepted, failed: tally[f].failed })
          } else if (tally[f].failed > 0) {
            // PR-5 ship-truth visibility: a field Amazon rejected on EVERY SKU logs a 0/N row so a
            // wholly-rejected field is visible in Change History (not silently absent = "never pushed").
            await logPushChange(db, { parent_asin, field: f, actor, accepted: 0, failed: tally[f].failed })
          }
        }
        await logAudit({
          userId: actor.id, action: 'listing.push', resourceType: 'listing', resourceId: parent_asin,
          details: { mode: 'core_bulk', fields: activeFields.filter((f) => tally[f].accepted > 0), accepted: totalAccepted, failed: totalFailed, by: actor.name },
        })
      }
    }

    // ── OUTCOME EPOCH (§4-E / Risk R3): stamp on a FULL accept — every attempted op across every SKU
    // accepted AND nothing cancelled. A bulk-core push CHANGES the copy under measurement (unlike the
    // details bulk), so it RESETS the epoch to re-measure the shipped copy. Partial/cancelled → do NOT
    // stamp (that copy isn't the final content). Best-effort — never blocks the push.
    if (totalFailed === 0 && !cancelled && totalAccepted > 0) {
      await stampOutcomeEpoch(db, { parent_asin, fingerprint: pushedFingerprint, baseline_overall_score: pushedOverall })
    }

    const perField = activeFields.map((f) => ({ field: FIELD_CONFIG[f].label, accepted: tally[f].accepted, failed: tally[f].failed }))
    const skippedNote = notLiveSkus.size > 0
      ? ` ${notLiveSkus.size} variant${notLiveSkus.size === 1 ? '' : 's'} skipped (not a live Amazon listing yet — Missing offer/incomplete; complete their offer in Seller Central, then re-ship).`
      : ''
    emit({
      type: 'result', mode: 'core_bulk', parent_asin, perField,
      pushed: totalAccepted, failed: totalFailed, total: skusTouched, cancelled: cancelled || undefined,
      message: cancelled
        ? `Stopped by you — ${skusTouched} SKU(s) processed before the stop; accepted fields stay pushed, the rest are untouched.`
        : `Shipped ${activeFields.length} core field(s) across ${skusTouched} SKU(s) that needed it${totalFailed ? `, ${totalFailed} field-push(es) failed` : ''}.${parentDropped ? ' (Variation parent skipped — non-buyable hub.)' : ''}${skippedNote} Changes typically reflect in 15-30 minutes.`,
    })
  } catch (err) {
    emit({ type: 'error', error: err instanceof Error ? err.message : 'Ship all core failed' })
  }
}

/** Per-field fallback for ONE SKU when the atomic batch is rejected — push each field's single
 *  attribute alone so the valid ones still land and only the offending one fails for this SKU. */
async function pushPerFieldFallback(
  sellerId: string, token: string, productType: string, sku: string,
  plans: BulkFieldPlan[],
  parent_asin: string,
): Promise<{ field: string; spApiKey: string; ok: boolean; submissionId: string | null; error?: string }[]> {
  const out: { field: string; spApiKey: string; ok: boolean; submissionId: string | null; error?: string }[] = []
  for (const p of plans) {
    let preview = await patchSkuDetail(sellerId, token, productType, sku, p.attribute, p.value, 'VALIDATION_PREVIEW', p.valueShape, p.patchValue)
    // PARITY with the single-attribute IH site: auto-heal 100476 by pushing recommended ≤75 item_name
    // for THIS SKU, then retrying the highlight. Scoped to the IH attribute and the exact error.
    let autoHealNote: string | null = null
    if (!preview.ok
        && isItemHighlightsField(null, p.attribute.spApiKey)
        && isItemHighlightTitleTooLongError(preview.error)) {
      const heal = await autoHealIhLongTitle(sellerId, token, productType, sku, parent_asin)
      if (heal.healed) {
        autoHealNote = `auto-healed item_name to "${heal.usedTitle}" (${heal.usedTitle!.length} chars) first`
        preview = await patchSkuDetail(sellerId, token, productType, sku, p.attribute, p.value, 'VALIDATION_PREVIEW', p.valueShape, p.patchValue)
      } else {
        autoHealNote = `auto-heal skipped: ${heal.error}`
      }
    }
    if (!preview.ok && previewObjectionsUnrelated(preview, p.attribute.spApiKey)) {
      // Standing-state echo about OTHER attributes — not a verdict on this detail write.
      console.log(JSON.stringify({ tag: 'PUSH_ECHO_BYPASS', sku, attribute: p.attribute.spApiKey }))
    } else if (!preview.ok) {
      const baseErr = preview.error && /currently unsupported/i.test(preview.error)
        ? `${preview.error} — Amazon hasn't opened API writes for this attribute yet (launch July 27, 2026).`
        // PARITY with the single-attribute IH site: Amazon 100476 = this SKU's live title is >75 chars.
        : isItemHighlightsField(null, p.attribute.spApiKey) && isItemHighlightTitleTooLongError(preview.error)
          ? ITEM_HIGHLIGHT_TITLE_TOO_LONG_MSG
          : preview.error
      const friendly = autoHealNote ? `${baseErr} (${autoHealNote})` : baseErr
      // Belt-and-suspenders self-heal: a live "currently unsupported" on the Item Highlights field is
      // ground truth → persist blocked (guarded so another attribute's same error can't flip the flag).
      if (isItemHighlightsField(null, p.attribute.spApiKey) &&
          preview.error && /currently unsupported/i.test(preview.error)) {
        void (async () => { try { await setItemHighlightsApiState(await createAdminClient(), false) } catch { /* best-effort */ } })()
      }
      out.push({ field: p.field, spApiKey: p.attribute.spApiKey, ok: false, submissionId: null, error: friendly })
      await sleep(PATCH_DELAY_MS); continue
    }
    const live = await patchSkuDetail(sellerId, token, productType, sku, p.attribute, p.value, 'LIVE', p.valueShape, p.patchValue)
    // Self-heal → writable: a genuine live ACCEPT of the Item Highlights field proves Amazon opened writes.
    if (live.ok && isItemHighlightsField(null, p.attribute.spApiKey)) {
      void (async () => { try { await setItemHighlightsApiState(await createAdminClient(), true) } catch { /* best-effort */ } })()
    }
    out.push({ field: p.field, spApiKey: p.attribute.spApiKey, ok: live.ok, submissionId: live.submissionId, error: live.error })
    await sleep(PATCH_DELAY_MS)
  }
  return out
}

/** Per-field fallback for ONE SKU when the atomic batched CORE PATCH is rejected — retry each core
 *  field as its own single-attribute patch so the valid fields still land and only the offending one
 *  fails for this SKU (the content analog of pushPerFieldFallback). `value` is already scrubbed;
 *  patchSku builds the same buildPatchValue body buildCoreOps used, so the batch and the fallback are
 *  byte-identical per field. */
async function pushCoreFieldFallback(
  sellerId: string, token: string, productType: string, sku: string,
  rows: { field: PushField; value: string | string[]; current: string }[],
): Promise<{ field: PushField; ok: boolean; submissionId: string | null; error?: string }[]> {
  const out: { field: PushField; ok: boolean; submissionId: string | null; error?: string }[] = []
  for (const r of rows) {
    const attribute = FIELD_CONFIG[r.field].attribute
    const preview = await patchSku(sellerId, token, productType, sku, attribute, r.value, 'VALIDATION_PREVIEW')
    if (!preview.ok && !previewObjectionsUnrelated(preview, attribute)) {
      out.push({ field: r.field, ok: false, submissionId: null, error: preview.error })
      await sleep(PATCH_DELAY_MS); continue
    }
    if (!preview.ok) console.log(JSON.stringify({ tag: 'PUSH_ECHO_BYPASS', sku, attribute }))
    const live = await patchSku(sellerId, token, productType, sku, attribute, r.value, 'LIVE')
    out.push({ field: r.field, ok: live.ok, submissionId: live.submissionId, error: live.error })
    await sleep(PATCH_DELAY_MS)
  }
  return out
}
