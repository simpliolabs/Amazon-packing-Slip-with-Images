/**
 * poGoldCorpus.test.ts — the corpus must measure the seller, not assert at them.
 *
 * WHY THESE EXIST. On 2026-08-10 I wrote "left segment ≤6-7 words" into SELLER_PROFILE from ONE
 * gold. Mining the seller's actual corpus put the median at 8 with a range of 4-10 — so the rule I
 * had written would have over-constrained the council against the seller's own taste. The fix is
 * structural, not a corrected constant: the brief quotes MEASURED numbers, so it cannot drift from
 * the examples printed directly beneath it.
 */

import { describe, it, expect } from 'vitest'
import {
  SEED_GOLD_TITLES, SEED_REJECT_PAIRS, measureGoldShape, goldSpecBlock, rejectPairBlock, loadPoGoldTitles, GOLD_BRIEF_LIMIT,
} from './poGoldCorpus'

describe('measureGoldShape', () => {
  it('measures the seed corpus rather than asserting a shape', () => {
    // The seed is the seller's verbatim 2026-08-11 list (nine titles, streamed in one sitting).
    // Their own range is 69–78 — one UNDER our 70 floor, one OVER Amazon's 75 — so the tests pin
    // the MEASURED median, not the hand-written band.
    const s = measureGoldShape(SEED_GOLD_TITLES)
    expect(s.count).toBe(9)
    expect(s.medianLen).toBe(74)
    expect(s.pipedShare).toBe(0.56)                 // 5 of 9 — the pipe is common, NOT mandatory
    expect(s.leftWordsFrom).toBe(5)                 // left stats from the piped subset only
    expect(s.medianLeftWords).toBe(6)               // 4 / 6 / 6 / 8 / 10 piped lefts
    expect(s.maxLeftWords).toBe(10)
  })

  it('measures the fields the brief will print — every number computed, none typed (PR-A)', () => {
    const s = measureGoldShape(SEED_GOLD_TITLES)
    expect([s.lenMin, s.lenMax]).toEqual([69, 78])            // one under OUR floor, one over AMAZON'S cap
    expect(s.sepMix).toEqual({ pipe: 5, comma: 2, plain: 2 }) // the pipe is common, never mandatory
    expect(s.tails.length).toBe(5)                            // every pipe-right, verbatim
    expect(s.tails[4]).toBe('Funny Comfort Colors Shirt for Men Women')
    expect(s.tailClass).toEqual({ search: 2, brand: 3, specOnly: 0 })  // ZERO spec-only tails, ever
    expect(s.garment).toEqual({ twice: 8, once: 1 })          // adjacency-collapsed; Espana is the 1
    expect(s.audienceMix).toEqual({ gendered: 7, inclusive: 0, none: 2 })
  })

  it('an ALL-UNPIPED corpus falls back to whole-title counts rather than reporting 0', () => {
    // The fallback, not the old convention. Left-segment stats are measured over the PIPED subset
    // (see below), but `loadPoGoldTitles` takes only the newest 12 manual rows and the live corpus is
    // ~70% unpiped, so an all-unpiped window is genuinely reachable. Reporting 0 there would make
    // goldBriefBlock instruct the council "never more than 0 words before the separator".
    const s = measureGoldShape(['THE CEO Later Gator Tee Shirt Comfort Colors Graphic for Women'])
    expect(s.pipedShare).toBe(0)
    expect(s.medianLeftWords).toBe(11)   // THE/CEO/Later/Gator/Tee/Shirt/Comfort/Colors/Graphic/for/Women
    expect(s.leftWordsFrom).toBe(1)
  })

  it('left-segment stats come from the PIPED subset — an unpiped title cannot inflate the ceiling', () => {
    // THE DEFECT THIS PINS. `leftOf` returns the WHOLE title when there is no ' | ', so a long
    // unpiped gold used to contribute its full word count as though it were a left segment. On the
    // live corpus (pipedShare 0.30) that inflated population is the MAJORITY, and the brief quoted
    // the inflated ceiling back to the council as the seller's own law — licensing exactly the
    // 12-word left segment the seller rejected on B0GVV3XL4T.
    const mixed = [
      'THE CEO 2026 World Soccer Cup Tee Shirt | USA Mexico Canada Football Tee',        // piped, 8 left
      'THE CEO See You Later Alligator Shirt | Long Sleeve Comfort Colors Shirt',        // piped, 7 left
      'THE CEO I Will Praise Him in Every Season Tee | Christian Shirts for Women',      // piped, 10 left
      'THE CEO Espana Championship Tee Shirt 2026 Spain Jersey Football Soccer Cup',     // unpiped, 12 words
    ]
    const s = measureGoldShape(mixed)
    expect(s.maxLeftWords).toBe(10)       // NOT 12 — the unpiped title contributes no left segment
    expect(s.leftWordsFrom).toBe(3)       // and the sample size says so honestly
    expect(s.pipedShare).toBe(0.75)       // still measured over the WHOLE corpus
    expect(s.count).toBe(4)
  })

  it('a piped sample of 1-2 is NOT trusted — one atypical lock must not become a hard law', () => {
    // `goldBriefBlock` states the ceiling to the council as "never more than N". At the live
    // pipedShare of 0.30 over a 12-row window, the piped subset is routinely 1-2 titles, so without
    // a minimum the council would be handed a rule derived from a single row. Here the lone piped
    // gold has a 4-word left segment; trusting it would forbid every design a normal left segment.
    const thin = [
      'THE CEO Gator | Tee',                                                             // piped, 4 left
      'THE CEO Espana Championship Tee Shirt 2026 Spain Jersey Football Soccer Cup',     // unpiped, 12
      'THE CEO Later Gator Tee Shirt Comfort Colors Graphic for Women',                  // unpiped, 11
    ]
    const s = measureGoldShape(thin)
    expect(s.leftWordsFrom).toBe(3)       // fell back to the whole list, not the 1-title subset
    expect(s.maxLeftWords).toBe(12)       // a mildly inflated ceiling beats a fabricated-precise one
    expect(s.pipedShare).toBeCloseTo(0.33, 2)
  })

  it('empty corpus is a zero shape, never a throw — the brief degrades, it does not crash', () => {
    expect(measureGoldShape([])).toEqual({
      medianLen: 0, medianLeftWords: 0, maxLeftWords: 0, pipedShare: 0, count: 0, leftWordsFrom: 0,
      lenMin: 0, lenMax: 0, sepMix: { pipe: 0, comma: 0, plain: 0 }, tails: [],
      tailClass: { search: 0, brand: 0, specOnly: 0 }, garment: { twice: 0, once: 0 },
      audienceMix: { gendered: 0, inclusive: 0, none: 0 },
    })
  })
})

