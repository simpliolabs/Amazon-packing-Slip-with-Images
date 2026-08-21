/**
 * VARIANT-DEATH ALARM — per-family dead-variant detector (PO backlog, 2026-08-20).
 * ─────────────────────────────────────────────────────────────────────────────
 * Motivating incident: the Later Gator family's XL/2XL Orchid offers died ~June 17
 * and stayed unbuyable for TWO MONTHS unnoticed. The tell was already in our own
 * data the whole time: the dead SKUs' listing_content.content_synced_at FROZE while
 * every sibling SKU kept advancing on each scan (a later push gate confirmed zero
 * live offers). This module turns that tell into an alarm.
 *
 * Doctrine (fba-optimizer-coherence "ONE shared seam"):
 *  - detectDeadVariants() is the ONE derivation. Every surface (the listing-optimizer
 *    GET attaches it server-side; the [asin] page renders what the API returns)
 *    consumes THIS function — no per-page inlining, no second rulebook.
 *  - READ-side only: pure over rows already loaded. No cron, no Amazon calls,
 *    no Jungle Scout, no writes.
 *
 * TWO PRONGS (each flagged SKU carries `reasons` so the card can say WHY):
 *
 *  'sync_lag' — content_synced_at trails the family max(content_synced_at) by MORE
 *    THAN `VARIANT_DEATH_LAG_DAYS` days (strict — exactly N days is NOT flagged). The
 *    comparison is sibling-relative, never now()-relative: a family nobody has scanned
 *    in a month is uniformly stale, not dead; ONE frozen SKU among advancing siblings
 *    is the death signature. A content row whose timestamp is missing/unparseable has
 *    never been attested: it is flagged (lag_days: null) whenever the family has a real
 *    baseline. No baseline (zero valid non-shell timestamps) or a single-child family
 *    ⇒ no sync_lag flags: a row can never lag itself.
 *
 *  'offer_dead' — the STORED offer evidence says this SKU has no live offer. Evidence
 *    source = listing_health (GET_MERCHANT_LISTINGS_ALL_DATA → status/price, plus the
 *    INACTIVE report's status_message, syncInactiveListings). Why THIS table and not a
 *    new one: it is the predicate the content scanner ALREADY trusts as "live child" —
 *    syncListingContent enumerates scannable SKUs from listing_health WHERE
 *    status='Active' — which is exactly WHY a dead offer's content_synced_at freezes.
 *    The sync_lag prong is downstream of this evidence; reading it directly closes the
 *    gap the Later Gator acceptance exposed (a content apply advanced the dead rows'
 *    content_synced_at, so sync_lag went quiet while the offers stayed dead).
 *    FAIL-OPEN, POSITIVE EVIDENCE ONLY: a SKU with NO listing_health row is never
 *    flagged offer_dead — the table is incomplete for low-traffic/POD listings (the
 *    #260→#264 lesson: keying a SKIP on its absence blanket-skipped 121 live listings).
 *    See offerEvidenceSaysDead() for the exact rule. offer_dead needs no baseline: a
 *    single-child family CAN be offer_dead.
 *
 *  - OFFERLESS-BACKFILL SHELLS are excluded from BOTH prongs AND from the family-max
 *    baseline, but counted as `shellRows`. A shell is a familyReconcile placeholder:
 *    NO content of its own (blank bullets/description/backend) AND no FBA/FBM twin
 *    row sharing its ASIN. Its content_synced_at is a row-CREATION time, not a scan
 *    attestation — letting a fresh shell into the baseline would false-alarm every
 *    real sibling; letting it into the flag set would alarm on rows that were never
 *    buyable content rows to begin with.
 */
import type { SupabaseClient } from '@supabase/supabase-js'

/** ONE lag threshold (days). The alarm fires strictly BEYOND this many days. */
export const VARIANT_DEATH_LAG_DAYS = 14

const DAY_MS = 86_400_000

/** Minimal structural row — listing_content per-SKU rows (the route's ChildRow and
 *  the page's ChildContentRow both satisfy this). */
