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
  offerVerdict,
  expandFamilyRoster,
  attachVariantDeath,
  rowHasContent,
  variantDeathAlarmEnabled,
  describeVariantDeathAlarm,
  VARIANT_DEATH_LAG_DAYS,
  OFFER_LIVENESS_GRACE_MS,
  OFFER_EVIDENCE_COLS,
  type VariantSyncRow,
  type OfferEvidenceRow,
  type OfferLivenessRow,
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
      offer_liveness_rows: 0, roster_only_rows: 0,
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
        offer_dead_source: null, offer_live: null, offer_missing_since: null, offer_checked_at: null, roster_only: false,
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

// ═══════════════════════════════════════════════════════════════════════════════════
// THE GATE'S OWN VERDICT (migration 059) — persisted push-gate liveness as evidence.
// The Later Gator case: listing_health said Active, content_synced_at had been advanced by
// an apply, and the push gate was skipping the Orchid SKUs as offerless on every push.
// ═══════════════════════════════════════════════════════════════════════════════════
const HOUR_MS = 3_600_000
const NOW = T0 + 10 * DAY_MS // "now" for the grace test — well after every fixture timestamp

const liveRow = (sku: string, asin = 'B0AAAAAAA2', parent_asin: string | null = 'B0PARENT00'): OfferLivenessRow => ({
  sku, asin, parent_asin, last_checked_at: new Date(NOW - HOUR_MS).toISOString(), offer_live: true,
  source: 'push_gate', detail: null, offer_seen_live_at: new Date(NOW - HOUR_MS).toISOString(), offer_missing_since: null,
})
const deadRow = (sku: string, missingForMs: number, asin = 'B0AAAAAAA2', parent_asin: string | null = 'B0PARENT00'): OfferLivenessRow => ({
  sku, asin, parent_asin, last_checked_at: new Date(NOW - HOUR_MS).toISOString(), offer_live: false,
  source: 'push_gate', detail: 'Listings-Items search by ASIN returned 0 seller SKUs (gate skipped as offerless)',
  offer_seen_live_at: null, offer_missing_since: new Date(NOW - missingForMs).toISOString(),
})

