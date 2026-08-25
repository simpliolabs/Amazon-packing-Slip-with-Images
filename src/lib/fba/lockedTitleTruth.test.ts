/**
 * Pins for lockedTitleTruth.ts (PO-approved 2026-08-22, live case B0DSCDZC6K): a LOCKED title must
 * stay untouched (this module never edits it) but its lies must become VISIBLE. Pure unit tests only —
 * `lockedTitleViolations` takes an already-resolved `PhraseTruthCtx`, so these never touch the DB and
 * never hit the CI Supabase-placeholder trap (see gatePerChildMultiDesign.integration.test.ts).
 */
import { describe, it, expect } from 'vitest'
import { lockedTitleViolations } from './lockedTitleTruth'
import { audienceOfGarmentFamily, type PhraseTruthCtx } from './contentTruth'

/** The B0DSCDZC6K family, as the resolver reports it: Gildan 18000 sweatshirt + 18500 hoodie under
 *  one parent, unisex lean, Gildan is brand_in_copy:false (allowedBrand ''). Mirrors the SWEATS
 *  fixture in contentTruthSpine.test.ts so both suites are judging the identical live family. */
const SWEATS: PhraseTruthCtx = {
  garmentFamily: 'sweatshirt',
  mixedFamilies: ['sweatshirt', 'hoodie'],
  spec: { weightNote: 'heavyweight 8.0 oz fleece' },
  allowedBrand: '',
  audience: audienceOfGarmentFamily('sweatshirt'),
  audienceLean: 'unisex',
  field: 'title',
}
const BLANK_LABEL = 'Gildan 18000'

describe('lockedTitleViolations — the live B0DSCDZC6K case', () => {
  const LIVE_TITLE = "THE CEO Motivational Entrepreneur Tee Shirt | Funny Business Tshirt for Men"

  it('reports wrong-garment-noun for a locked title naming a tee on a sweatshirt family', () => {
    const out = lockedTitleViolations(LIVE_TITLE, 'manual', SWEATS, BLANK_LABEL)
    expect(out.map((v) => v.reason)).toContain('wrong-garment-noun')
  })

  it('reports audience-lean-lie for "for Men" on a unisex lean', () => {
    const out = lockedTitleViolations(LIVE_TITLE, 'manual', SWEATS, BLANK_LABEL)
    expect(out.map((v) => v.reason)).toContain('audience-lean-lie')
  })

  it('finds BOTH violations in the same pass, and each names its own thing in plain words', () => {
    const out = lockedTitleViolations(LIVE_TITLE, 'manual', SWEATS, BLANK_LABEL)
    expect(out.map((v) => v.reason).sort()).toEqual(['audience-lean-lie', 'wrong-garment-noun'])
    const garment = out.find((v) => v.reason === 'wrong-garment-noun')!
    const gender = out.find((v) => v.reason === 'audience-lean-lie')!
    expect(garment.message).toMatch(/sweatshirt/i)
    expect(garment.message).toMatch(/Gildan 18000/)
    expect(gender.message).toMatch(/unisex/i)
    expect(gender.message).toMatch(/for Men/i)
  })

  it('a locked title that is TRUE of the family reports nothing', () => {
    const out = lockedTitleViolations('THE CEO Motivational Entrepreneur Sweatshirt | Funny Business Fall Crewneck', 'manual', SWEATS, BLANK_LABEL)
    expect(out).toEqual([])
  })

  it('an unlocked (AI-owned) title is never analyzed, even if it would otherwise lie', () => {
    expect(lockedTitleViolations(LIVE_TITLE, 'ai', SWEATS, BLANK_LABEL)).toEqual([])
    expect(lockedTitleViolations(LIVE_TITLE, null, SWEATS, BLANK_LABEL)).toEqual([])
    expect(lockedTitleViolations(LIVE_TITLE, undefined, SWEATS, BLANK_LABEL)).toEqual([])
  })

  it('no violation is reported when the blank is unresolved — fail-open, like the rest of the truth spine', () => {
    expect(lockedTitleViolations(LIVE_TITLE, 'manual', null, null)).toEqual([])
  })

  it('an empty locked title reports nothing', () => {
    expect(lockedTitleViolations('', 'manual', SWEATS, BLANK_LABEL)).toEqual([])
    expect(lockedTitleViolations('   ', 'manual', SWEATS, BLANK_LABEL)).toEqual([])
  })
})

describe('lockedTitleViolations — other reason codes stay reachable, not just the live pair', () => {
  const TEE: PhraseTruthCtx = {
    garmentFamily: 'tee',
    spec: { weightNote: 'midweight 6.1 oz garment-dyed' },
    allowedBrand: 'Comfort Colors',
    audience: audienceOfGarmentFamily('tee'),
    audienceLean: null,
    field: 'title',
  }

  it('capability-claim: a claim the blank does not state', () => {
    const out = lockedTitleViolations('THE CEO Cool Vibes Moisture-Wicking Tee', 'manual', TEE)
    expect(out.map((v) => v.reason)).toContain('capability-claim')
  })

  it('competitor-brand: another maker named in the locked title', () => {
    const out = lockedTitleViolations('THE CEO Cool Vibes Gildan Tee', 'manual', TEE)
    expect(out.map((v) => v.reason)).toContain('competitor-brand')
  })
})
