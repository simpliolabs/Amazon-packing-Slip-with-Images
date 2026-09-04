/**
 * inclusiveAudienceTruthCondition.test.ts — unit-level proof for the 2026-09-04 PO ruling, verbatim:
 * "you have Keywords From the Bank you Can Add - For Man And Wome[n]... Etc", widened mid-flight to
 * the general USE-CASE/AUDIENCE/THEME vocabulary class (second PO example: "Gift for Boss").
 *
 * TWO INDEPENDENT SEAMS carry this ruling, both covered here:
 *   (a) `titleBand.ts`'s `candidateSegments` — the deterministic pad — now offers a CONSTRUCTED
 *       "for Men [and/&/ ]Women" fact when `ctx.lean === 'unisex'`. This is a restatement of the
 *       family's own declared `audience_lean`, not a market phrase, so it does not depend on the
 *       pool at all.
 *   (b) `listingPipeline.ts`'s `titleQualityJudge` — the LLM-candidate scorer — no longer applies
 *       its corpus-frequency `-15` "0 of N seller golds carry it" dock to an inclusive phrase when
 *       `opts.lean === 'unisex'` (an explicit PO ruling outranks a corpus inference). Every OTHER
 *       lean value keeps the dock exactly as before (PO ruling 2026-08-09, SELLER_PROFILE §4:
 *       claiming both genders on a LEANED family is still reach-widening and wrong).
 *
 * NEITHER seam touches: the single-gender-on-unisex veto (`phraseTruthVerdict`'s
 * `audience-lean-lie` rule — "for Women" alone on a unisex family is still a lie), the garment-noun
 * truth net, or pool-sourced use-case/theme vocabulary's EXISTING admissibility (which this file
 * also proves was never gated by corpus-frequency in the deterministic pad — no code changed there,
 * see the last describe block).
 */
import { describe, it, expect, afterEach } from 'vitest'
import { titleQualityJudge } from './listingPipeline'
import { SEED_GOLD_TITLES, measureGoldShape } from './poGoldCorpus'
import { candidateFactCount, enforceTitleBand, enforceTitleTruthBand, type TitleBandCtx } from './titleBand'
import { phraseTruthVerdict, type PhraseTruthCtx } from './contentTruth'

const SHAPE = measureGoldShape(SEED_GOLD_TITLES)
afterEach(() => { delete process.env.TITLE_SHAPE_JUDGE })

const UNISEX_TRUTH: PhraseTruthCtx = {
  garmentFamily: 'sweatshirt', spec: null, allowedBrand: null, audience: null,
  designTokens: [], audienceLean: 'unisex', field: 'title',
}

// ─── (a) THE DETERMINISTIC PAD: candidateSegments constructs the fact ONLY on unisex ──────────────

describe('candidateSegments — constructed inclusive-audience fact is truth-conditioned on ctx.lean', () => {
  const baseCtx = (lean: TitleBandCtx['lean']): TitleBandCtx => ({
    apparel: true,
    garmentBrand: null,
    spec: { fit: null, sleeve: null, neck: null },
    garmentSecond: null,
    factSegments: [],
    poolSegments: [],
    lean,
  })
  const title = 'THE CEO Foo Bar Sweatshirt | Pullover'

  it('unisex: the pad offers "for Men and Women" and can, via the real multi-pass refill search, close a real band gap with it alone', () => {
    const ctx = baseCtx('unisex')
    const before = candidateFactCount(title, { ...ctx, lean: undefined })
    const after = candidateFactCount(title, ctx)
    expect(after, 'unisex must add candidate(s) beyond the undefined-lean baseline').toBeGreaterThan(before)
    // The 37-char fixture title is too short for a SINGLE-segment append to close (37 + ~19 < 70) —
    // proving instead through `enforceTitleTruthBand`, the REAL multi-pass search every per-child
    // title actually ships through (titleInclusiveAudienceFloorE2E.integration.test.ts drives this
    // same search end-to-end and gets an identical shape of result on the live B0DSCDZC6K fixture).
    const longer = 'THE CEO Foo Bar Motivational Graphic Sweatshirt | Pullover' // 60 chars
    const res = enforceTitleTruthBand({ produced: longer, prior: null, apparel: true, band: ctx, truth: UNISEX_TRUTH })
    expect(res.decision, JSON.stringify(res)).toBe('refilled')
    expect(res.len).toBeGreaterThanOrEqual(70)
    expect(res.len).toBeLessThanOrEqual(75)
    expect(res.title.toLowerCase()).toMatch(/\bmen\b.*\bwomen\b/)
  })

  it.each([
    ['lean_male', 'lean_male' as const],
    ['lean_female', 'lean_female' as const],
    ['male', 'male' as const],
    ['female', 'female' as const],
    ['undefined (unclassified)', undefined],
  ])('%s: the pad never offers the inclusive construct (candidate count unchanged from a no-lean baseline)', (_name, lean) => {
    const withLean = candidateFactCount(title, baseCtx(lean))
    const withUndefined = candidateFactCount(title, baseCtx(undefined))
    expect(withLean).toBe(withUndefined)
  })
})

// ─── (b) THE JUDGE: the -15 corpus-frequency dock is withdrawn ONLY on unisex ──────────────────────