describe('detectDeadVariants — persisted gate verdict (offer_dead from the gate alone)', () => {
  it('flags offer_dead from the persisted verdict ALONE — no listing_health row, sync in step with siblings', () => {
    // Exactly the Later Gator shape: every row freshly synced (an apply advanced them all), no
    // listing_health evidence, but the gate has been skipping the ORC SKU for two months.
    const rows = [
      contentRow('6014L-ORC-Later-Gator-LS-TS', 'B0AAAAAAA1', iso(0)),
      contentRow('6014XL-ORC-Later-Gator-LS-TS', 'B0AAAAAAA2', iso(0)),
    ]
    const r = detectDeadVariants(rows, { offerLiveness: [deadRow('6014XL-ORC-Later-Gator-LS-TS', 60 * DAY_MS)], now: NOW })
    expect(r.flagged.map((f) => f.sku)).toEqual(['6014XL-ORC-Later-Gator-LS-TS'])
    expect(r.flagged[0].reasons).toEqual(['offer_dead'])
    expect(r.flagged[0].offer_dead_source).toBe('gate')
    expect(r.flagged[0].offer_live).toBe(false)
    expect(r.flagged[0].offer_missing_since).toBe(new Date(NOW - 60 * DAY_MS).toISOString())
    expect(r.offer_liveness_rows).toBe(1)
    expect(r.offer_evidence_rows).toBe(0)
  })

  it('a DEAD gate verdict past the grace wins over a stale Active listing_health row', () => {
    const rows = [contentRow('A-FBA', 'B0AAAAAAA1', iso(0)), contentRow('B-FBA', 'B0AAAAAAA2', iso(0))]
    const r = detectDeadVariants(rows, {
      offerEvidence: [activeEv('A-FBA'), activeEv('B-FBA')],
      offerLiveness: [deadRow('B-FBA', 3 * DAY_MS)],
      now: NOW,
    })
    expect(r.flagged.map((f) => f.sku)).toEqual(['B-FBA'])
    expect(r.flagged[0].offer_dead_source).toBe('gate')
    expect(r.flagged[0].offer_status).toBe('Active') // the stale proxy is echoed, not trusted
  })

  it('a LIVE gate verdict overrides listing_health "Missing offer" (the gate saw it live; status_message is never cleared)', () => {
    const rows = [contentRow('A-FBA', 'B0AAAAAAA1', iso(0)), contentRow('B-FBA', 'B0AAAAAAA2', iso(0))]
    const without = detectDeadVariants(rows, { offerEvidence: [missingOfferEv('B-FBA')], now: NOW })
    expect(without.flagged.map((f) => f.sku)).toEqual(['B-FBA']) // health alone would flag it
    const withLive = detectDeadVariants(rows, { offerEvidence: [missingOfferEv('B-FBA')], offerLiveness: [liveRow('B-FBA')], now: NOW })
    expect(withLive.flagged).toEqual([]) // the live verdict wins
    expect(withLive.offer_liveness_rows).toBe(1)
  })

  it('grace window: dead for 1h is NOT flagged; dead for 25h IS; exactly the grace is NOT (strict)', () => {
    const rows = [contentRow('A-FBA', 'B0AAAAAAA1', iso(0)), contentRow('B-FBA', 'B0AAAAAAA2', iso(0))]
    expect(detectDeadVariants(rows, { offerLiveness: [deadRow('B-FBA', HOUR_MS)], now: NOW }).flagged).toEqual([])
    expect(detectDeadVariants(rows, { offerLiveness: [deadRow('B-FBA', OFFER_LIVENESS_GRACE_MS)], now: NOW }).flagged).toEqual([])
    expect(detectDeadVariants(rows, { offerLiveness: [deadRow('B-FBA', 25 * HOUR_MS)], now: NOW }).flagged.map((f) => f.sku)).toEqual(['B-FBA'])
    expect(OFFER_LIVENESS_GRACE_MS).toBe(24 * HOUR_MS)
  })

  it('inside the grace, listing_health still rules (keeps the existing prong; source says health)', () => {
    const rows = [contentRow('A-FBA', 'B0AAAAAAA1', iso(0)), contentRow('B-FBA', 'B0AAAAAAA2', iso(0))]
    const r = detectDeadVariants(rows, { offerEvidence: [missingOfferEv('B-FBA')], offerLiveness: [deadRow('B-FBA', HOUR_MS)], now: NOW })
    expect(r.flagged.map((f) => f.sku)).toEqual(['B-FBA'])
    expect(r.flagged[0].offer_dead_source).toBe('health')
  })

  it('a dead verdict with a null offer_missing_since falls back to last_checked_at', () => {
    const lv = { ...deadRow('B-FBA', 0), offer_missing_since: null, last_checked_at: new Date(NOW - 2 * DAY_MS).toISOString() }
    expect(offerVerdict(lv, null, NOW)).toBe('gate')
    expect(offerVerdict({ ...lv, last_checked_at: new Date(NOW - HOUR_MS).toISOString() }, null, NOW)).toBeNull()
  })

  it('offer_dead from the gate needs no baseline: a single-child family can be flagged', () => {
    const r = detectDeadVariants([contentRow('ONLY-FBA', 'B0AAAAAAA2', iso(0))], { offerLiveness: [deadRow('ONLY-FBA', 5 * DAY_MS)], now: NOW })
    expect(r.flagged.map((f) => f.sku)).toEqual(['ONLY-FBA'])
  })

  it('shells stay excluded even when a dead gate verdict exists for them', () => {
    const rows = [contentRow('REAL-FBA', 'B0AAAAAAA1', iso(0)), shellRow('SHELL-FBA', 'B0AAAAAAA9', iso(0))]
    const r = detectDeadVariants(rows, { offerLiveness: [deadRow('SHELL-FBA', 30 * DAY_MS, 'B0AAAAAAA9')], now: NOW })
    expect(r.flagged).toEqual([])
    expect(r.shellRows).toBe(1)
    expect(r.offer_liveness_rows).toBe(0) // shells are not counted in coverage
  })
})

describe('detectDeadVariants — roster-only rows (persisted twins with no listing_content row)', () => {
  const rosterOnly = (sku: string, asin: string): VariantSyncRow => ({ sku, asin, content_synced_at: null, roster_only: true })

  it('is exempt from sync_lag and the baseline (no attestation to lag), but the gate prong can flag it', () => {
    const rows = [
      contentRow('A-FBA', 'B0AAAAAAA1', iso(0)),
      contentRow('B-FBA', 'B0AAAAAAA2', iso(0)),
      rosterOnly('A', 'B0AAAAAAA1'),       // FBM twin known only from push discovery — clean
      rosterOnly('B', 'B0AAAAAAA2'),       // FBM twin, dead per the gate
    ]
    const r = detectDeadVariants(rows, { offerLiveness: [liveRow('A', 'B0AAAAAAA1'), deadRow('B', 40 * DAY_MS)], now: NOW })
    expect(r.rows_considered).toBe(4)
    expect(r.roster_only_rows).toBe(2)
    expect(r.flagged.map((f) => f.sku)).toEqual(['B'])
    expect(r.flagged[0].reasons).toEqual(['offer_dead']) // NOT sync_lag — never-attested does not apply
    expect(r.flagged[0].roster_only).toBe(true)
    expect(r.flagged[0].lag_days).toBeNull()
  })

  it('does not change the shell rule: a contentless DB row with only a roster-only twin is still a shell', () => {
    const rows = [
      contentRow('A-FBA', 'B0AAAAAAA1', iso(30 * DAY_MS)),
      contentRow('B-FBA', 'B0AAAAAAA2', iso(30 * DAY_MS)),
      shellRow('SHELL-FBA', 'B0AAAAAAA9', iso(0)),     // fresh shell
      rosterOnly('SHELL', 'B0AAAAAAA9'),                // persisted sighting of its twin
    ]
    const r = detectDeadVariants(rows, { now: NOW })
    expect(r.shellRows).toBe(1)
    expect(r.family_max_synced_at).toBe(iso(30 * DAY_MS)) // the fresh shell did NOT enter the baseline
    expect(r.flagged).toEqual([])
  })
})

