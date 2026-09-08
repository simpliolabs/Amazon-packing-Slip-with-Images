/**
 * itemHighlightContentRulesPhase2.test.ts — IH TERMINAL NET, PHASE 2 (2026-09-08, spec
 * docs/superpowers/specs/2026-09-07-item-highlight-terminal-net.md §2 Phase 2;
 * .superpowers/sdd/2026-09-07-ih-terminal-net/finish-line-rulings.md).
 *
 * REPRODUCED against the UNMODIFIED tree (`scratchpad/finish-b/repro-phase2-gap.ts`, before this
 * file's production edits): a line violating each of off-season / promo-pricing / hardcoded-
 * capacity / third-party-brand / sentence-shape was flagged by `validateItemHighlights` (the
 * checker route's ONLY caller) yet shipped byte-for-byte unchanged through `capItemHighlightRepeats`
 * AND the real `buildDetailPatchValue` SP-API PATCH body — the checker and the push boundary
 * disagreed. This file pins the fix: the SAME five rules now refuse on the push seam (Regen route +
 * compose path covered by `itemHighlightTerminalNet.test.ts`'s existing pins and this file's own
 * `capItemHighlightRepeats` cases), and `buildDetailPatchValue` now scrubs trademarks + celebrity
 * names — closing the "a refusal can bypass the single celebrity door" gap named in the ruling.
 *
 * Every fixture below is comma-shaped, non-repeating, and clears both the floor and the 125-char
 * cap ON ITS OWN axis (repeat/length) — so a refusal is attributable ONLY to the content rule under
 * test, never to H10/H11/H12's machinery (kept out of scope of this fix and re-verified unbroken by
 * `itemHighlightTerminalNet.test.ts`, which still passes unchanged).
 */
import { describe, it, expect } from 'vitest'
import { capItemHighlightRepeats, buildDetailPatchValue, ihContentRuleViolations, type DetailAttribute } from './productDetailAttrs'
import { validateItemHighlights } from './listingPipeline'
import { seasonsIn } from '../keyword-engine/seasonalTerms'

const IH_ATTR: DetailAttribute = { spApiKey: 'title_differentiation', scope: 'broadcast' }
const MP = 'ATVPDKIKX0DER'

describe('Phase 2 — the five moved rules now refuse at capItemHighlightRepeats (the ONE net every producer, the Regen route, and buildDetailPatchValue call)', () => {
  it('SENTENCE-SHAPE: a full sentence with no comma phrases refuses, never ships unchanged', () => {
    const line = 'This is a really great everyday tee that everyone in the whole family will love wearing.'
    expect(capItemHighlightRepeats(line)).toEqual({ ok: false, reason: 'sentence-shape' })
  })

  it('OFF-SEASON: a holiday that is NOT this design\'s own (designSeasons=[], the historical blanket default) refuses', () => {
    const line = 'Classic Christmas Tee, Soft Ring-Spun Cotton, Comfortable Crew Neck Fit, Great Gift Idea'
    expect(capItemHighlightRepeats(line)).toEqual({ ok: false, reason: 'off-season' })
  })

  it('OFF-SEASON, real context: the SAME holiday term on the design\'s OWN season ships fine (the Valentine false-positive this move must NOT introduce — seasonalTerms.ts\'s own "Valentine Not being in Descriptions" regression class)', () => {
    const line = 'Valentine Cupid Graphic, Soft Ring-Spun Cotton, Relaxed Unisex Fit, Great Gift for Her'
    const designSeasons = seasonsIn('THE CEO Valentine Cupid Tee | Cute Love Heart Shirt')
    expect(designSeasons).toContain('valentine')
    // Without real context, the blanket default WOULD wrongly refuse it — proving the risk is real,
    // not hypothetical, and that every compose-path/Regen-route call site MUST thread real context
    // (listingPipeline.ts's buildItemHighlights / buildItemHighlightsPerDesign persist net, blankSpecs.ts's
    // three ensureBlankBrandInHighlights callers, and the Regen route all do — see their own comments).
    expect(capItemHighlightRepeats(line)).toEqual({ ok: false, reason: 'off-season' })
    expect(capItemHighlightRepeats(line, { contentCtx: { designSeasons } })).toEqual({ ok: true, value: line })
  })

  it('PROMO/PRICING: "free" refuses', () => {
    const line = 'Amazing Cotton Tee, Free Shipping Included, Comfortable Crew Neck Fit, Great For Everyday'
    expect(capItemHighlightRepeats(line)).toEqual({ ok: false, reason: 'promo-pricing' })
  })

  it('HARDCODED CAPACITY: a storage-capacity token refuses ONLY when the caller says this SKU is a capacity family (capacityFamily defaults false — the net never guesses)', () => {
    const line = '128GB Memory Card, Fast Read Speed, Durable Build Quality, Great For Photography Storage'
    expect(capItemHighlightRepeats(line)).toEqual({ ok: true, value: line }) // default: unknown family, no guess
    expect(capItemHighlightRepeats(line, { contentCtx: { capacityFamily: true } })).toEqual({ ok: false, reason: 'hardcoded-capacity' })
  })

  it('THIRD-PARTY BRAND: a generic competitor brand token refuses (own-brand default "THE CEO" never exempts it)', () => {
    const line = 'Compatible With Canon Cameras, Soft Cotton Blend, Comfortable Fit For All, Great Gift For Fans'
    expect(capItemHighlightRepeats(line)).toEqual({ ok: false, reason: 'third-party-brand' })
  })

  it('THIRD-PARTY BRAND, real context: the seller\'s OWN brand name is exempted, never flagged as a third-party brand', () => {
    const line = 'Authentic THE CEO Graphic, Soft Ring-Spun Cotton, Relaxed Unisex Fit, Great Everyday Gift'
    expect(capItemHighlightRepeats(line, { contentCtx: { brandName: 'THE CEO' } })).toEqual({ ok: true, value: line })
  })
})

