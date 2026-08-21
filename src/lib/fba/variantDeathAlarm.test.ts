/**
 * VARIANT-DEATH ALARM unit tests — the Later Gator XL/2XL Orchid signature:
 * a child SKU whose content_synced_at FROZE while siblings kept advancing.
 * Pure-function tests only (READ-side detector; no DB, no network).
 */
import { describe, it, expect } from 'vitest'
import {
  detectDeadVariants,
  rowHasContent,
  variantDeathAlarmEnabled,
  describeVariantDeathAlarm,
  VARIANT_DEATH_LAG_DAYS,
  type VariantSyncRow,
} from './variantDeathAlarm'

const DAY_MS = 86_400_000
const T0 = Date.parse('2026-08-01T00:00:00.000Z') // family baseline in every test

const iso = (msBefore: number) => new Date(T0 - msBefore).toISOString()

/** A real content row (has its own copy). */
const contentRow = (sku: string, asin: string, syncedAt: string | null): VariantSyncRow => ({
  sku, asin, content_synced_at: syncedAt,
  bullet_1: 'Soft garment-dyed cotton', bullet_2: '', bullet_3: '', bullet_4: '', bullet_5: '',
  description: 'A shirt people actually want.', backend_keywords: 'gator shirt',
})

/** An offerless-backfill shell row (familyReconcile shape: sibling title copied,
 *  bullets/description/backend all blank). */
const shellRow = (sku: string, asin: string, syncedAt: string): VariantSyncRow => ({
  sku, asin, content_synced_at: syncedAt,
  bullet_1: '', bullet_2: '', bullet_3: '', bullet_4: '', bullet_5: '',
  description: '', backend_keywords: '',
})

describe('detectDeadVariants — lag flag', () => {
  it('flags the frozen SKU while advancing siblings stay clean (the Later Gator signature)', () => {
    const rows = [
      contentRow('GATOR-L-FBA', 'B0AAAAAAA1', iso(0)),
      contentRow('GATOR-XL-FBA', 'B0AAAAAAA2', iso(60 * DAY_MS)),  // froze ~2 months ago
      contentRow('GATOR-2XL-FBA', 'B0AAAAAAA3', iso(1 * DAY_MS)),
    ]
    const r = detectDeadVariants(rows)
    expect(r.lagging.map((l) => l.sku)).toEqual(['GATOR-XL-FBA'])
    expect(r.lagging[0].lag_days).toBe(60)
    expect(r.lagging[0].asin).toBe('B0AAAAAAA2')
    expect(r.family_max_synced_at).toBe(iso(0))
    expect(r.rows_considered).toBe(3)
    expect(r.shellRows).toBe(0)
  })

  it('lag is sibling-relative, not now()-relative: a uniformly stale family never flags', () => {
    // Whole family last scanned 90 days ago, all within a day of each other → no alarm.
    const rows = [
      contentRow('A-FBA', 'B0AAAAAAA1', iso(90 * DAY_MS)),
      contentRow('B-FBA', 'B0AAAAAAA2', iso(90.5 * DAY_MS)),
    ]
    expect(detectDeadVariants(rows).lagging).toEqual([])
  })

  it('sorts most-stale first, never-attested rows leading', () => {
    const rows = [
      contentRow('FRESH', 'B0AAAAAAA1', iso(0)),
      contentRow('STALE-20', 'B0AAAAAAA2', iso(20 * DAY_MS)),
      contentRow('STALE-40', 'B0AAAAAAA3', iso(40 * DAY_MS)),
      contentRow('NEVER', 'B0AAAAAAA4', null),
    ]
    const r = detectDeadVariants(rows)
    expect(r.lagging.map((l) => l.sku)).toEqual(['NEVER', 'STALE-40', 'STALE-20'])
    expect(r.lagging[0].lag_days).toBeNull()
  })
})

describe('detectDeadVariants — N-day boundary (strict >)', () => {
  it('exactly N days behind is NOT flagged; a minute past N days IS', () => {
    const atBoundary = detectDeadVariants([
      contentRow('MAX', 'B0AAAAAAA1', iso(0)),
      contentRow('EDGE', 'B0AAAAAAA2', iso(VARIANT_DEATH_LAG_DAYS * DAY_MS)),
    ])
    expect(atBoundary.lagging).toEqual([])

    const pastBoundary = detectDeadVariants([
      contentRow('MAX', 'B0AAAAAAA1', iso(0)),
      contentRow('EDGE', 'B0AAAAAAA2', iso(VARIANT_DEATH_LAG_DAYS * DAY_MS + 60_000)),
    ])
    expect(pastBoundary.lagging.map((l) => l.sku)).toEqual(['EDGE'])
    expect(pastBoundary.lagging[0].lag_days).toBe(VARIANT_DEATH_LAG_DAYS)
  })

  it('honors a custom lagDays option', () => {
    const rows = [
      contentRow('MAX', 'B0AAAAAAA1', iso(0)),
      contentRow('OLD-10', 'B0AAAAAAA2', iso(10 * DAY_MS)),
    ]
    expect(detectDeadVariants(rows).lagging).toEqual([])                       // default 14 → clean
    expect(detectDeadVariants(rows, { lagDays: 7 }).lagging.map((l) => l.sku)).toEqual(['OLD-10'])
  })

  it('exports the ONE default constant (14)', () => {
    expect(VARIANT_DEATH_LAG_DAYS).toBe(14)
  })
})

