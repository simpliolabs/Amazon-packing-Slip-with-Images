/**
 * OFFER LIVENESS — the push gate's own truth, persisted (migration 059, sku_offer_liveness).
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS. The push executor already asks Amazon's Listings-Items API, per child ASIN,
 * which seller SKUs are live (discoverSkusForAsin) and SKIPS confirmed-offerless rows so a PATCH
 * can never materialize a phantom "Missing offer" ASIN. familyReconcile already reads each
 * missing child's offers[] and skips offerless children. Both compute a per-SKU live/offerless
 * verdict on EVERY push / verify / reconcile — and then threw it away. The VARIANT-DEATH ALARM
 * meanwhile read two PROXIES (content-sync lag, listing_health status) which BOTH read "healthy"
 * for the Later Gator family's dead Orchid offers (B0GML5V7KZ, 6014XL-ORC-Later-Gator-LS-TS ...)
 * while the gate was skipping those exact SKUs as offerless. This module is the ONE seam where
 * that verdict lands so the alarm reads what the gate already knows.
 *
 * Doctrine:
 *  - ONE WRITER (recordOfferLiveness). Truth sites call it; nothing else writes the table.
 *  - NO NEW AMAZON CALLS. Observations come only from results the truth sites already fetched.
 *    The pure helpers below (observationsFromGate, mergeLivenessObservation) interpret those
 *    results; they never fetch.
 *  - FAIL-OPEN. A push must never fail because bookkeeping failed: every error is logged and
 *    swallowed; the function never throws. (Missing table before the PO applies migration 059 ⇒
 *    a warn line and byte-identical push behavior.)
 *  - STREAK SEMANTICS (mirrors the column comments in 059):
 *      live  ⇒ offer_seen_live_at = now, offer_missing_since = NULL   (any live sighting ends a streak)
 *      dead  ⇒ offer_missing_since = COALESCE(existing, now)           (first-seen-dead STICKS)
 *    so the alarm can distinguish "dead since June" from "one empty result just now".
 */
import type { SupabaseClient } from '@supabase/supabase-js'

export type OfferLivenessSource = 'push_gate' | 'details_gate' | 'family_reconcile' | 'ih_probe'

/** One interpreted verdict from a truth site. */
export interface OfferLivenessObservation {
  sku: string
  asin?: string | null
  parent_asin?: string | null
  offer_live: boolean
  source: OfferLivenessSource
  detail?: string | null
}

/** One stored row (sku_offer_liveness). Columns = OFFER_LIVENESS_COLS. */
export interface OfferLivenessRow {
  sku: string
  asin: string | null
  parent_asin: string | null
  last_checked_at: string
  offer_live: boolean
  source: string
  detail: string | null
  offer_seen_live_at: string | null
  offer_missing_since: string | null
}

export const OFFER_LIVENESS_COLS =
  'sku, asin, parent_asin, last_checked_at, offer_live, source, detail, offer_seen_live_at, offer_missing_since'

/** A SKU Amazon reported under an ASIN (discoverSkusForAsin's element shape). */
export interface DiscoveredSku { sku: string; asin: string }

/**
 * THE merge rule (pure). Folds one observation into the existing row (or null when the SKU has
 * never been recorded). The asin / parent_asin keys follow the observation when it carries them
 * (a SKU re-parented on Amazon moves with its next verdict) and otherwise keep the stored value.
 */
export function mergeLivenessObservation(
  existing: OfferLivenessRow | null,
  obs: OfferLivenessObservation,
  nowIso: string,
): OfferLivenessRow {
  return {
    sku: obs.sku,
    asin: obs.asin ?? existing?.asin ?? null,
    parent_asin: obs.parent_asin ?? existing?.parent_asin ?? null,
    last_checked_at: nowIso,
    offer_live: obs.offer_live,
    source: obs.source,
    detail: obs.detail ?? null,
    offer_seen_live_at: obs.offer_live ? nowIso : (existing?.offer_seen_live_at ?? null),
    offer_missing_since: obs.offer_live ? null : (existing?.offer_missing_since ?? nowIso),
  }
}

