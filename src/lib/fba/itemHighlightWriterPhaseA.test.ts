/**
 * itemHighlightWriterPhaseA.test.ts — proves the Phase A fixes (2026-09-10, redoing the reverted
 * feat/ih-phase23-wip @ c466225 with its three named design errors closed by construction), per
 * docs/superpowers/specs/2026-09-10-item-highlight-writer.md §2 Phase A and the opus review
 * (finish-final-review.md) that reverted the original attempt.
 */
import { describe, it, expect } from 'vitest'
import { phraseTruthVerdict, ihLineTruthVerdict, type PhraseTruthCtx } from './contentTruth'
import { buildDetailPatchValue, capItemHighlightRepeats, ihContentRuleViolations } from './productDetailAttrs'
import { CONTENT_CONTRACT } from './contentContract'

const blendCtx: PhraseTruthCtx = {
  garmentFamily: 'tee',
  spec: { weightNote: undefined, fit: undefined, sleeve: undefined, neck: undefined, material: '52% Cotton 48% Polyester Blend', unisex: undefined },
  allowedBrand: null,
  audience: null,
  field: 'highlights',
}
const pureCottonCtx: PhraseTruthCtx = { ...blendCtx, spec: { ...blendCtx.spec, material: '100% Cotton' } }

describe('material-lie (BLOCKING 1 closed): marked and unmarked spellings of the SAME claim get the SAME verdict', () => {
  it('on a 52/48 BLEND blank, BOTH "100% Cotton" (marked) and "Pure Cotton" (unmarked) are rejected', () => {
    expect(phraseTruthVerdict('100% Cotton', blendCtx)).toEqual({ ok: false, reason: 'material-lie' })
    expect(phraseTruthVerdict('Pure Cotton', blendCtx)).toEqual({ ok: false, reason: 'material-lie' })
  })

  it('the exact live F14 pair from the finish-final-review reproduction disagree no longer', () => {
    const marked = phraseTruthVerdict('100% Combed Ringspun Cotton Tees', blendCtx)
    const unmarked = phraseTruthVerdict('Pure Cotton Graphic Shirts Men', blendCtx)
    expect(marked.ok).toBe(false)
    expect(unmarked).toEqual(marked)
  })

  it('on a genuinely PURE COTTON blank, both spellings are TRUE', () => {
    expect(phraseTruthVerdict('100% Cotton', pureCottonCtx)).toEqual({ ok: true })
    expect(phraseTruthVerdict('Pure Cotton', pureCottonCtx)).toEqual({ ok: true })
  })

  it('what it catches: pure/all/solid/genuine/real ADJACENT to a fibre word, and 100 percent spelled out', () => {
    for (const phrase of ['Pure Cotton', 'All Cotton Tee', 'All-Cotton Comfort', 'Solid Cotton Construction', 'Genuine Cotton', 'Real Cotton', '100 Percent Cotton', 'One Hundred Percent Cotton']) {
      expect(phraseTruthVerdict(phrase, blendCtx), phrase).toEqual({ ok: false, reason: 'material-lie' })
    }
  })

  it('what it does NOT catch, on purpose: a purity word separated from the fibre word by another word (not adjacent)', () => {
    // "all" describes "season", not "cotton" -- not a claim, must pass even on a blend blank.
    expect(phraseTruthVerdict('All Season Cotton Tee', blendCtx)).toEqual({ ok: true })
  })

  it('what it does NOT catch, on purpose: a bare fibre word with no marker at all is ordinary vocabulary', () => {
    expect(phraseTruthVerdict('Soft Cotton Tee', blendCtx)).toEqual({ ok: true })
  })

  it('what it does NOT catch, on purpose: purity word and fibre word in DIFFERENT comma clauses', () => {
    expect(phraseTruthVerdict('Pure, Cotton Tee', blendCtx)).toEqual({ ok: true })
  })
})

describe('ihLineTruthVerdict (the line-level, segment-not-token truth net)', () => {
  it('judges each comma segment independently, so a lie in the SECOND segment is caught even though the first is true', () => {
    const line = 'Graphic Print Tee, Pure Cotton Fabric, Bold Statement Print'
    expect(ihLineTruthVerdict(line, blendCtx)).toEqual({ ok: false, reason: 'material-lie' })
  })

  it('a fully true line passes', () => {
    const line = 'Graphic Print Tee, Bold Statement Print, Everyday Wear'
    expect(ihLineTruthVerdict(line, blendCtx)).toEqual({ ok: true })
  })
})