describe('expandFamilyRoster / attachVariantDeath — INVARIANT 2: one resolver for the roster', () => {
  const P = 'B0GML5V7KZ'
  // A 56-ASIN apparel family (8 colors x 7 sizes). listing_content holds ONE row per ASIN (the
  // FBA SKU — the historical FBA/FBM dedup); the push gate has persisted the full discovery:
  // both twins under every ASIN = 112 SKUs, which with the parent hub the route appends is the
  // 113-SKU roster the family-skus endpoint shows for this family.
  const sizes = ['S', 'M', 'L', 'XL', '2XL', '3XL', '4XL']
  const colors = ['ORC', 'BLK', 'WHT', 'NVY', 'GRY', 'RED', 'BLU', 'GRN']
  const asins: { asin: string; base: string }[] = []
  let n = 0
  for (const c of colors) for (const s of sizes) asins.push({ asin: `B0FAM${String(n++).padStart(5, '0')}`, base: `6014${s}-${c}-Later-Gator-LS-TS` })
  const cached: VariantSyncRow[] = asins.map(({ asin, base }) => contentRow(`${base}-FBA`, asin, iso(0)))
  const persisted: OfferLivenessRow[] = asins.flatMap(({ asin, base }) => [liveRow(`${base}-FBA`, asin, P), liveRow(base, asin, P)])

  it('expands the 56 listing_content rows to the 112-SKU roster the family-skus route shows (113 with its parent hub)', () => {
    expect(asins).toHaveLength(56)
    expect(cached).toHaveLength(56)
    const roster = expandFamilyRoster(P, cached, persisted)
    expect(roster).toHaveLength(112)
    expect(roster.filter((r) => r.roster_only)).toHaveLength(56)
    // cached rows keep their full content shape (same object); discovered twins are roster_only
    expect(roster.find((r) => r.sku === '6014S-ORC-Later-Gator-LS-TS-FBA')).toBe(cached[0])
    expect(roster.find((r) => r.sku === '6014XL-ORC-Later-Gator-LS-TS')).toEqual({ sku: '6014XL-ORC-Later-Gator-LS-TS', asin: asins[3].asin, content_synced_at: null, roster_only: true })
  })

  it('twin-name guard + system-SKU filter + other-parent rows: unrelated persisted rows never join', () => {
    const noise: OfferLivenessRow[] = [
      liveRow('DAFEI-482-128GB', asins[0].asin, P),       // shares the ASIN through a stale mapping — guarded out
      liveRow('amzn.gr.ABC123', asins[0].asin, P),         // Amazon-managed — never a seller SKU
      liveRow('6014S-ORC-Later-Gator-LS-TS', asins[0].asin, 'B0OTHERPAR'), // filed under another parent — not this roster
    ]
    const roster = expandFamilyRoster(P, cached.slice(0, 1), noise)
    expect(roster.map((r) => r.sku)).toEqual(['6014S-ORC-Later-Gator-LS-TS-FBA'])
    expect(expandFamilyRoster(null, cached.slice(0, 1), persisted)).toHaveLength(1) // no family id ⇒ cached only
  })

  it('attachVariantDeath considers the full roster and flags a dead twin the DB never had a row for', () => {
    const deadTwin = '6014XL-ORC-Later-Gator-LS-TS' // FBM twin of ASIN index 3 — not in listing_content
    // attachVariantDeath uses real Date.now(); the fixture's NOW (T0 + 10d = 2026-08-11) is in the past,
    // so "dead for 60 days before NOW" is far outside the 24h grace in real time as well.
    const evidence = {
      offerEvidence: [],
      offerLiveness: persisted.map((l) => (l.sku === deadTwin ? deadRow(deadTwin, 60 * DAY_MS, l.asin as string, P) : l)),
    }
    const out = attachVariantDeath({ parent_asin: P, children: cached }, evidence)
    const vd = out.variant_death!
    expect(vd.rows_considered).toBe(112)
    expect(vd.roster_only_rows).toBe(56)
    expect(vd.offer_liveness_rows).toBe(112)
    expect(vd.flagged.map((f) => f.sku)).toEqual([deadTwin])
    expect(vd.flagged[0]).toMatchObject({ reasons: ['offer_dead'], offer_dead_source: 'gate', roster_only: true })
  })

  it('no persisted rows (table empty / migration not yet applied) ⇒ roster is listing_content alone — the pre-059 behavior', () => {
    const out = attachVariantDeath({ parent_asin: P, children: cached }, {})
    expect(out.variant_death!.rows_considered).toBe(56)
    expect(out.variant_death!.roster_only_rows).toBe(0)
    expect(out.variant_death!.offer_liveness_rows).toBe(0)
    expect(out.variant_death!.flagged).toEqual([])
  })
})
