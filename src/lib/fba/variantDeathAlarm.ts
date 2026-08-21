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
 * Semantics:
 *  - A child SKU is LAGGING when its content_synced_at trails the family
 *    max(content_synced_at) by MORE THAN `VARIANT_DEATH_LAG_DAYS` days (strict —
 *    exactly N days is NOT flagged). The comparison is sibling-relative, never
 *    now()-relative: a family nobody has scanned in a month is uniformly stale,
 *    not dead; ONE frozen SKU among advancing siblings is the death signature.
 *  - OFFERLESS-BACKFILL SHELLS are excluded from the alarm AND from the family-max
 *    baseline, but counted as `shellRows`. A shell is a familyReconcile placeholder:
 *    NO content of its own (blank bullets/description/backend) AND no FBA/FBM twin
 *    row sharing its ASIN. Its content_synced_at is a row-CREATION time, not a scan
 *    attestation — letting a fresh shell into the baseline would false-alarm every
 *    real sibling; letting it into the flag set would alarm on rows that were never
 *    buyable content rows to begin with.
 *  - A content row whose timestamp is missing/unparseable has never been attested:
 *    it is flagged (lag_days: null) whenever the family has a real baseline.
 *  - No baseline (zero valid non-shell timestamps) or a single-child family ⇒ no
 *    flags: a row can never lag itself.
 */

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

export interface LaggingVariant {
  sku: string
  asin: string
  /** The row's stored timestamp (echoed raw; null when absent). */
  content_synced_at: string | null
  /** Whole days behind the family max; null = never attested (no parseable timestamp). */
  lag_days: number | null
}

export interface VariantDeathReport {
  /** Flagged SKUs, most-stale first (never-attested rows lead). */
  lagging: LaggingVariant[]
  /** Offerless-backfill placeholder rows excluded from the alarm (see module doc). */
  shellRows: number
  /** Freshest non-shell content_synced_at — the baseline the lag is measured against. */
  family_max_synced_at: string | null
  /** Non-shell rows evaluated against the baseline. */
  rows_considered: number
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
 * THE derivation (pure; JSON-safe output). `rows` = one parent family's
 * listing_content rows (FBA + FBM SKU rows included — twins are how shells are
 * told apart from real contentless rows).
 */
export function detectDeadVariants(
  rows: VariantSyncRow[],
  opts: { lagDays?: number } = {},
): VariantDeathReport {
  const lagDays = opts.lagDays ?? VARIANT_DEATH_LAG_DAYS

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

  const lagging: LaggingVariant[] = []
  if (maxTs !== null) {
    for (const r of contentRows) {
      const t = parseTs(r.content_synced_at)
      if (t === null) {
        // Never attested — worse than any measured lag.
        lagging.push({ sku: r.sku, asin: r.asin, content_synced_at: r.content_synced_at ?? null, lag_days: null })
        continue
      }
      const lagMs = maxTs - t
      if (lagMs > lagDays * DAY_MS) {
        lagging.push({ sku: r.sku, asin: r.asin, content_synced_at: r.content_synced_at, lag_days: Math.floor(lagMs / DAY_MS) })
      }
    }
  }

  // Most-stale first: never-attested lead, then largest lag.
  lagging.sort((a, b) => {
    if ((a.lag_days === null) !== (b.lag_days === null)) return a.lag_days === null ? -1 : 1
    return (b.lag_days ?? 0) - (a.lag_days ?? 0) || a.sku.localeCompare(b.sku)
  })

  return {
    lagging,
    shellRows: shells.length,
    family_max_synced_at: maxIso,
    rows_considered: contentRows.length,
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

/** ONE attach seam for API rows carrying a family's children — both the
 *  assembleSurvivors batch path AND the ?ensure= unshift path call THIS (the
 *  dual-write-path doctrine: an invariant on one path only is not done). */
export function attachVariantDeath<T extends { children: VariantSyncRow[] }>(
  row: T,
): T & { variant_death: VariantDeathReport | null } {
  const out = row as T & { variant_death: VariantDeathReport | null }
  out.variant_death = variantDeathAlarmEnabled() ? detectDeadVariants(row.children) : null
  return out
}