describe('goldSpecBlock — every sentence is a measurement', () => {
  const shape = measureGoldShape(SEED_GOLD_TITLES)
  const block = goldSpecBlock(SEED_GOLD_TITLES, shape)

  it('quotes the MEASURED numbers, so instruction and examples cannot disagree', () => {
    expect(block).toContain(`length ${shape.lenMin}-${shape.lenMax} characters, median ${shape.medianLen}`)
    expect(block).toContain(`never more than ${shape.maxLeftWords} (measured over ${shape.leftWordsFrom})`)
    for (const t of SEED_GOLD_TITLES) expect(block).toContain(t)
  })

  it('prints every shipped tail verbatim with the measured class counts — 0 spec-only', () => {
    expect(block).toContain('0 spec-only')
    for (const tail of shape.tails) expect(block).toContain(`| ${tail}`)
  })

  it('the vocabulary table is measured, not asserted: funny is THEIRS, crew neck is NOT', () => {
    expect(block).toMatch(/"funny" ×2/)
    expect(block).toMatch(/never once used:.*"crew neck"/)
    expect(block).toMatch(/never once used:.*"unisex"/)
  })

  it('does NOT hard-code the pipe as mandatory — the separator mix carries its denominator', () => {
    expect(block).toContain(`${shape.sepMix.pipe} of ${shape.count} use " | "`)
    expect(block).not.toMatch(/PATTERN A|Variant\/Attribute/)
  })

  it('empty corpus yields an empty block, not a headless instruction', () => {
    expect(goldSpecBlock([], measureGoldShape([]))).toBe('')
  })
})