/**
 * THE interpretation rule for the ASIN-search gates (pure). Mirrors the gate's own verdict
 * exactly — loadDiff / expandDetailSkuSet tag a row `notLive` iff Amazon's Listings-Items search
 * by ASIN SUCCEEDED and returned ZERO seller SKUs, then a SAFETY VALVE clears every notLive when
 * half or more of the family would be skipped (distrust: throttling / empty-en-masse). Feed this
 * the rows AFTER the valve so a distrusted verdict is never persisted:
 *   notLive === true                       ⇒ dead  (the gate is about to skip it as offerless)
 *   discovered[asin] lists this exact SKU  ⇒ live  (Amazon named it as a seller listing)
 *   anything else                          ⇒ NO observation — lookup failed (null), the valve
 *                                            tripped ([] but notLive cleared), or the stored SKU
 *                                            is not among the SKUs Amazon lists under its ASIN
 *                                            (a different failure mode; not this gate's verdict).
 * Live is the union of the rows passed in AND every discovered SKU (the FBM twins the push adds
 * to its diff) — so the persisted roster grows to the full family the push actually targets.
 */
export function observationsFromGate(
  rows: { sku: string; asin?: string | null; notLive?: boolean }[],
  discoveredByAsin: Map<string, DiscoveredSku[] | null>,
  ctx: { parentAsin: string | null; source: OfferLivenessSource },
): OfferLivenessObservation[] {
  const out = new Map<string, OfferLivenessObservation>()
  // Every SKU Amazon named under a probed ASIN is live — twins included, even when the diff
  // later dropped them (twin-name guard) — Amazon's statement about the SKU is still true.
  for (const [asin, discovered] of discoveredByAsin) {
    if (!Array.isArray(discovered)) continue
    for (const d of discovered) {
      if (!d?.sku) continue
      out.set(d.sku, {
        sku: d.sku, asin: d.asin || asin, parent_asin: ctx.parentAsin, offer_live: true,
        source: ctx.source, detail: 'Listings-Items search by ASIN lists this SKU as a seller listing',
      })
    }
  }
  for (const r of rows) {
    if (!r.sku) continue
    if (r.notLive === true) {
      out.set(r.sku, {
        sku: r.sku, asin: r.asin ?? null, parent_asin: ctx.parentAsin, offer_live: false,
        source: ctx.source, detail: 'Listings-Items search by ASIN returned 0 seller SKUs (gate skipped as offerless)',
      })
    }
    // else: either already recorded live above (Amazon listed it) or unknown → no observation.
  }
  return [...out.values()]
}

/**
 * THE writer. Batched read-merge-upsert keyed by sku; duplicates within one call collapse to the
 * LAST observation for that SKU. Never throws; returns how many rows were written (0 on any
 * failure) so callers can log without branching on it. The read-before-write is what implements
 * COALESCE(existing offer_missing_since, now) — two concurrent writers racing on the same SKU
 * both land ~now, which is the same answer; the next observation re-converges either way.
 */
export async function recordOfferLiveness(
  supabase: SupabaseClient,
  observations: OfferLivenessObservation[],
  nowIso: string = new Date().toISOString(),
): Promise<number> {
  try {
    const bySku = new Map<string, OfferLivenessObservation>()
    for (const o of observations) if (o && typeof o.sku === 'string' && o.sku.length > 0) bySku.set(o.sku, o)
    if (bySku.size === 0) return 0
    const skus = [...bySku.keys()]
    const CHUNK = 200
    let written = 0
    for (let i = 0; i < skus.length; i += CHUNK) {
      const chunk = skus.slice(i, i + CHUNK)
      const { data: existingRaw, error: readErr } = await supabase
        .from('sku_offer_liveness')
        .select(OFFER_LIVENESS_COLS)
        .in('sku', chunk)
      if (readErr) {
        console.warn('[offerLiveness] read before upsert failed (fail-open, nothing written):', readErr.message)
        return written
      }
      const existing = new Map<string, OfferLivenessRow>()
      for (const row of (existingRaw ?? []) as unknown as OfferLivenessRow[]) existing.set(row.sku, row)
      const payload = chunk.map((sku) => mergeLivenessObservation(existing.get(sku) ?? null, bySku.get(sku)!, nowIso))
      const { error: upErr } = await supabase
        .from('sku_offer_liveness')
        .upsert(payload, { onConflict: 'sku' } as never)
      if (upErr) {
        console.warn('[offerLiveness] upsert failed (fail-open):', upErr.message)
        return written
      }
      written += payload.length
    }
    return written
  } catch (e) {
    console.warn('[offerLiveness] recordOfferLiveness threw (fail-open):', e instanceof Error ? e.message : e)
    return 0
  }
}
