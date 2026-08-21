/**
 * OFFER LIVENESS writer tests — the push gate's own truth, persisted (migration 059).
 * Streak semantics (first-dead STICKS, any live sighting resets), the gate-interpretation rule
 * (post-valve; null discovery records nothing), and fail-open (a broken table never throws).
 * A tiny in-memory fake of the two supabase-js calls the writer makes (select.in / upsert).
 */
import { describe, it, expect, vi } from 'vitest'
import {
  mergeLivenessObservation,
  observationsFromGate,
  recordOfferLiveness,
  OFFER_LIVENESS_COLS,
  type OfferLivenessRow,
  type OfferLivenessObservation,
} from './offerLiveness'
import type { SupabaseClient } from '@supabase/supabase-js'

const T1 = '2026-06-17T00:00:00.000Z'
const T2 = '2026-07-01T00:00:00.000Z'
const T3 = '2026-08-21T00:00:00.000Z'

const dead = (sku: string, extra: Partial<OfferLivenessObservation> = {}): OfferLivenessObservation =>
  ({ sku, asin: 'B0AAAAAAA2', parent_asin: 'B0PARENT00', offer_live: false, source: 'push_gate', detail: 'zero SKUs', ...extra })
const live = (sku: string, extra: Partial<OfferLivenessObservation> = {}): OfferLivenessObservation =>
  ({ sku, asin: 'B0AAAAAAA2', parent_asin: 'B0PARENT00', offer_live: true, source: 'push_gate', ...extra })

/** Fake supabase: an in-memory table keyed by sku; `fail` simulates a missing table / RLS error. */
function fakeDb(seed: OfferLivenessRow[] = [], opts: { failRead?: boolean; failUpsert?: boolean; throwOn?: boolean } = {}) {
  const table = new Map(seed.map((r) => [r.sku, r]))
  const upserts: OfferLivenessRow[][] = []
  const client = {
    from: (name: string) => {
      expect(name).toBe('sku_offer_liveness')
      if (opts.throwOn) throw new Error('boom')
      return {
        select: (cols: string) => {
          expect(cols).toBe(OFFER_LIVENESS_COLS)
          return {
            in: async (col: string, keys: string[]) => {
              expect(col).toBe('sku')
              if (opts.failRead) return { data: null, error: { message: 'relation "sku_offer_liveness" does not exist' } }
              return { data: keys.map((k) => table.get(k)).filter(Boolean), error: null }
            },
          }
        },
        upsert: async (rows: OfferLivenessRow[], o: { onConflict: string }) => {
          expect(o.onConflict).toBe('sku')
          if (opts.failUpsert) return { error: { message: 'permission denied' } }
          upserts.push(rows)
          for (const r of rows) table.set(r.sku, r)
          return { error: null }
        },
      }
    },
  }
  return { client: client as unknown as SupabaseClient, table, upserts }
}

describe('mergeLivenessObservation — streak semantics', () => {
  it('first dead sighting stamps offer_missing_since = now', () => {
    const r = mergeLivenessObservation(null, dead('X'), T1)
    expect(r).toEqual({
      sku: 'X', asin: 'B0AAAAAAA2', parent_asin: 'B0PARENT00', last_checked_at: T1, offer_live: false,
      source: 'push_gate', detail: 'zero SKUs', offer_seen_live_at: null, offer_missing_since: T1,
    })
  })

  it('a repeated dead sighting KEEPS the first offer_missing_since (the streak sticks)', () => {
    const first = mergeLivenessObservation(null, dead('X'), T1)
    const again = mergeLivenessObservation(first, dead('X', { source: 'details_gate' }), T2)
    expect(again.offer_missing_since).toBe(T1)
    expect(again.last_checked_at).toBe(T2)
    expect(again.source).toBe('details_gate')
    expect(again.offer_seen_live_at).toBeNull()
  })

  it('a live sighting resets the streak and stamps offer_seen_live_at', () => {
    const deadRow = mergeLivenessObservation(null, dead('X'), T1)
    const recovered = mergeLivenessObservation(deadRow, live('X'), T2)
    expect(recovered.offer_live).toBe(true)
    expect(recovered.offer_missing_since).toBeNull()
    expect(recovered.offer_seen_live_at).toBe(T2)
    // and a NEW death after recovery starts a NEW streak from its own first sighting
    const diedAgain = mergeLivenessObservation(recovered, dead('X'), T3)
    expect(diedAgain.offer_missing_since).toBe(T3)
    expect(diedAgain.offer_seen_live_at).toBe(T2) // last live sighting is kept
  })

  it('keys follow the observation when present, else keep the stored value', () => {
    const stored = mergeLivenessObservation(null, live('X', { asin: 'B0OLD', parent_asin: 'B0OLDPAR' }), T1)
    const moved = mergeLivenessObservation(stored, live('X', { asin: 'B0NEW', parent_asin: 'B0NEWPAR' }), T2)
    expect(moved.asin).toBe('B0NEW'); expect(moved.parent_asin).toBe('B0NEWPAR')
    const keyless = mergeLivenessObservation(moved, { sku: 'X', offer_live: false, source: 'ih_probe' }, T3)
    expect(keyless.asin).toBe('B0NEW'); expect(keyless.parent_asin).toBe('B0NEWPAR')
  })
})