export interface VariantSyncRow {
  sku: string
  asin: string
  content_synced_at: string | null
  bullet_1?: string | null
  bullet_2?: string | null
  bullet_3?: string | null
  bullet_4?: string | null
  bullet_5?: string | null
  description?: string | null
  backend_keywords?: string | null
}

/** Stored offer evidence — ONE listing_health row per SKU (sku is UNIQUE there).
 *  Columns = OFFER_EVIDENCE_COLS; loadOfferEvidence() is the ONE loader. */
export interface OfferEvidenceRow {
  sku: string
  /** listing_health.status from the All-Listings report: 'Active' | 'Inactive' | 'Incomplete' | ... */
  status: string | null
  /** listing_health.status_message from the INACTIVE report ('Missing offer', 'Out of stock',
   *  'Detail page removed', ...). NOT cleared when a SKU goes Active again — so it is only
   *  consulted when status is not Active. */
  status_message: string | null
  /** Offer price; the report sync stores no-price as null (parseFloat || null). */
  price: number | null
  /** When this evidence row was last refreshed by a report sync. */
  last_synced_at: string | null
}

export const OFFER_EVIDENCE_COLS = 'sku, status, status_message, price, last_synced_at'

export type DeadVariantReason = 'sync_lag' | 'offer_dead'

export interface DeadVariant {
  sku: string
  asin: string
  /** WHY this SKU is flagged — at least one reason, 'offer_dead' listed first when present. */
  reasons: DeadVariantReason[]
  /** The row's stored timestamp (echoed raw; null when absent). */
  content_synced_at: string | null
  /** Whole days behind the family max. null = no parseable timestamp (never attested) or
   *  no family baseline. Meaningful as a lag verdict only when reasons includes 'sync_lag'. */
  lag_days: number | null
  /** Offer evidence echo (null when no listing_health row was supplied for this SKU). */
  offer_status: string | null
  offer_status_message: string | null
  offer_evidence_at: string | null
}

export interface VariantDeathReport {
  /** Flagged SKUs — offer_dead evidence leads, then most-stale first (never-attested rows lead). */
  flagged: DeadVariant[]
  /** Offerless-backfill placeholder rows excluded from the alarm (see module doc). */
  shellRows: number
  /** Freshest non-shell content_synced_at — the baseline the lag is measured against. */
  family_max_synced_at: string | null
  /** Non-shell rows evaluated against the baseline. */
  rows_considered: number
  /** Non-shell rows that HAD a listing_health evidence row (fail-open transparency: the card
   *  can say "evidence for N of M SKUs"). */
  offer_evidence_rows: number
}

const blank = (v: string | null | undefined): boolean => !v || v.trim() === ''

/** True when the row carries real listing copy of its OWN. Title is deliberately NOT
 *  consulted: familyReconcile's backfill copies a sibling's title into the shell
 *  (placeholderTitle), so title can never distinguish a shell from a content row. */
export function rowHasContent(row: VariantSyncRow): boolean {
  return !(
    blank(row.bullet_1) && blank(row.bullet_2) && blank(row.bullet_3) &&
    blank(row.bullet_4) && blank(row.bullet_5) &&
    blank(row.description) && blank(row.backend_keywords)
  )
}

const parseTs = (iso: string | null | undefined): number | null => {
  if (!iso) return null
  const t = Date.parse(iso)
  return Number.isNaN(t) ? null : t
}

/**
 * THE offer-dead rule over ONE stored listing_health row (pure). Mirrors the
 * listing-issues route's "Missing Offer" vocabulary (its Issue 2 Case A/B + Issue 3),
 * scoped to the ZERO-OFFERS case only:
 *  - status 'Active' → never dead (a stale status_message from a past outage must not
 *    alarm a recovered SKU — syncListings never clears status_message).
 *  - status_message says "missing offer" / "no offer" → dead (the INACTIVE report's own reason).
 *  - status itself is 'Missing Offer' / 'No Offer' → dead.
 *  - status 'Inactive' with NO status_message and NO price → dead (listing-issues Case B:
 *    a stockout keeps its price; an offerless SKU has none).
 *  - anything else ('Out of stock', 'Detail page removed', 'Blocked', 'Incomplete', ...) → NOT
 *    this prong's business (replenishment / suppression / missing-info surfaces own those).
 */