describe('IH TERMINAL NET PHASE A wiring: capItemHighlightRepeats runs the moved rules + injected truth check', () => {
  it('a promo-pricing line is refused even with NO contentCtx passed (no signal needed for this rule)', () => {
    const r = capItemHighlightRepeats('Graphic Crewneck, Free Shipping Included, Bold Print, Everyday Wear')
    expect(r).toEqual({ ok: false, reason: 'promo-pricing' })
  })

  it('off-season is SKIPPED when designSeasons is omitted (undefined, not []) -- BLOCKING 3 contract', () => {
    const line = 'Valentines Day Shirts Women, Romantic Novelty Apparel, Pink Statement Tops, Anniversary Gift Clothing, Cotton Tee'
    expect(capItemHighlightRepeats(line)).toEqual({ ok: true, value: line })
  })

  it('off-season FIRES when designSeasons is explicitly [] (resolved: no occasion)', () => {
    const line = 'Valentines Day Shirts Women, Romantic Novelty Apparel, Pink Statement Tops, Anniversary Gift Clothing, Cotton Tee'
    expect(capItemHighlightRepeats(line, { contentCtx: { designSeasons: [] } })).toEqual({ ok: false, reason: 'off-season' })
  })

  it('off-season is SILENT when the real occasion is passed (a true Valentine line ships)', () => {
    const line = 'Valentines Day Shirts Women, Romantic Novelty Apparel, Pink Statement Tops, Anniversary Gift Clothing, Cotton Tee'
    expect(capItemHighlightRepeats(line, { contentCtx: { designSeasons: ['valentine'] } })).toEqual({ ok: true, value: line })
  })

  it('an injected truthCheck (material-lie via ihLineTruthVerdict) refuses the final joined bytes', () => {
    const line = 'Graphic Print Tee, Pure Cotton Fabric, Bold Statement Print, Everyday Layering Piece'
    const r = capItemHighlightRepeats(line, { truthCheck: (l) => ihLineTruthVerdict(l, blendCtx) })
    expect(r).toEqual({ ok: false, reason: 'material-lie' })
  })

  it('ihContentRuleViolations and capItemHighlightRepeats can never drift -- same predicate, same verdict', () => {
    const line = 'Graphic Crewneck, Nike Style Print, Bold Statement, Everyday Wear'
    const violations = ihContentRuleViolations(line)
    expect(violations.map((v) => v.reason)).toContain('third-party-brand')
    expect(capItemHighlightRepeats(line)).toEqual({ ok: false, reason: 'third-party-brand' })
  })
})

describe('BLOCKING 2 closed: buildDetailPatchValue never ships a scrub-driven under-floor line', () => {
  const attr = { spApiKey: 'title_differentiation', scope: 'broadcast' as const }
  const MIN = CONTENT_CONTRACT.itemHighlights.min

  it('a line that CLEARS the floor pre-scrub, but drops under it once "Nike" is scrubbed out, is REFUSED (never a truncated/short PATCH body)', () => {
    const line = 'Nike Style Graphic Print, Comfort Colors Shirt, Relaxed Unisex Fit, Soft Cotton Feel, Everyday Wear'
    const preScrubLen = line.length
    expect(preScrubLen).toBeGreaterThanOrEqual(MIN)
    // Confirms the survivor really does land under the floor -- the mechanism this pin proves.
    expect(preScrubLen - 'Nike '.length).toBeLessThan(MIN)
    const patch = buildDetailPatchValue(attr, line, 'ATVPDKIKX0DER')
    expect(patch).toEqual([])
  })

  it('a similar phrase with NO brand token clears the floor and PUSHES normally (proves the refusal above is the scrub, not the content)', () => {
    const line = 'Graphic Print, Comfort Colors Shirt, Relaxed Unisex Fit, Soft Cotton Feel, Everyday Wear, Novelty Design'
    expect(line.length).toBeGreaterThanOrEqual(MIN)
    const patch = buildDetailPatchValue(attr, line, 'ATVPDKIKX0DER')
    expect(patch.length).toBe(1)
    expect(String(patch[0].value)).toBe(line)
  })

  it('a value that was ALREADY under the floor before any scrub (untouched by it) still passes through unflagged -- the fix is scoped to scrub-DRIVEN crossings only, never a blanket floor gate at this seam', () => {
    const shortValue = 'Graphic Crewneck, Bold Print'
    expect(shortValue.length).toBeLessThan(MIN)
    const patch = buildDetailPatchValue(attr, shortValue, 'ATVPDKIKX0DER')
    expect(patch.length).toBe(1)
    expect(String(patch[0].value)).toBe(shortValue)
  })
})

describe('BLOCKING 3 closed: buildDetailPatchValue never asserts a blanket designSeasons at the push seam', () => {
  const attr = { spApiKey: 'title_differentiation', scope: 'broadcast' as const }

  it('a genuinely on-season Valentine line PUSHES cleanly through the real push boundary (the exact live reproduction, now fixed)', () => {
    const line = 'Valentines Day Shirts Women, Romantic Novelty Apparel, Pink Statement Tops, Anniversary Gift Clothing, Cotton Tee'
    const patch = buildDetailPatchValue(attr, line, 'ATVPDKIKX0DER')
    expect(patch.length).toBe(1)
    expect(String(patch[0].value)).toBe(line)
  })
})