describe('detectDeadVariants — shell exclusion', () => {
  it('excludes a contentless twin-less shell from the alarm and counts it as shellRows', () => {
    const rows = [
      contentRow('REAL-FBA', 'B0AAAAAAA1', iso(0)),
      shellRow('SHELL-FBA', 'B0AAAAAAA9', iso(200 * DAY_MS)), // ancient, but a shell → never alarmed
    ]
    const r = detectDeadVariants(rows)
    expect(r.lagging).toEqual([])
    expect(r.shellRows).toBe(1)
    expect(r.rows_considered).toBe(1)
  })

  it('a FRESH shell must not drag the family baseline up (row-creation time is not a scan)', () => {
    // Real siblings all scanned 30d ago; a shell was backfilled TODAY. If the shell fed
    // the baseline, every real sibling would false-alarm at 30d behind "the family".
    const rows = [
      contentRow('A-FBA', 'B0AAAAAAA1', iso(30 * DAY_MS)),
      contentRow('B-FBA', 'B0AAAAAAA2', iso(30 * DAY_MS)),
      shellRow('SHELL-FBA', 'B0AAAAAAA9', iso(0)),
    ]
    const r = detectDeadVariants(rows)
    expect(r.lagging).toEqual([])
    expect(r.family_max_synced_at).toBe(iso(30 * DAY_MS))
    expect(r.shellRows).toBe(1)
  })

  it('a contentless row WITH an FBA/FBM twin is NOT a shell — it stays in the alarm', () => {
    // FBM twin rows are routinely blank in the cache while the FBA row carries the copy;
    // sharing the ASIN is what proves it is a real live SKU, not a backfill placeholder.
    const rows = [
      contentRow('GATOR-L-FBA', 'B0AAAAAAA1', iso(0)),
      shellRow('GATOR-L', 'B0AAAAAAA1', iso(30 * DAY_MS)), // blank but twinned with -FBA above
    ]
    const r = detectDeadVariants(rows)
    expect(r.shellRows).toBe(0)
    expect(r.lagging.map((l) => l.sku)).toEqual(['GATOR-L'])
    expect(r.rows_considered).toBe(2)
  })
})

describe('detectDeadVariants — degenerate families', () => {
  it('single-child family never flags (a row cannot lag itself)', () => {
    const r = detectDeadVariants([contentRow('ONLY-FBA', 'B0AAAAAAA1', iso(500 * DAY_MS))])
    expect(r.lagging).toEqual([])
    expect(r.rows_considered).toBe(1)
  })

  it('no valid timestamps anywhere → no baseline → no flags', () => {
    const r = detectDeadVariants([
      contentRow('A-FBA', 'B0AAAAAAA1', null),
      contentRow('B-FBA', 'B0AAAAAAA2', 'not-a-date'),
    ])
    expect(r.lagging).toEqual([])
    expect(r.family_max_synced_at).toBeNull()
  })

  it('empty family → empty report', () => {
    expect(detectDeadVariants([])).toEqual({
      lagging: [], shellRows: 0, family_max_synced_at: null, rows_considered: 0,
    })
  })

  it('never-attested content row flags with lag_days null once a baseline exists', () => {
    const r = detectDeadVariants([
      contentRow('A-FBA', 'B0AAAAAAA1', iso(0)),
      contentRow('B-FBA', 'B0AAAAAAA2', null),
    ])
    expect(r.lagging).toEqual([
      { sku: 'B-FBA', asin: 'B0AAAAAAA2', content_synced_at: null, lag_days: null },
    ])
  })
})

describe('rowHasContent', () => {
  it('title alone never counts (backfill copies a sibling title into shells)', () => {
    const shell: VariantSyncRow = {
      sku: 'S', asin: 'B0AAAAAAA1', content_synced_at: null,
      bullet_1: '', bullet_2: '', bullet_3: '', bullet_4: '', bullet_5: '',
      description: '', backend_keywords: '',
    }
    expect(rowHasContent(shell)).toBe(false)
    expect(rowHasContent({ ...shell, backend_keywords: 'gator tee' })).toBe(true)
    expect(rowHasContent({ ...shell, bullet_3: 'Real bullet' })).toBe(true)
    expect(rowHasContent({ ...shell, description: '  ' })).toBe(false) // whitespace = blank
  })
})

describe('VARIANT_DEATH_ALARM flag (default ON — read-only surface)', () => {
  it('unset / unrecognized → on; explicit disable vocabulary → off', () => {
    expect(variantDeathAlarmEnabled(undefined)).toBe(true)
    expect(variantDeathAlarmEnabled('')).toBe(true)
    expect(variantDeathAlarmEnabled('on')).toBe(true)
    expect(variantDeathAlarmEnabled('banana')).toBe(true) // read-only: a typo can't dark the alarm
    for (const off of ['0', 'false', 'off', 'no', 'disabled', 'OFF', ' Off ']) {
      expect(variantDeathAlarmEnabled(off)).toBe(false)
    }
  })

  it('health echo reports the EFFECTIVE mode (raw null would read as off — the opposite of truth)', () => {
    expect(describeVariantDeathAlarm(undefined)).toBe('on (default)')
    expect(describeVariantDeathAlarm('')).toBe('on (default)')
    expect(describeVariantDeathAlarm('on')).toBe('on')
    expect(describeVariantDeathAlarm('off')).toBe('off')
  })
})
