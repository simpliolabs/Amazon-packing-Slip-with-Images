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

/**
 * FIX ROUND 2 (2026-09-10, controller RULING on the opus review of Phase A -- phase-a-fix-
 * rulings.md I-1/I-2/I-3). Closes the net BEFORE the writer (Phase B) is built on it, per the
 * ruling: "the checks go in the NET, never in the writer" -- a check living in the producer is
 * bypassed by the next producer, which is the defect class this branch series exists to close.
 */
describe('I-3/R1 -- cross-clause composition binding (recombination escape, reviewer\'s exact repro)', () => {
  const blendSweatshirt: PhraseTruthCtx = {
    garmentFamily: 'sweatshirt',
    spec: { material: '52% Cotton 48% Polyester Blend', fit: 'Classic' },
    allowedBrand: null,
    audience: null,
    field: 'highlights',
  }

  it('a "%" marker in ONE clause and a fibre word in a DIFFERENT clause together assert the same lie a single clause would already catch -- now REFUSED, not ok:true', () => {
    const line = 'Cozy Crewneck Sweatshirt, Made With 100%, Combed Cotton Feel, Classic Fit'
    // Each clause ALONE is not a claim (the exact reviewer finding) -- proven here too, so a
    // regression that reverts to per-clause-only judging would show up as this sub-assertion
    // flipping back to ok:true instead of the whole-line assertion below.
    expect(phraseTruthVerdict('Made With 100%', blendSweatshirt)).toEqual({ ok: true })
    expect(phraseTruthVerdict('Combed Cotton Feel', blendSweatshirt)).toEqual({ ok: true })
    expect(ihLineTruthVerdict(line, blendSweatshirt)).toEqual({ ok: false, reason: 'material-lie' })
  })

  it('the identical marker+fibre pair in the SAME clause was already caught before this fix (rule (g), unchanged) -- the line-wide check is redundant there, not a new false-positive', () => {
    expect(phraseTruthVerdict('Made With 100% Cotton', blendSweatshirt)).toEqual({ ok: false, reason: 'material-lie' })
  })

  it('a TRUE cross-clause composition (blank genuinely is that fibre) still passes -- the fix is scoped to the LIE, not to any % anywhere near any fibre word', () => {
    const pureCottonSweatshirt: PhraseTruthCtx = { ...blendSweatshirt, spec: { ...blendSweatshirt.spec, material: '100% Cotton' } }
    const line = 'Cozy Crewneck Sweatshirt, Made With 100%, Combed Cotton Feel, Classic Fit'
    expect(ihLineTruthVerdict(line, pureCottonSweatshirt)).toEqual({ ok: true })
  })

  it('purity WORDS (ambiguous English, not "%") still need adjacency even line-wide -- a comma still breaks "All Season"/"Real Deal", never a new false-positive', () => {
    const line = 'All Season Layer, Combed Cotton Feel, Classic Fit'
    expect(ihLineTruthVerdict(line, blendSweatshirt)).toEqual({ ok: true })
  })
})

describe('I-3/R4 -- the design-token exemption no longer covers INFLECTED forms (recombination escape, reviewer\'s exact repro)', () => {
  const adultTeeGirlDad: PhraseTruthCtx = {
    garmentFamily: 'tee',
    spec: {},
    allowedBrand: null,
    audience: 'adult',
    designTokens: ['girl', 'dad'],
    field: 'highlights',
  }

  it('"Girls Graphic Tee" and "Graphic Tee for Girls" on an adult family whose designTokens include "girl" -- now REFUSED, not ok:true', () => {
    expect(phraseTruthVerdict('Girls Graphic Tee', adultTeeGirlDad)).toEqual({ ok: false, reason: 'audience-kids-on-adult' })
    expect(phraseTruthVerdict('Graphic Tee for Girls', adultTeeGirlDad)).toEqual({ ok: false, reason: 'audience-kids-on-adult' })
  })

  it('removing the design token still correctly rejects the SAME phrase (proves the exemption, not the rule itself, was the escape)', () => {
    expect(phraseTruthVerdict('Girls Graphic Tee', { ...adultTeeGirlDad, designTokens: [] })).toEqual({ ok: false, reason: 'audience-kids-on-adult' })
  })

  it('the LEGITIMATE "Girl Dad" identity still survives -- the fix narrows the escape, it does not remove the exemption. Production always stores ONE multi-word design-name string per design (listingPipeline.ts `designTokens: [g.designName]`), never two separate single-word entries -- that single-string shape is what carries the inflection exemption (contentTruthSpine.test.ts\'s own pin, re-asserted here)', () => {
    const girlDadOneToken: PhraseTruthCtx = { ...adultTeeGirlDad, designTokens: ['Girl Dad'] }
    expect(phraseTruthVerdict('girl dad shirt', girlDadOneToken)).toEqual({ ok: true })
    expect(phraseTruthVerdict('girls dad shirt', girlDadOneToken)).toEqual({ ok: true })
  })

  it('the SAME two words as SEPARATE single-word tokens (no shared multi-word phrase) get the STRICTEST reading -- exact match only, no inflection at all, since single-word tokens never fold (RULING: "a design token exempts the token it IS, not its derived forms")', () => {
    expect(phraseTruthVerdict('girls dad shirt', adultTeeGirlDad)).toEqual({ ok: false, reason: 'audience-kids-on-adult' })
    expect(phraseTruthVerdict('girl dad shirt', adultTeeGirlDad)).toEqual({ ok: true }) // exact match, no inflection needed
  })

  it('a SINGLE-WORD design token exempts ONLY its exact spelling -- "girl" alone (no sibling "dad" token) never exempts "girls"', () => {
    expect(phraseTruthVerdict('Girls Graphic Tee', { ...adultTeeGirlDad, designTokens: ['girl'] })).toEqual({ ok: false, reason: 'audience-kids-on-adult' })
    expect(phraseTruthVerdict('Girl Graphic Tee', { ...adultTeeGirlDad, designTokens: ['girl'] })).toEqual({ ok: true })
  })
})