describe('Phase 2 — the SAME five rules now refuse at the ACTUAL push boundary (buildDetailPatchValue), not only in the checker route', () => {
  const cases: { name: string; line: string }[] = [
    { name: 'sentence-shape', line: 'This is a really great everyday tee that everyone in the whole family will love wearing.' },
    { name: 'off-season', line: 'Classic Christmas Tee, Soft Ring-Spun Cotton, Comfortable Crew Neck Fit, Great Gift Idea' },
    { name: 'promo-pricing', line: 'Amazing Cotton Tee, Free Shipping Included, Comfortable Crew Neck Fit, Great For Everyday' },
    { name: 'third-party-brand', line: 'Compatible With Canon Cameras, Soft Cotton Blend, Comfortable Fit For All, Great Gift For Fans' },
  ]
  for (const c of cases) {
    it(`${c.name}: buildDetailPatchValue returns [] (nothing to patch) — never ships this line to the real SP-API PATCH body`, () => {
      expect(buildDetailPatchValue(IH_ATTR, c.line, MP)).toEqual([])
    })
  }

  it('validateItemHighlights (the checker route) and buildDetailPatchValue (the push seam) now AGREE on every one of these — the "two rulebooks" defect this move closes', () => {
    for (const c of cases) {
      const problems = validateItemHighlights(c.line, 'THE CEO', false, [])
      expect(problems.length, `validateItemHighlights should flag: ${c.line}`).toBeGreaterThan(0)
      expect(buildDetailPatchValue(IH_ATTR, c.line, MP), `buildDetailPatchValue should refuse: ${c.line}`).toEqual([])
    }
  })
})

describe('Phase 2 — validateItemHighlights now CALLS the shared predicate, never re-implements it (spec adversary: "MOVE them (do not copy)")', () => {
  it('every problem message for the five moved rules is byte-identical to ihContentRuleViolations\' own message text', () => {
    const line = 'Classic Christmas Tee, Free Shipping Included, Compatible With Canon Cameras, Great Gift'
    const viaValidator = validateItemHighlights(line, 'THE CEO', false, [])
    const viaSharedPredicate = ihContentRuleViolations(line, { brandName: 'THE CEO', capacityFamily: false, designSeasons: [] }).map((v) => v.message)
    for (const msg of viaSharedPredicate) expect(viaValidator).toContain(msg)
  })
})

describe('Phase 2 — buildDetailPatchValue now scrubs trademarks + celebrity names at the ACTUAL push boundary (finish-line-rulings.md: "today they are generation-time only and a refusal can bypass the single celebrity door")', () => {
  it('a celebrity name surviving into a stored/hand-edited Item Highlight is stripped before the SP-API PATCH, never shipped verbatim', () => {
    const line = 'Messi Tribute Graphic, Soft Ring-Spun Cotton, Relaxed Unisex Fit, Great Everyday Gift'
    const patch = buildDetailPatchValue(IH_ATTR, line, MP)
    expect(patch.length).toBe(1)
    expect(String(patch[0].value).toLowerCase()).not.toMatch(/\bmessi\b/)
  })

  it('a trademark surviving into a stored/hand-edited Item Highlight is substituted before the SP-API PATCH', () => {
    const line = 'World Cup Fan Graphic, Soft Ring-Spun Cotton, Relaxed Unisex Fit, Great Everyday Gift'
    const patch = buildDetailPatchValue(IH_ATTR, line, MP)
    expect(patch.length).toBe(1)
    expect(String(patch[0].value).toLowerCase()).not.toContain('world cup')
  })

  it('a scrub that empties the WHOLE line falls through to [] (nothing to patch) — never [{value:""}], the exact BLOCKING 1 field-clearing defect this function exists to prevent', () => {
    // The entire line is nothing but a celebrity phrase — scrubCelebrityNames removes it whole,
    // and the tidy step can leave only punctuation/whitespace behind.
    const line = 'Messi'
    expect(buildDetailPatchValue(IH_ATTR, line, MP)).toEqual([])
  })
})
