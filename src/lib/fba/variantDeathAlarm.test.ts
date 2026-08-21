/**
 * VARIANT-DEATH ALARM unit tests — the Later Gator XL/2XL Orchid signature:
 * a child SKU whose content_synced_at FROZE while siblings kept advancing (sync_lag),
 * and the stored-offer-evidence prong (offer_dead) that closes the gap a content apply
 * opened (the apply advanced the dead rows' timestamps; the offers stayed dead).
 * Pure-function tests only (READ-side detector; no DB, no network).
 */
import { describe, it, expect } from 'vitest'
import {
  detectDeadVariants,
  offerEvidenceSaysDead,
  rowHasContent,
  variantDeathAlarmEnabled,
  describeVariantDeathAlarm,
  VARIANT_DEATH_LAG_DAYS,
  OFFER_EVIDENCE_COLS,
  type VariantSyncRow,
  type OfferEvidenceRow,
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

/** listing_health evidence rows. */
const activeEv = (sku: string, price = 24.99): OfferEvidenceRow =>
  ({ sku, status: 'Active', status_message: null, price, last_synced_at: iso(0) })
const missingOfferEv = (sku: string): OfferEvidenceRow =>
  ({ sku, status: 'Inactive', status_message: 'Missing offer', price: null, last_synced_at: iso(0) })

describe('detectDeadVariants — sync_lag prong', () => {
  it('flags the frozen SKU while advancing siblings stay clean (the Later Gator signature)', () => {
    const rows = [
      contentRow('GATOR-L-FBA', 'B0AAAAAAA1', iso(0)),
      contentRow('GATOR-XL-FBA', 'B0AAAAAAA2', iso(60 * DAY_MS)),  // froze ~2 months ago
      contentRow('GATOR-2XL-FBA', 'B0AAAAAAA3', iso(1 * DAY_MS)),
    ]
    const r = detectDeadVariants(rows)
    expect(r.flagged.map((f) => f.sku)).toEqual(['GATOR-XL-FBA'])
    expect(r.flagged[0].reasons).toEqual(['sync_lag'])
    expect(r.flagged[0].lag_days).toBe(60)
    expect(r.flagged[0].asin).toBe('B0AAAAAAA2')
    expect(r.flagged[0].offer_status).toBeNull()
    expect(r.family_max_synced_at).toBe(iso(0))
    expect(r.rows_considered).toBe(3)
    expect(r.shellRows).toBe(0)
    expect(r.offer_evidence_rows).toBe(0)
  })

  it('lag is sibling-relative, not now()-relative: a uniformly stale family never flags', () => {
    // Whole family last scanned 90 days ago, all within a day of each other → no alarm.
    const rows = [
      contentRow('A-FBA', 'B0AAAAAAA1', iso(90 * DAY_MS)),
      contentRow('B-FBA', 'B0AAAAAAA2', iso(90.5 * DAY_MS)),
    ]
    expect(detectDeadVariants(rows).flagged).toEqual([])
  })

  it('sorts most-stale first, never-attested rows leading', () => {
    const rows = [
      contentRow('FRESH', 'B0AAAAAAA1', iso(0)),
      contentRow('STALE-20', 'B0AAAAAAA2', iso(20 * DAY_MS)),
      contentRow('STALE-40', 'B0AAAAAAA3', iso(40 * DAY_MS)),
      contentRow('NEVER', 'B0AAAAAAA4', null),
    ]
    const r = detectDeadVariants(rows)
    expect(r.flagged.map((f) => f.sku)).toEqual(['NEVER', 'STALE-40', 'STALE-20'])
    expect(r.flagged[0].lag_days).toBeNull()
  })
})

describe('detectDeadVariants — offer_dead prong (stored listing_health evidence)', () => {
  it('flags offer_dead ALONE when the evidence says no live offer but the sync timestamp is fresh (the gator post-apply gap)', () => {
    // A content apply advanced every row's content_synced_at → sync_lag is silent. The stored
    // offer evidence still says the ORC rows are offerless → they MUST still be flagged.
    const rows = [
      contentRow('GATOR-L-FBA', 'B0AAAAAAA1', iso(0)),
      contentRow('GATOR-XL-ORC-FBA', 'B0AAAAAAA2', iso(0)),
      contentRow('GATOR-2XL-ORC-FBA', 'B0AAAAAAA3', iso(0)),
    ]
    const offerEvidence = [activeEv('GATOR-L-FBA'), missingOfferEv('GATOR-XL-ORC-FBA'), missingOfferEv('GATOR-2XL-ORC-FBA')]
    const r = detectDeadVariants(rows, { offerEvidence })
    expect(r.flagged.map((f) => f.sku)).toEqual(['GATOR-2XL-ORC-FBA', 'GATOR-XL-ORC-FBA'])
    for (const f of r.flagged) {
      expect(f.reasons).toEqual(['offer_dead'])
      expect(f.lag_days).toBe(0) // measured, not a lag verdict
      expect(f.offer_status).toBe('Inactive')
      expect(f.offer_status_message).toBe('Missing offer')
      expect(f.offer_evidence_at).toBe(iso(0))
    }
    expect(r.offer_evidence_rows).toBe(3)
  })

  it('carries BOTH reasons when the offer is dead AND the sync froze; offer_dead is listed first', () => {
    const rows = [
      contentRow('GATOR-L-FBA', 'B0AAAAAAA1', iso(0)),
      contentRow('GATOR-XL-ORC-FBA', 'B0AAAAAAA2', iso(60 * DAY_MS)),
    ]
    const r = detectDeadVariants(rows, { offerEvidence: [activeEv('GATOR-L-FBA'), missingOfferEv('GATOR-XL-ORC-FBA')] })
    expect(r.flagged).toHaveLength(1)
    expect(r.flagged[0].sku).toBe('GATOR-XL-ORC-FBA')
    expect(r.flagged[0].reasons).toEqual(['offer_dead', 'sync_lag'])
    expect(r.flagged[0].lag_days).toBe(60)
  })

  it('FAIL-OPEN: a SKU with NO evidence row is never offer_dead (listing_health is incomplete for low-traffic/POD — the #260→#264 lesson)', () => {
    const rows = [
      contentRow('A-FBA', 'B0AAAAAAA1', iso(0)),
      contentRow('B-FBA', 'B0AAAAAAA2', iso(0)),
    ]
    // Evidence for an UNRELATED sku only; nothing for A/B.
    const r = detectDeadVariants(rows, { offerEvidence: [missingOfferEv('SOMEONE-ELSE')] })
    expect(r.flagged).toEqual([])
    expect(r.offer_evidence_rows).toBe(0)
    // Omitted / empty evidence behaves identically.
    expect(detectDeadVariants(rows).flagged).toEqual([])
    expect(detectDeadVariants(rows, { offerEvidence: [] }).flagged).toEqual([])
  })

  it('fail-open does NOT mute sync_lag: missing evidence + frozen sync still flags sync_lag alone', () => {
    const rows = [
      contentRow('A-FBA', 'B0AAAAAAA1', iso(0)),
      contentRow('B-FBA', 'B0AAAAAAA2', iso(30 * DAY_MS)),
    ]
    const r = detectDeadVariants(rows, { offerEvidence: [activeEv('A-FBA')] }) // no row for B
    expect(r.flagged.map((f) => [f.sku, f.reasons])).toEqual([['B-FBA', ['sync_lag']]])
    expect(r.flagged[0].offer_status).toBeNull()
  })

  it('Active evidence never flags offer_dead, even with a stale "Missing offer" message left over from a past outage', () => {
    // syncListings upserts status back to Active but never clears status_message.
    const rows = [contentRow('A-FBA', 'B0AAAAAAA1', iso(0)), contentRow('B-FBA', 'B0AAAAAAA2', iso(0))]
    const recovered: OfferEvidenceRow = { sku: 'B-FBA', status: 'Active', status_message: 'Missing offer', price: 19.99, last_synced_at: iso(0) }
    expect(detectDeadVariants(rows, { offerEvidence: [activeEv('A-FBA'), recovered] }).flagged).toEqual([])
  })

  it('offer_dead needs NO baseline: a single-child family can be offer_dead (sync_lag never could)', () => {
    const r = detectDeadVariants([contentRow('ONLY-FBA', 'B0AAAAAAA1', iso(0))], { offerEvidence: [missingOfferEv('ONLY-FBA')] })
    expect(r.flagged.map((f) => [f.sku, f.reasons])).toEqual([['ONLY-FBA', ['offer_dead']]])
    // ...and with no valid timestamps at all (no baseline) offer_dead still fires, lag_days null.
    const r2 = detectDeadVariants([contentRow('A-FBA', 'B0AAAAAAA1', null), contentRow('B-FBA', 'B0AAAAAAA2', null)], { offerEvidence: [missingOfferEv('B-FBA')] })
    expect(r2.flagged.map((f) => [f.sku, f.reasons, f.lag_days])).toEqual([['B-FBA', ['offer_dead'], null]])
    expect(r2.family_max_synced_at).toBeNull()
  })

  it('shells stay excluded from the offer_dead prong too (a placeholder was never a buyable content row)', () => {
    const rows = [
      contentRow('REAL-FBA', 'B0AAAAAAA1', iso(0)),
      shellRow('SHELL-FBA', 'B0AAAAAAA9', iso(0)),
    ]
    const r = detectDeadVariants(rows, { offerEvidence: [activeEv('REAL-FBA'), missingOfferEv('SHELL-FBA')] })
    expect(r.flagged).toEqual([])
    expect(r.shellRows).toBe(1)
    expect(r.offer_evidence_rows).toBe(1) // only the non-shell row is counted
  })

  it('a blank FBM twin (NOT a shell) IS eligible for offer_dead', () => {
    const rows = [
      contentRow('GATOR-L-FBA', 'B0AAAAAAA1', iso(0)),
      shellRow('GATOR-L', 'B0AAAAAAA1', iso(0)), // blank but twinned → real SKU
    ]
    const r = detectDeadVariants(rows, { offerEvidence: [activeEv('GATOR-L-FBA'), missingOfferEv('GATOR-L')] })
    expect(r.flagged.map((f) => [f.sku, f.reasons])).toEqual([['GATOR-L', ['offer_dead']]])
  })

  it('sorts offer_dead evidence ahead of sync_lag-only rows', () => {
    const rows = [
      contentRow('FRESH', 'B0AAAAAAA1', iso(0)),
      contentRow('LAG-ONLY-40', 'B0AAAAAAA2', iso(40 * DAY_MS)),
      contentRow('OFFER-ONLY', 'B0AAAAAAA3', iso(0)),
      contentRow('BOTH-20', 'B0AAAAAAA4', iso(20 * DAY_MS)),
    ]
    const r = detectDeadVariants(rows, { offerEvidence: [missingOfferEv('OFFER-ONLY'), missingOfferEv('BOTH-20')] })
    expect(r.flagged.map((f) => f.sku)).toEqual(['BOTH-20', 'OFFER-ONLY', 'LAG-ONLY-40'])
  })

  it('evidence rows with a blank sku are ignored (defensive)', () => {
    const rows = [contentRow('A-FBA', 'B0AAAAAAA1', iso(0)), contentRow('B-FBA', 'B0AAAAAAA2', iso(0))]
    const junk = [{ sku: '', status: 'Inactive', status_message: 'Missing offer', price: null, last_synced_at: null }] as OfferEvidenceRow[]
    expect(detectDeadVariants(rows, { offerEvidence: junk }).flagged).toEqual([])
  })
})

describe('offerEvidenceSaysDead — THE stored-evidence rule', () => {
  const ev = (status: string | null, status_message: string | null, price: number | null): OfferEvidenceRow =>
    ({ sku: 'X', status, status_message, price, last_synced_at: null })

  it('Active → never dead (regardless of message or price)', () => {
    expect(offerEvidenceSaysDead(ev('Active', null, 24.99))).toBe(false)
    expect(offerEvidenceSaysDead(ev('Active', 'Missing offer', null))).toBe(false) // stale message
    expect(offerEvidenceSaysDead(ev('active', null, null))).toBe(false)
  })

  it('INACTIVE report reason "Missing offer" / "no offer" → dead', () => {
    expect(offerEvidenceSaysDead(ev('Inactive', 'Missing offer', null))).toBe(true)
    expect(offerEvidenceSaysDead(ev('Inactive', 'Inactive (Missing offer)', 24.99))).toBe(true)
    expect(offerEvidenceSaysDead(ev('Inactive', 'No offer', null))).toBe(true)
  })

  it('status itself "Missing Offer" / "No Offer" (listing-issues Issue 3 vocabulary) → dead', () => {
    expect(offerEvidenceSaysDead(ev('Missing Offer', null, null))).toBe(true)
    expect(offerEvidenceSaysDead(ev('MissingOffer', null, null))).toBe(true)
    expect(offerEvidenceSaysDead(ev('No Offer', null, null))).toBe(true)
  })

  it('Inactive + NO message + NO price → dead (listing-issues Case B: a stockout keeps its price)', () => {
    expect(offerEvidenceSaysDead(ev('Inactive', null, null))).toBe(true)
    expect(offerEvidenceSaysDead(ev('Inactive', '', 0))).toBe(true)
    expect(offerEvidenceSaysDead(ev('Inactive', null, 24.99))).toBe(false) // priced → not this prong
  })

  it('other inactive reasons are NOT offer death (replenishment / suppression / missing-info own those)', () => {
    expect(offerEvidenceSaysDead(ev('Inactive', 'Out of stock', null))).toBe(false)
    expect(offerEvidenceSaysDead(ev('Inactive', 'Detail page removed', null))).toBe(false)
    expect(offerEvidenceSaysDead(ev('Inactive', 'Blocked', null))).toBe(false)
    expect(offerEvidenceSaysDead(ev('Incomplete', null, null))).toBe(false)
    expect(offerEvidenceSaysDead(ev('Suppressed', null, null))).toBe(false)
    expect(offerEvidenceSaysDead(ev(null, null, null))).toBe(false)
    expect(offerEvidenceSaysDead(ev('Unknown', null, null))).toBe(false)
  })

  it('exports the ONE column list the loader selects (matches the listing-issues route\'s own select)', () => {
    expect(OFFER_EVIDENCE_COLS).toBe('sku, status, status_message, price, last_synced_at')
  })
})

describe('detectDeadVariants — N-day boundary (strict >)', () => {
  it('exactly N days behind is NOT flagged; a minute past N days IS', () => {
    const atBoundary = detectDeadVariants([
      contentRow('MAX', 'B0AAAAAAA1', iso(0)),
      contentRow('EDGE', 'B0AAAAAAA2', iso(VARIANT_DEATH_LAG_DAYS * DAY_MS)),
    ])
    expect(atBoundary.flagged).toEqual([])

    const pastBoundary = detectDeadVariants([
      contentRow('MAX', 'B0AAAAAAA1', iso(0)),
      contentRow('EDGE', 'B0AAAAAAA2', iso(VARIANT_DEATH_LAG_DAYS * DAY_MS + 60_000)),
    ])
    expect(pastBoundary.flagged.map((f) => f.sku)).toEqual(['EDGE'])
    expect(pastBoundary.flagged[0].lag_days).toBe(VARIANT_DEATH_LAG_DAYS)
  })

  it('honors a custom lagDays option', () => {
    const rows = [
      contentRow('MAX', 'B0AAAAAAA1', iso(0)),
      contentRow('OLD-10', 'B0AAAAAAA2', iso(10 * DAY_MS)),
    ]
    expect(detectDeadVariants(rows).flagged).toEqual([])                       // default 14 → clean
    expect(detectDeadVariants(rows, { lagDays: 7 }).flagged.map((f) => f.sku)).toEqual(['OLD-10'])
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
    expect(r.flagged).toEqual([])
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
    expect(r.flagged).toEqual([])
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
    expect(r.flagged.map((f) => f.sku)).toEqual(['GATOR-L'])
    expect(r.rows_considered).toBe(2)
  })
})

describe('detectDeadVariants — degenerate families', () => {
  it('single-child family never flags sync_lag (a row cannot lag itself)', () => {
    const r = detectDeadVariants([contentRow('ONLY-FBA', 'B0AAAAAAA1', iso(500 * DAY_MS))])
    expect(r.flagged).toEqual([])
    expect(r.rows_considered).toBe(1)
  })

  it('no valid timestamps anywhere → no baseline → no sync_lag flags', () => {
    const r = detectDeadVariants([
      contentRow('A-FBA', 'B0AAAAAAA1', null),
      contentRow('B-FBA', 'B0AAAAAAA2', 'not-a-date'),
    ])
    expect(r.flagged).toEqual([])
    expect(r.family_max_synced_at).toBeNull()
  })

  it('empty family → empty report', () => {
    expect(detectDeadVariants([])).toEqual({
      flagged: [], shellRows: 0, family_max_synced_at: null, rows_considered: 0, offer_evidence_rows: 0,
    })
  })

  it('never-attested content row flags sync_lag with lag_days null once a baseline exists', () => {
    const r = detectDeadVariants([
      contentRow('A-FBA', 'B0AAAAAAA1', iso(0)),
      contentRow('B-FBA', 'B0AAAAAAA2', null),
    ])
    expect(r.flagged).toEqual([
      {
        sku: 'B-FBA', asin: 'B0AAAAAAA2', reasons: ['sync_lag'], content_synced_at: null, lag_days: null,
        offer_status: null, offer_status_message: null, offer_evidence_at: null,
      },
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
