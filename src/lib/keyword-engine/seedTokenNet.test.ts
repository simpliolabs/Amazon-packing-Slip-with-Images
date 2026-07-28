import { describe, it, expect } from 'vitest'
import {
  seedTokenHit, auditSeedTokens, reserveSeedTokenSlots,
  SEED_TOKEN_MIN_HITS, SEED_TOKEN_RESERVED_SLOTS,
} from './seedTokenNet'

const row = (keyword: string, searchVolume: number) => ({ keyword, searchVolume })
const NICHE_SLOTS = 70 // mirrors keywordResearcher.ts — asserted here as the cap the net must clear

describe('seedTokenNet — the #144 invariant', () => {
  it('reproduces the B0GF49RLDL trip: the measured head-only pool has ZERO seed-token rows', () => {
    const pool = [
      row('comfort colors t shirt', 306000),
      row('confort colors t shirt', 3625),   // the misspelling that survived the cut
      row('graphic tees for women', 476829),
    ]
    const a = auditSeedTokens(['cupid', 'valentine'], pool)
    expect(a.ok).toBe(false)
    expect(a.missing).toEqual(['cupid', 'valentine'])   // seed order preserved
  })

  it('passes once the design family is present', () => {
    const union = [
      row('comfort colors t shirt', 306000),
      row('cupid shirt', 450), row('cupid valentine tee', 310), row('cupid arrow shirt', 260),
    ]
    const a = auditSeedTokens(['cupid'], union)
    expect(a.hits.cupid).toBeGreaterThanOrEqual(SEED_TOKEN_MIN_HITS)
    expect(a.ok).toBe(true)
  })

  // THE #95 REGRESSION GUARD. If anyone turns the counter into a row filter, this test dies.
  it('is a HARVEST counter, never a row filter — #95 payoff rows carry no seed token and MUST survive', () => {
    const rows95 = [row('jesus shirt', 40000), row('faith shirt', 18000), row('religious shirts', 9000)]
    expect(auditSeedTokens(['christian'], rows95).hits.christian).toBe(0)          // reports a miss...
    expect(reserveSeedTokenSlots(rows95, ['christian'], SEED_TOKEN_RESERVED_SLOTS)).toHaveLength(3) // ...removes NOTHING
  })

  // #95 ALIGNMENT, not merely inertness: on the real #95 harvest the net trips on "faith", whose
  // head phrase "faith shirt" is named verbatim in 13b4629 as part of the head family #95 wanted.
  it('on the #95 harvest the net asks for MORE of the head family, not less', () => {
    const pool = [row('mustard christian shirt', 41), row('christian tshirts for women', 176), row('christian faith tee', 90)]
    const a = auditSeedTokens(['christian', 'faith'], pool)
    expect(a.hits.christian).toBe(3)        // already satisfied — no spend on this token
    expect(a.missing).toEqual(['faith'])    // ⇒ candidate head "faith shirt" = the #95 family
  })

  it('matches plural/possessive via the coverage seam, but never a substring', () => {
    expect(seedTokenHit('valentines day shirt for her', ['valentine'])).toBe(true)
    expect(seedTokenHit("cupid's arrow tee", ['cupid'])).toBe(true)
    expect(seedTokenHit('cup holder shirt', ['cupid'])).toBe(false)
  })

  it('fails OPEN on an all-generic seed (the blank-brand auto-seed case)', () => {
    expect(auditSeedTokens([], []).ok).toBe(true)
  })

  it('BYTE-IDENTICAL when off: no tokens or no slots ⇒ pure volume-DESC, same as the old cap', () => {
    const rows = [row('a', 5), row('b', 500), row('c', 50)]
    expect(reserveSeedTokenSlots(rows, [], 0).map((r) => r.keyword)).toEqual(['b', 'c', 'a'])
    expect(reserveSeedTokenSlots(rows, ['zzz'], SEED_TOKEN_RESERVED_SLOTS).map((r) => r.keyword)).toEqual(['b', 'c', 'a'])
  })

  it('a 450/mo seed-token row survives the 70-slot cut against 100 higher-volume rows', () => {
    const heads = Array.from({ length: 100 }, (_, i) => row(`comfort colors ${i}`, 1200 + i * 10))
    const tail = row('cupid valentine shirt women', 450)
    const out = reserveSeedTokenSlots([...heads, tail], ['cupid'], SEED_TOKEN_RESERVED_SLOTS).slice(0, NICHE_SLOTS)
    expect(out.map((r) => r.keyword)).toContain('cupid valentine shirt women')
    expect(out[0].keyword).toBe('cupid valentine shirt women')  // the reserved band leads
    expect(out).toHaveLength(NICHE_SLOTS)                       // and the cap still holds at 70
  })

  it('reservation is SELF-LIMITING — a band already carrying its seed-token rows is unchanged', () => {
    const rows = [row('cupid shirt', 9000), row('graphic tee', 5000), row('comfort colors', 3000)]
    expect(reserveSeedTokenSlots(rows, ['cupid'], SEED_TOKEN_RESERVED_SLOTS).map((r) => r.keyword))
      .toEqual(['cupid shirt', 'graphic tee', 'comfort colors'])
  })
})