describe('I-1 -- ONE floor predicate: the push seam and the per-child persist net now use the IDENTICAL scrub-crossing shape (source pin, the persist net closure is not directly unit-testable)', () => {
  const fs = require('node:fs')
  const path = require('node:path')
  const pipelineSrc = fs.readFileSync(path.join(process.cwd(), 'src/lib/fba/listingPipeline.ts'), 'utf8') as string
  const pushSeamSrc = fs.readFileSync(path.join(process.cwd(), 'src/lib/fba/productDetailAttrs.ts'), 'utf8') as string

  it('both seams gate on preScrubLen >= min && survivor.length < min -- never an unconditional survivor-only check', () => {
    const predicate = /preScrubLen >= CONTENT_CONTRACT\.itemHighlights\.min && \w+\.length < CONTENT_CONTRACT\.itemHighlights\.min/
    expect(pipelineSrc).toMatch(predicate)
    expect(pushSeamSrc).toMatch(predicate)
  })

  it('a 77-char, scrub-untouched, otherwise-compliant value clears the floor at the push seam (the exact reviewer repro -- the persist net now agrees by construction, same predicate above)', () => {
    const value = 'Graphic Crewneck Sweatshirt, Cozy Everyday Pullover Top, Soft Fleece, Classic'
    expect(value.length).toBe(77)
    const attr = { spApiKey: 'title_differentiation', scope: 'broadcast' as const }
    const [entry] = buildDetailPatchValue(attr, value, 'ATVPDKIKX0DER')
    expect(String(entry.value)).toBe(value)
  })
})

describe('I-2/F2, I-2/F3 -- capacityFamily/brandName threaded to the compose, persist and Regen sites (source pins -- the checker and the push seam can no longer structurally disagree)', () => {
  const fs = require('node:fs')
  const path = require('node:path')
  const pipelineSrc = fs.readFileSync(path.join(process.cwd(), 'src/lib/fba/listingPipeline.ts'), 'utf8') as string
  const routeSrc = fs.readFileSync(path.join(process.cwd(), 'src/app/api/fba/regenerate-item-highlight/route.ts'), 'utf8') as string

  it('the compose path threads capacityFamily/brandName into BOTH buildItemHighlightsPerDesign and buildItemHighlights (never left on the leaf default)', () => {
    expect(pipelineSrc).toMatch(/capacityFamily: capacityFamilyTokens\.length >= 2,\s*\n\s*brandName: input\.brandName,/g)
  })

  it('the Regen route resolves its own capacityFamily (deriveCapacityFamily off its own per-child SKU rows) and a real brandName, and threads both to every Item Highlight call', () => {
    expect(routeSrc).toMatch(/const capacityFamily = deriveCapacityFamily\(/)
    expect(routeSrc).toMatch(/const brandName = 'THE CEO'/)
    expect(routeSrc.match(/capacityFamily,\s*\n\s*brandName,/g)?.length).toBeGreaterThanOrEqual(2)
  })

  it('a real "128GB Storage Room" family family-wide capacity signal now refuses at the net level exactly like the checker (the reviewer\'s exact measured disagreement, closed)', () => {
    const line = 'Graphic Crewneck Sweatshirt, Cozy Everyday Pullover Top, 128GB Storage Room, Soft Brushed Fleece Lining'
    expect(ihContentRuleViolations(line, { capacityFamily: true })[0]?.reason).toBe('hardcoded-capacity')
    expect(capItemHighlightRepeats(line, { contentCtx: { capacityFamily: true } })).toEqual({ ok: false, reason: 'hardcoded-capacity' })
  })
})
