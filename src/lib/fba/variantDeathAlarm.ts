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
 *
 * THE GATE'S OWN VERDICT (migration 059 / offerLiveness.ts) — the third evidence source, and
 * the AUTHORITATIVE one for 'offer_dead'. Both proxies above read "healthy" for the Later
 * Gator family's dead Orchid offers (B0GML5V7KZ, 6014XL-ORC-Later-Gator-LS-TS ...): a content
 * apply had advanced their content_synced_at, and listing_health still said Active — while the
 * push gate's LIVE Listings-Items check was skipping those exact SKUs as offerless on every
 * push. That verdict is now persisted (sku_offer_liveness; written ONLY by the truth sites that
 * already compute it — no new Amazon calls, no cron) and read here:
 *    offer_live = true                                  ⇒ NEVER offer_dead (a live verdict wins
 *                                                         over any listing_health evidence)
 *    offer_live = false AND offer_missing_since older
 *      than OFFER_LIVENESS_GRACE_MS                     ⇒ offer_dead (source 'gate'), even when
 *                                                         listing_health still says 'Active'
 *    offer_live = false inside the grace window         ⇒ not yet — one transient empty result
 *                                                         must not alarm; listing_health rules apply
 *    no liveness row                                    ⇒ listing_health rule exactly as before
 *
 * ROSTER (INVARIANT 2, familyRoster.ts): the rows the detector considers are the SAME family
 * enumeration the family-skus route shows — listing_content rows PLUS the FBA/FBM twins the
 * push discovered live (persisted in sku_offer_liveness under the parent), merged by the ONE
 * resolveFamilyRoster rule. Before this the detector considered 42 rows of a 113-SKU family;
 * a dead twin it never enumerated could never be flagged. A roster-only row (no listing_content
 * row) has no content attestation, so it is exempt from the sync_lag prong and the baseline and
 * can be flagged by the offer prong alone.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveFamilyRoster } from '@/lib/fba/familyRoster'
import { OFFER_LIVENESS_COLS, type OfferLivenessRow } from '@/lib/fba/offerLiveness'

export type { OfferLivenessRow } from '@/lib/fba/offerLiveness'

/** ONE lag threshold (days). The alarm fires strictly BEYOND this many days. */
export const VARIANT_DEATH_LAG_DAYS = 14

/** ONE grace window for the persisted gate verdict: a SKU must have been offerless (per the
 *  gate's offer_missing_since, which sticks from the FIRST dead sighting of the streak) for
 *  LONGER than this before the alarm fires. One transient empty Listings-Items answer is
 *  corrected by the next live sighting well inside a day; a SKU dead since June is not. */
export const OFFER_LIVENESS_GRACE_MS = 24 * 60 * 60 * 1000

const DAY_MS = 86_400_000

/** Minimal structural row — listing_content per-SKU rows (the route's ChildRow and
 *  the page's ChildContentRow both satisfy this). */
