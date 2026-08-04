import { describe, it, expect } from 'vitest'
import { seedTokenHit, auditSeedTokens, SEED_TOKEN_MIN_HITS } from './seedTokenNet'

// The surviving supply-audit primitives (POOL_STRATA flip 2026-08-03). The old reservation-model
// tests died with reserveSeedTokenSlots; row-survival under the cap is now pinned by
// poolComposer.test.ts's strata guarantees.

const row = (keyword: string, searchVolume: number) => ({ keyword, searchVolume })

describe('seedTokenNet — the #144 audit primitives', () => {
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
  it('is a HARVEST counter, never a row filter — #95 payoff rows carry no seed token and report a miss without being touched', () => {
    const rows95 = [row('jesus shirt', 40000), row('faith shirt', 18000), row('religious shirts', 9000)]
    const a = auditSeedTokens(['christian'], rows95)
    expect(a.hits.christian).toBe(0)   // reports the miss…
    expect(rows95).toHaveLength(3)     // …and mutates nothing (counting is the ONLY effect)
  })

  // #95 ALIGNMENT: on the real #95 harvest the audit trips on "faith", whose head phrase
  // "faith shirt" is named verbatim in 13b4629 as part of the head family #95 wanted.
  it('on the #95 harvest the audit asks for MORE of the head family, not less', () => {
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
})