export function offerEvidenceSaysDead(e: OfferEvidenceRow): boolean {
  const status = (e.status ?? '').trim().toLowerCase()
  const msg = (e.status_message ?? '').trim().toLowerCase()
  if (status === 'active') return false
  if (/missing offer|no offer/.test(msg)) return true
  if (/^(missing ?offer|no ?offer)$/.test(status)) return true
  const hasPrice = typeof e.price === 'number' && e.price > 0
  if (status === 'inactive' && msg === '' && !hasPrice) return true
  return false
}

/**
 * THE derivation (pure; JSON-safe output). `rows` = one parent family's
 * listing_content rows (FBA + FBM SKU rows included — twins are how shells are
 * told apart from real contentless rows). `opts.offerEvidence` = listing_health rows
 * (any superset of this family's SKUs is fine — joined by sku here); omit/empty ⇒ the
 * offer_dead prong is silent (fail-open).
 */
export function detectDeadVariants(
  rows: VariantSyncRow[],
  opts: { lagDays?: number; offerEvidence?: OfferEvidenceRow[] } = {},
): VariantDeathReport {
  const lagDays = opts.lagDays ?? VARIANT_DEATH_LAG_DAYS
  const evidenceBySku = new Map<string, OfferEvidenceRow>()
  for (const e of opts.offerEvidence ?? []) if (e?.sku) evidenceBySku.set(e.sku, e)

  // FBA/FBM twin = another row (different SKU) sharing the ASIN. ASIN identity is the
  // twin definition (family-skus/route.ts: the SKU suffix is a convention, not a rule).
  const rowsPerAsin = new Map<string, number>()
  for (const r of rows) rowsPerAsin.set(r.asin, (rowsPerAsin.get(r.asin) ?? 0) + 1)
  const hasTwin = (r: VariantSyncRow) => (rowsPerAsin.get(r.asin) ?? 0) > 1

  const shells: VariantSyncRow[] = []
  const contentRows: VariantSyncRow[] = []
  for (const r of rows) (!rowHasContent(r) && !hasTwin(r) ? shells : contentRows).push(r)

  // Baseline: freshest VALID timestamp among non-shell rows only.
  let maxTs: number | null = null
  let maxIso: string | null = null
  for (const r of contentRows) {
    const t = parseTs(r.content_synced_at)
    if (t !== null && (maxTs === null || t > maxTs)) { maxTs = t; maxIso = r.content_synced_at }
  }

  const flagged: DeadVariant[] = []
  let offerEvidenceRows = 0
  for (const r of contentRows) {
    const reasons: DeadVariantReason[] = []
    const ev = evidenceBySku.get(r.sku) ?? null
    if (ev) offerEvidenceRows++

    // Prong 2 — stored offer evidence (absolute; no baseline needed; fail-open on absence).
    if (ev && offerEvidenceSaysDead(ev)) reasons.push('offer_dead')

    // Prong 1 — sibling-relative sync lag (needs a baseline).
    const t = parseTs(r.content_synced_at)
    let lagDaysMeasured: number | null = null
    if (maxTs !== null) {
      if (t === null) {
        reasons.push('sync_lag') // never attested — worse than any measured lag
      } else {
        const lagMs = maxTs - t
        lagDaysMeasured = Math.floor(lagMs / DAY_MS)
        if (lagMs > lagDays * DAY_MS) reasons.push('sync_lag')
      }
    }

    if (reasons.length === 0) continue
    flagged.push({
      sku: r.sku,
      asin: r.asin,
      reasons,
      content_synced_at: r.content_synced_at ?? null,
      lag_days: lagDaysMeasured,
      offer_status: ev?.status ?? null,
      offer_status_message: ev?.status_message ?? null,
      offer_evidence_at: ev?.last_synced_at ?? null,
    })
  }

  // Positive evidence first, then most-stale: never-attested lead, then largest lag.
  flagged.sort((a, b) => {
    const ao = a.reasons.includes('offer_dead'), bo = b.reasons.includes('offer_dead')
    if (ao !== bo) return ao ? -1 : 1
    const al = a.reasons.includes('sync_lag'), bl = b.reasons.includes('sync_lag')
    if (al !== bl) return al ? -1 : 1
    if ((a.lag_days === null) !== (b.lag_days === null)) return a.lag_days === null ? -1 : 1
    return (b.lag_days ?? 0) - (a.lag_days ?? 0) || a.sku.localeCompare(b.sku)
  })

  return {
    flagged,
    shellRows: shells.length,
    family_max_synced_at: maxIso,
    rows_considered: contentRows.length,
    offer_evidence_rows: offerEvidenceRows,
  }
}