export interface VariantSyncRow {
  sku: string
  asin: string
  content_synced_at: string | null
  /** TRUE when this row comes from the persisted family roster (a twin the push discovered live)
   *  and has NO listing_content row: no content attestation exists, so the sync_lag prong, the
   *  baseline and the shell test do not apply — only the offer prong can flag it. */
  roster_only?: boolean
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
  /** Which evidence produced 'offer_dead': 'gate' = the persisted push-gate verdict (authoritative),
   *  'health' = listing_health. null when reasons lacks 'offer_dead'. */
  offer_dead_source: 'gate' | 'health' | null
  /** Persisted gate verdict echo (null when no sku_offer_liveness row was supplied for this SKU). */
  offer_live: boolean | null
  offer_missing_since: string | null
  offer_checked_at: string | null
  /** TRUE when the row is known only from the persisted roster (no listing_content row). */
  roster_only: boolean
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
  /** Non-shell rows that HAD a persisted gate verdict (sku_offer_liveness) — "gate verdicts for
   *  N of M SKUs". 0 until the family's next push / verify / reconcile writes them. */
  offer_liveness_rows: number
  /** Rows known only from the persisted roster (twins with no listing_content row). Included in
   *  rows_considered; exempt from sync_lag and the baseline. */
  roster_only_rows: number
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
  opts: {
    lagDays?: number
    offerEvidence?: OfferEvidenceRow[]
    /** Persisted gate verdicts (sku_offer_liveness rows; any superset — joined by sku). */
    offerLiveness?: OfferLivenessRow[]
    /** Grace for the persisted verdict (ms). Default OFFER_LIVENESS_GRACE_MS. */
    graceMs?: number
    /** "Now" for the grace test (ms epoch). Parameter so the rule is unit-testable. */
    now?: number
  } = {},
): VariantDeathReport {
  const lagDays = opts.lagDays ?? VARIANT_DEATH_LAG_DAYS
  const graceMs = opts.graceMs ?? OFFER_LIVENESS_GRACE_MS
  const now = opts.now ?? Date.now()
  const evidenceBySku = new Map<string, OfferEvidenceRow>()
  for (const e of opts.offerEvidence ?? []) if (e?.sku) evidenceBySku.set(e.sku, e)
  const livenessBySku = new Map<string, OfferLivenessRow>()
  for (const l of opts.offerLiveness ?? []) if (l?.sku) livenessBySku.set(l.sku, l)

  // Roster-only rows (persisted twins with no listing_content row) carry no content attestation:
  // they never enter the shell test, the baseline or the sync_lag prong. Kept apart here.
  const attested = rows.filter((r) => !r.roster_only)
  const rosterOnly = rows.filter((r) => r.roster_only)

  // FBA/FBM twin = another listing_content row (different SKU) sharing the ASIN. ASIN identity is
  // the twin definition (familyRoster.ts: the SKU suffix is a convention, not a rule). Computed
  // over ATTESTED rows only so the shell rule is unchanged by roster expansion: a fresh shell
  // must never be promoted into the baseline by a twin that is itself only a persisted sighting.
  const rowsPerAsin = new Map<string, number>()
  for (const r of attested) rowsPerAsin.set(r.asin, (rowsPerAsin.get(r.asin) ?? 0) + 1)
  const hasTwin = (r: VariantSyncRow) => (rowsPerAsin.get(r.asin) ?? 0) > 1

  const shells: VariantSyncRow[] = []
  const contentRows: VariantSyncRow[] = []
  for (const r of attested) (!rowHasContent(r) && !hasTwin(r) ? shells : contentRows).push(r)

  // Baseline: freshest VALID timestamp among non-shell ATTESTED rows only.
  let maxTs: number | null = null
  let maxIso: string | null = null
  for (const r of contentRows) {
    const t = parseTs(r.content_synced_at)
    if (t !== null && (maxTs === null || t > maxTs)) { maxTs = t; maxIso = r.content_synced_at }
  }

  const flagged: DeadVariant[] = []
  let offerEvidenceRows = 0
  let offerLivenessRows = 0
  for (const r of [...contentRows, ...rosterOnly]) {
    const reasons: DeadVariantReason[] = []
    const ev = evidenceBySku.get(r.sku) ?? null
    if (ev) offerEvidenceRows++
    const lv = livenessBySku.get(r.sku) ?? null
    if (lv) offerLivenessRows++

    // Prong 2 — offer evidence (absolute; no baseline needed; fail-open on absence).
    // PRIORITY: the persisted gate verdict is authoritative over listing_health when both exist —
    // a live verdict always wins; a dead verdict past the grace wins over a stale 'Active' row.
    const offerDeadSource = offerVerdict(lv, ev, now, graceMs)
    if (offerDeadSource) reasons.push('offer_dead')

    // Prong 1 — sibling-relative sync lag (needs a baseline; attested rows only).
    const t = parseTs(r.content_synced_at)
    let lagDaysMeasured: number | null = null
    if (!r.roster_only && maxTs !== null) {
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
      offer_dead_source: offerDeadSource,
      offer_live: lv ? lv.offer_live : null,
      offer_missing_since: lv?.offer_missing_since ?? null,
      offer_checked_at: lv?.last_checked_at ?? null,
      roster_only: r.roster_only === true,
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
    rows_considered: contentRows.length + rosterOnly.length,
    offer_evidence_rows: offerEvidenceRows,
    offer_liveness_rows: offerLivenessRows,
    roster_only_rows: rosterOnly.length,
  }
}

/**
 * THE offer-dead PRIORITY rule over the two evidence sources (pure). Returns which source says
 * dead, or null when neither does:
 *   1. A persisted LIVE verdict wins outright — listing_health is never consulted (its
 *      status_message is never cleared after recovery; the gate saw the SKU live).
 *   2. A persisted DEAD verdict whose streak (offer_missing_since, falling back to the check time
 *      if a writer ever left it null) is OLDER than the grace ⇒ 'gate' — regardless of a stale
 *      'Active' in listing_health (the Later Gator case).
 *   3. Otherwise (no verdict, or dead inside the grace) ⇒ the listing_health rule as before.
 */
export function offerVerdict(
  lv: OfferLivenessRow | null,
  ev: OfferEvidenceRow | null,
  now: number,
  graceMs: number = OFFER_LIVENESS_GRACE_MS,
): 'gate' | 'health' | null {
  if (lv) {
    if (lv.offer_live) return null
    const since = parseTs(lv.offer_missing_since) ?? parseTs(lv.last_checked_at)
    if (since !== null && now - since > graceMs) return 'gate'
  }
  if (ev && offerEvidenceSaysDead(ev)) return 'health'
  return null
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

/**
 * ONE loader for the persisted gate verdicts (sku_offer_liveness, migration 059). Two indexed
 * reads, merged by sku: (a) every row filed under the families' parent_asin — this is the
 * PERSISTED ROSTER, i.e. the FBA/FBM twins the push discovered live that have no listing_content
 * row; (b) every row for the children's own SKUs — covers a SKU whose stored parent_asin lags
 * (re-parented on Amazon, recorded before the move). READ-only; chunked; FAIL-OPEN exactly like
 * loadOfferEvidence: any error (table not yet created, RLS, network) ⇒ [] ⇒ the gate prong stays
 * silent and the roster is just listing_content — the alarm behaves as it did before 059.
 */
export async function loadOfferLiveness(
  supabase: SupabaseClient,
  keys: { parentAsins: string[]; skus: string[] },
): Promise<OfferLivenessRow[]> {
  if (!variantDeathAlarmEnabled()) return []
  const parents = [...new Set(keys.parentAsins.filter((p): p is string => typeof p === 'string' && p.length > 0))]
  const skus = [...new Set(keys.skus.filter((s): s is string => typeof s === 'string' && s.length > 0))]
  if (parents.length === 0 && skus.length === 0) return []
  const CHUNK = 200
  const bySku = new Map<string, OfferLivenessRow>()
  try {
    for (let i = 0; i < parents.length; i += CHUNK) {
      const { data, error } = await supabase
        .from('sku_offer_liveness')
        .select(OFFER_LIVENESS_COLS)
        .in('parent_asin', parents.slice(i, i + CHUNK))
      if (error) {
        console.warn('[variantDeathAlarm] offer liveness load failed (fail-open):', error.message)
        return []
      }
      for (const row of (data ?? []) as unknown as OfferLivenessRow[]) bySku.set(row.sku, row)
    }
    for (let i = 0; i < skus.length; i += CHUNK) {
      const { data, error } = await supabase
        .from('sku_offer_liveness')
        .select(OFFER_LIVENESS_COLS)
        .in('sku', skus.slice(i, i + CHUNK))
      if (error) {
        console.warn('[variantDeathAlarm] offer liveness load failed (fail-open):', error.message)
        return []
      }
      for (const row of (data ?? []) as unknown as OfferLivenessRow[]) bySku.set(row.sku, row)
    }
  } catch (e) {
    console.warn('[variantDeathAlarm] offer liveness load threw (fail-open):', e instanceof Error ? e.message : e)
    return []
  }
  return [...bySku.values()]
}

/** Both evidence sources the detector joins. Loaded ONCE per assembly path by loadDeathEvidence. */
export interface DeathEvidence {
  offerEvidence: OfferEvidenceRow[]
  offerLiveness: OfferLivenessRow[]
}

/** ONE evidence loader for the attach seam: listing_health rows + persisted gate verdicts for a
 *  set of families. `children` = the listing_content rows already in hand; `parentAsins` = the
 *  family ids being assembled (the roster read is keyed by these). Fail-open on both halves. */
export async function loadDeathEvidence(
  supabase: SupabaseClient,
  children: { sku: string }[],
  parentAsins: string[],
): Promise<DeathEvidence> {
  const skus = children.map((c) => c.sku)
  const [offerEvidence, offerLiveness] = await Promise.all([
    loadOfferEvidence(supabase, skus),
    loadOfferLiveness(supabase, { parentAsins, skus }),
  ])
  return { offerEvidence, offerLiveness }
}

/**
 * THE family roster for the detector (INVARIANT 2 — one resolver, familyRoster.ts). Same rule
 * the family-skus route runs over LIVE discovery, run here over the PERSISTED discovery: the
 * sku_offer_liveness rows filed under this parent are the twins the push gate already found.
 * Cached rows keep their full listing_content shape; a discovered-only SKU becomes a
 * `roster_only` row (no attestation ⇒ offer prong only). Pure; exported for tests.
 */
export function expandFamilyRoster<R extends VariantSyncRow>(
  parentAsin: string | null | undefined,
  children: R[],
  offerLiveness: OfferLivenessRow[],
): VariantSyncRow[] {
  const discovered = parentAsin
    ? offerLiveness
        .filter((l) => l.parent_asin === parentAsin && l.asin)
        .map((l) => ({ sku: l.sku, asin: l.asin as string }))
    : []
  const bySku = new Map(children.map((c) => [c.sku, c]))
  return resolveFamilyRoster(children, discovered).map((e) =>
    e.origin === 'cached'
      ? (bySku.get(e.sku) as VariantSyncRow)
      : { sku: e.sku, asin: e.asin, content_synced_at: null, roster_only: true },
  )
}

/** ONE attach seam for API rows carrying a family's children — the assembleSurvivors
 *  batch path, the on-demand single-ASIN path AND the ?ensure= unshift path all call THIS
 *  (the dual-write-path doctrine: an invariant on one path only is not done). The caller
 *  loads the evidence ONCE (loadDeathEvidence over the children's SKUs + family ids) and passes
 *  it in so the detector stays pure; omitted evidence ⇒ the offer prong is silent and the
 *  roster is listing_content alone (fail-open). */
export function attachVariantDeath<T extends { children: VariantSyncRow[]; parent_asin?: string | null }>(
  row: T,
  evidence: Partial<DeathEvidence> = {},
): T & { variant_death: VariantDeathReport | null } {
  const out = row as T & { variant_death: VariantDeathReport | null }
  const offerEvidence = evidence.offerEvidence ?? []
  const offerLiveness = evidence.offerLiveness ?? []
  out.variant_death = variantDeathAlarmEnabled()
    ? detectDeadVariants(expandFamilyRoster(row.parent_asin, row.children, offerLiveness), { offerEvidence, offerLiveness })
    : null
  return out
}