describe('observationsFromGate — the post-valve interpretation rule', () => {
  const ctx = { parentAsin: 'B0PARENT00', source: 'push_gate' as const }

  it('notLive rows are dead; every SKU Amazon listed is live; an unlisted stored SKU is unknown', () => {
    const rows = [
      { sku: 'A-FBA', asin: 'B0A', notLive: false },
      { sku: 'ORC-XL', asin: 'B0ORC', notLive: true },   // the Later Gator case: search returned []
      { sku: 'C-FBA', asin: 'B0C', notLive: false },     // Amazon listed C (FBM) but not C-FBA → unknown
    ]
    const discovered = new Map([
      ['B0A', [{ sku: 'A-FBA', asin: 'B0A' }, { sku: 'A', asin: 'B0A' }]],
      ['B0ORC', []],
      ['B0C', [{ sku: 'C', asin: 'B0C' }]],
    ])
    const obs = observationsFromGate(rows, discovered, ctx)
    const bySku = Object.fromEntries(obs.map((o) => [o.sku, o]))
    expect(Object.keys(bySku).sort()).toEqual(['A', 'A-FBA', 'C', 'ORC-XL'])
    expect(bySku['A-FBA'].offer_live).toBe(true)
    expect(bySku['A'].offer_live).toBe(true)              // the twin the push will add to its diff
    expect(bySku['ORC-XL']).toMatchObject({ offer_live: false, asin: 'B0ORC', parent_asin: 'B0PARENT00', source: 'push_gate' })
    expect(bySku['C-FBA']).toBeUndefined()                // not the gate's verdict → no row
  })

  it('a FAILED lookup (null) records nothing — never infer offerless from an API hiccup', () => {
    const obs = observationsFromGate([{ sku: 'A-FBA', asin: 'B0A', notLive: false }], new Map([['B0A', null]]), ctx)
    expect(obs).toEqual([])
  })

  it('safety valve tripped (discovery [] but notLive cleared) ⇒ no dead rows persisted', () => {
    // Half or more would skip → loadDiff resets notLive=false on every row; the rows we receive
    // carry notLive:false and their ASINs map to [] — the rule yields NOTHING for them.
    const rows = [{ sku: 'A', asin: 'B0A', notLive: false }, { sku: 'B', asin: 'B0B', notLive: false }]
    const obs = observationsFromGate(rows, new Map([['B0A', []], ['B0B', []]]), ctx)
    expect(obs).toEqual([])
  })
})

describe('recordOfferLiveness — batched upsert, fail-open', () => {
  it('first-dead sticks across two calls; a live sighting resets; returns the row count', async () => {
    const db = fakeDb()
    expect(await recordOfferLiveness(db.client, [dead('ORC-XL'), live('ORC-L')], T1)).toBe(2)
    expect(db.table.get('ORC-XL')!.offer_missing_since).toBe(T1)
    expect(db.table.get('ORC-L')!.offer_seen_live_at).toBe(T1)

    expect(await recordOfferLiveness(db.client, [dead('ORC-XL')], T2)).toBe(1)
    expect(db.table.get('ORC-XL')).toMatchObject({ offer_missing_since: T1, last_checked_at: T2, offer_live: false })

    expect(await recordOfferLiveness(db.client, [live('ORC-XL')], T3)).toBe(1)
    expect(db.table.get('ORC-XL')).toMatchObject({ offer_missing_since: null, offer_seen_live_at: T3, offer_live: true })
  })

  it('duplicates within one call collapse to the LAST observation; blank SKUs are dropped', async () => {
    const db = fakeDb()
    expect(await recordOfferLiveness(db.client, [dead('X'), live('X'), { sku: '', offer_live: true, source: 'ih_probe' }], T1)).toBe(1)
    expect(db.upserts[0]).toHaveLength(1)
    expect(db.table.get('X')!.offer_live).toBe(true)
  })

  it('empty input does not touch the database', async () => {
    const db = fakeDb()
    expect(await recordOfferLiveness(db.client, [], T1)).toBe(0)
    expect(db.upserts).toEqual([])
  })

  it('table missing (read error) ⇒ warns, writes nothing, NEVER throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const db = fakeDb([], { failRead: true })
    await expect(recordOfferLiveness(db.client, [dead('X')], T1)).resolves.toBe(0)
    expect(db.upserts).toEqual([])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[offerLiveness]'), expect.stringContaining('does not exist'))
    warn.mockRestore()
  })

  it('upsert error and thrown client errors are swallowed too', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(recordOfferLiveness(fakeDb([], { failUpsert: true }).client, [dead('X')], T1)).resolves.toBe(0)
    await expect(recordOfferLiveness(fakeDb([], { throwOn: true }).client, [dead('X')], T1)).resolves.toBe(0)
    expect(warn).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })

  it('chunks a large batch (250 SKUs → 2 read/upsert rounds)', async () => {
    const db = fakeDb()
    const many = Array.from({ length: 250 }, (_, i) => live(`SKU-${i}`))
    expect(await recordOfferLiveness(db.client, many, T1)).toBe(250)
    expect(db.upserts.map((u) => u.length)).toEqual([200, 50])
  })
})