/** VARIANT_DEATH_ALARM flag (house vocabulary; READ-ONLY surface so DEFAULT ON):
 *  explicit disable ('0'|'false'|'off'|'no'|'disabled', case-insensitive) → off;
 *  anything else including UNSET → on. Raw value is a parameter so the rule is
 *  unit-testable without mutating process.env. */
export function variantDeathAlarmEnabled(
  raw: string | undefined = process.env.VARIANT_DEATH_ALARM,
): boolean {
  return !/^(0|false|off|no|disabled)$/.test((raw ?? '').trim().toLowerCase())
}

/** /api/health echo: the EFFECTIVE mode. Default is ON, so a raw null would read as
 *  "unset → off" to the flag census — the opposite of the truth (the
 *  CONTENT_RECONCILE_ENABLED / TITLE_SHAPE_JUDGE precedent). */
export function describeVariantDeathAlarm(
  raw: string | undefined = process.env.VARIANT_DEATH_ALARM,
): string {
  const unset = raw == null || raw.trim() === ''
  const mode = variantDeathAlarmEnabled(raw) ? 'on' : 'off'
  return unset ? `${mode} (default)` : mode
}

/**
 * ONE loader for the offer evidence (listing_health rows by SKU). READ-only; chunked so
 * a whole work-queue batch's children fit one PostgREST `in` filter per chunk. FAIL-OPEN:
 * any error (missing column, RLS, network) ⇒ [] ⇒ the offer_dead prong stays silent —
 * the alarm must never false-alarm on broken evidence, and never break the page.
 * Skipped entirely when the flag is off (no query for a dark alarm).
 */
export async function loadOfferEvidence(
  supabase: SupabaseClient,
  skus: string[],
): Promise<OfferEvidenceRow[]> {
  if (!variantDeathAlarmEnabled()) return []
  const unique = [...new Set(skus.filter((s): s is string => typeof s === 'string' && s.length > 0))]
  if (unique.length === 0) return []
  const CHUNK = 200
  const out: OfferEvidenceRow[] = []
  try {
    for (let i = 0; i < unique.length; i += CHUNK) {
      const { data, error } = await supabase
        .from('listing_health')
        .select(OFFER_EVIDENCE_COLS)
        .in('sku', unique.slice(i, i + CHUNK))
      if (error) {
        console.warn('[variantDeathAlarm] offer evidence load failed (fail-open):', error.message)
        return []
      }
      for (const row of (data ?? []) as unknown as OfferEvidenceRow[]) out.push(row)
    }
  } catch (e) {
    console.warn('[variantDeathAlarm] offer evidence load threw (fail-open):', e instanceof Error ? e.message : e)
    return []
  }
  return out
}

/** ONE attach seam for API rows carrying a family's children — the assembleSurvivors
 *  batch path, the on-demand single-ASIN path AND the ?ensure= unshift path all call THIS
 *  (the dual-write-path doctrine: an invariant on one path only is not done). The caller
 *  JOINS the offer evidence (loadOfferEvidence over the children's SKUs) and passes it in
 *  so the detector stays pure; omitted evidence ⇒ offer_dead silent (fail-open). */
export function attachVariantDeath<T extends { children: VariantSyncRow[] }>(
  row: T,
  offerEvidence: OfferEvidenceRow[] = [],
): T & { variant_death: VariantDeathReport | null } {
  const out = row as T & { variant_death: VariantDeathReport | null }
  out.variant_death = variantDeathAlarmEnabled()
    ? detectDeadVariants(row.children, { offerEvidence })
    : null
  return out
}