describe('rejectPairBlock — genuine rejections only', () => {
  it('carries the seller verbatim words for every pair, and no pair fabricates a rejection', () => {
    const block = rejectPairBlock(SEED_REJECT_PAIRS)
    expect(block).toContain('crew neck can go on highlights')
    expect(block).toContain('STILL BAD')
    // The old alligator gold was REVISED into another gold, never rejected — listing it as a reject
    // would fabricate seller ground truth (caught by adversarial review before it shipped).
    expect(block).not.toContain('See You Later Alligator Shirt | Long Sleeve')
  })

  it('no pairs -> empty string, never a fabricated floor', () => {
    expect(rejectPairBlock([])).toBe('')
  })
})

describe('loadPoGoldTitles — fail-open', () => {
  it('no client ⇒ seed corpus, never empty', async () => {
    const r = await loadPoGoldTitles(null)
    expect(r.source).toBe('seed')
    expect(r.titles).toEqual([...SEED_GOLD_TITLES])
  })

  it('a DB error ⇒ seed corpus (the council must never lose its few-shots to a failed query)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const failing: any = { from: () => ({ select: () => ({ eq: () => ({ order: () => ({ limit: async () => ({ data: null, error: { message: 'boom' } }) }) }) }) }) }
    const r = await loadPoGoldTitles(failing)
    expect(r.source).toBe('seed')
    expect(r.titles.length).toBe(SEED_GOLD_TITLES.length)
  })

  it('real rows ⇒ db corpus, deduped, band-filtered, and the seeds always survive', async () => {
    const rows = [
      { recommended_title: 'THE CEO Later Gator Tee Shirt | Comfort Colors Alligator Tshirt for Women' },
      { recommended_title: 'THE CEO Later Gator Tee Shirt | Comfort Colors Alligator Tshirt for Women' }, // dupe
      { recommended_title: 'too short' },                                                                // band-filtered
      { recommended_title: 'x'.repeat(200) },                                                            // band-filtered
    ]
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ok: any = { from: () => ({ select: () => ({ eq: () => ({ order: () => ({ limit: async () => ({ data: rows, error: null }) }) }) }) }) }
    const r = await loadPoGoldTitles(ok)
    expect(r.source).toBe('db')
    // The DB row IS seed gold #5 verbatim — dedupe must keep exactly ONE copy of that string.
    // (Substring counting would be wrong here: seed gold #1 also says 'Later Gator' and is a
    // DIFFERENT title that must survive.)
    const exact = 'THE CEO Later Gator Tee Shirt | Comfort Colors Alligator Tshirt for Women'
    expect(r.titles.filter((t) => t === exact).length).toBe(1)                 // deduped
    expect(r.titles).not.toContain('too short')
    for (const s of SEED_GOLD_TITLES) expect(r.titles).toContain(s)            // seeds survive
  })

  it('respects the brief limit so the corpus cannot crowd out the design context', async () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({
      recommended_title: `THE CEO Design Number ${i} Tee Shirt | Comfort Colors Graphic Tee for Women`,
    }))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ok: any = { from: () => ({ select: () => ({ eq: () => ({ order: () => ({ limit: async () => ({ data: rows, error: null }) }) }) }) }) }
    const r = await loadPoGoldTitles(ok)
    expect(r.titles.length).toBeLessThanOrEqual(GOLD_BRIEF_LIMIT + SEED_GOLD_TITLES.length)
  })
})