describe('titleQualityJudge — the -15 "0 of N seller golds carry it" dock, table-driven over audience lean', () => {
  const TITLE = 'THE CEO Foo Tee | Shirt for Men and Women'
  const judge = (lean?: 'male' | 'female' | 'lean_male' | 'lean_female' | 'unisex') =>
    titleQualityJudge(TITLE, { brandName: 'THE CEO', maxLeftWords: SHAPE.maxLeftWords, shape: SHAPE, apparel: true, lean })

  it.each([
    ['unisex — the PO ruling: inclusive audience is TRUE, dock must not apply', 'unisex' as const, false],
    ['lean_male — reach-widening, still wrong, dock stays (PO 2026-08-09 §4, unaffected)', 'lean_male' as const, true],
    ['lean_female — reach-widening, still wrong, dock stays', 'lean_female' as const, true],
    ['male — reach-widening, still wrong, dock stays', 'male' as const, true],
    ['female — reach-widening, still wrong, dock stays', 'female' as const, true],
    ['undefined (unclassified family) — no PO ruling covers this case, dock stays (backward-compatible)', undefined, true],
  ])('%s', (_name, lean, dockApplies) => {
    const r = judge(lean)
    // PROVE THE BRANCH RAN — the dock's own `problems` string, not an inference from the score.
    const fired = r.problems.some((p) => p.includes('seller golds carry it'))
    expect(fired, JSON.stringify(r.problems)).toBe(dockApplies)
  })

  it('QUANTIFIED: the unisex score is exactly +15 over the otherwise-identical unclassified score', () => {
    // vs `undefined`, not `lean_male` — `lean_male` also trips the SEPARATE "audience 'for Men'
    // absent" AUDIENCE-WHEN-LEAN dock (-10, listingPipeline.ts, a few lines below this fix and
    // untouched by it) on THIS exact fixture title, since "for Men and Women" is explicitly carved
    // OUT of that dock's "for Men" match (SELLER_PROFILE §4's positive half is a DIFFERENT phrase
    // than the inclusive one). `undefined` never triggers that dock either, so it isolates exactly
    // the -15 dock this fix gates.
    const unisexScore = judge('unisex').score
    const unclassifiedScore = judge(undefined).score
    expect(unisexScore - unclassifiedScore).toBe(15)
  })
})

// ─── REGRESSION GUARD: single-gender-on-unisex stays a LIE, on both seams ──────────────────────────

describe('regression guard — a SINGLE-gender phrase on a unisex family is still vetoed everywhere', () => {
  it('phraseTruthVerdict: "for Women" alone on a unisex title is audience-lean-lie', () => {
    const ctx: PhraseTruthCtx = {
      garmentFamily: 'sweatshirt', spec: null, allowedBrand: null, audience: null,
      designTokens: [], audienceLean: 'unisex', field: 'title',
    }
    const verdict = phraseTruthVerdict('Sweatshirt for Women', ctx)
    expect(verdict).toEqual({ ok: false, reason: 'audience-lean-lie' })
    // The inclusive form of the SAME sentence is fine — proves the rule discriminates single- vs
    // dual-gender, not merely "contains a gender word".
    expect(phraseTruthVerdict('Sweatshirt for Men and Women', ctx)).toEqual({ ok: true })
  })

  it('candidateSegments: a single-gender pool phrase never ships on a unisex family, construct or not', () => {
    const ctx: TitleBandCtx = {
      apparel: true, garmentBrand: null, spec: { fit: null, sleeve: null, neck: null },
      garmentSecond: null, factSegments: [], poolSegments: ['Sweatshirt for Women'], lean: 'unisex',
    }
    const res = enforceTitleBand('THE CEO Foo Bar Sweatshirt | Pullover', ctx)
    expect(res.title.toLowerCase()).not.toMatch(/\bfor women\b/)
  })

  it('titleQualityJudge: the AUDIENCE-WHEN-LEAN dock for a single-gender-absent claim is untouched by this fix', () => {
    // "for Men" absent on a lean_male family still docks -10 -- a DIFFERENT dock than the one this
    // fix touches, proving the fix did not accidentally widen or remove it.
    const r = titleQualityJudge('THE CEO Foo Tee | Graphic Shirt', {
      brandName: 'THE CEO', maxLeftWords: SHAPE.maxLeftWords, shape: SHAPE, apparel: true, lean: 'lean_male',
    })
    expect(r.problems.some((p) => p.includes('audience "for Men" absent'))).toBe(true)
  })
})

// ─── THE WIDENED CLASS: use-case/theme pool vocabulary was NEVER corpus-frequency-gated ───────────

describe('use-case/theme vocabulary (PO example: "Gift for Boss") — confirms no code change was needed here', () => {
  it('a truthful, ungendered, noun-free theme phrase from the pool is ordinary admissible fill, on ANY lean', () => {
    // 66 chars, deliberately sized so "Gift" (+5) lands exactly in band while every inclusive-
    // audience variant (+13/+16/+18) overshoots the 75 cap and is skipped — isolating pool fill
    // from the new construct rather than letting the construct win the single-pass race on
    // `unisex` (both being simultaneously available on a real, longer title is fine; it is not
    // what this test is checking).
    const title = 'THE CEO Foo Bar Baz Qux Sweatshirt | Long Sleeve Pullover Crewneck'
    for (const lean of ['unisex', 'lean_male', 'lean_female', undefined] as const) {
      const ctx: TitleBandCtx = {
        apparel: true, garmentBrand: null, spec: { fit: null, sleeve: null, neck: null },
        garmentSecond: null, factSegments: [], poolSegments: ['Gift'], lean,
      }
      const res = enforceTitleBand(title, ctx)
      expect(res.decision, `lean=${lean}`).toBe('padded')
      expect(res.title, `lean=${lean}`).toContain('Gift')
    }
  })

  it('titleQualityJudge carries no corpus-frequency dock keyed to "gift"/theme vocabulary at all', () => {
    const withGift = titleQualityJudge('THE CEO Foo Tee | Motivational Graphic Shirt, Gift', {
      brandName: 'THE CEO', maxLeftWords: SHAPE.maxLeftWords, shape: SHAPE, apparel: true,
    })
    expect(withGift.problems.some((p) => p.toLowerCase().includes('gift'))).toBe(false)
  })
})
