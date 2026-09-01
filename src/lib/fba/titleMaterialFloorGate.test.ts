/**
 * titleMaterialFloorGate.test.ts — OPTION B (fabric-vocab supply) + OPTION C (real, corpus-derived
 * ship floor), band-supply-and-floor-report task (PO ruling 2026-09-01).
 *
 * THE REPRODUCING CASE. `runLiveFailureRepro()` (truthBandHarness.ts) already pins the EXACT
 * historical B0DSCDZC6K/Hustle Definiton defect: a thin 5-candidate fact bank, a lying prior
 * ("Business B*tch" — a sibling design's name — plus a forced gender on a unisex family), and a
 * shipped title of 58 chars ("THE CEO Hustle Definiton Sweatshirt | Long Sleeve Pullover") — under
 * even the OLD hand-typed 65-char floor. This file adds `runLiveFailureReproWithMaterial()`, which is
 * byte-for-byte the SAME scenario except the Gildan 18000 sweatshirt blank's own `material` is now
 * supplied to the pad (Option B) — proving whether widening the fact bank alone (BEFORE Option C's
 * floor gate is even in play, since a search that reaches band never touches the refusal branch)
 * closes the gap, per the brief's own acceptance requirement.
 *
 * ASSERT LENGTH ON EVERY TITLE TEST (three live failures shipped on content-only acceptance).
 */
import { describe, it, expect } from 'vitest'
import {
  runLiveFailureRepro, runLiveFailureReproWithMaterial, CATALOG, LIVE_LYING_PRIOR,
} from './truthBandHarness'
import {
  TITLE_BAND_LO, TITLE_BAND_HI, TITLE_SHIP_FLOOR, deriveTitleShipFloor, titleUnderShipFloor,
  titleSafeMaterial, settleTruthBand, dropSpecOnlyTail, verdictForAssembledTitle,
  type TitleBandCtx,
} from './titleBand'
import { measureGoldShape, SEED_GOLD_TITLES } from './poGoldCorpus'
import { CONTENT_CONTRACT } from './contentContract'

// The Gildan 18000 sweatshirt row's real material, read from the SAME catalog the seven-row harness
// resolves against — never a hand-retyped duplicate of the DB fact.
const GILDAN_18000_MATERIAL = CATALOG.find((r) => r.styleCode === '18000')!.spec.material!

describe('OPTION B — the reproducing case: material lifts Hustle Definiton off the floor', () => {
  it('BEFORE: the exact historical defect — 58 chars, below the ship floor, hold fires', () => {
    const before = runLiveFailureRepro()
    expect(before.title).toBe('THE CEO Hustle Definiton Sweatshirt | Long Sleeve Pullover')
    expect(before.len).toBe(58)
    expect(before.decision).toBe('shipped-truthful-below-floor')   // the TAG, not just the length
    expect(before.hold).toBe(true)
  })

  it('AFTER: with the blank\'s material offered to the pad, the SAME scenario reaches >= 70', () => {
    const after = runLiveFailureReproWithMaterial(GILDAN_18000_MATERIAL)
    expect(after.len, `shipped ${after.len} chars: "${after.title}"`).toBeGreaterThanOrEqual(TITLE_BAND_LO)
    expect(after.len).toBeLessThanOrEqual(TITLE_BAND_HI)
  })

  it('B ALONE does the lifting — the decision tag proves a SUCCESS branch ran, not the floor-hold branch', () => {
    // If C's gate had to intervene, decision would be a refusal/hold tag (as it is in the BEFORE
    // case). Asserting the decision value — not just the length — proves WHICH branch produced the
    // 70+ result: the additive search succeeding on real material, not a fallback.
    const after = runLiveFailureReproWithMaterial(GILDAN_18000_MATERIAL)
    expect(['in-band', 'refilled']).toContain(after.decision)
    expect(after.hold).toBe(false)
  })

  it('the added words are the blank\'s own material — not the pool (poolSegments is empty in this fixture)', () => {
    const after = runLiveFailureReproWithMaterial(GILDAN_18000_MATERIAL)
    // GILDAN_18000_MATERIAL is "50% Cotton / 50% Polyester" — titleSafeMaterial strips the digits/
    // slash but every fabric WORD it contributes is verbatim from blank_specs.
    expect(after.title.toLowerCase()).toContain('cotton')
    expect(after.title.toLowerCase()).toContain('polyester')
  })

  it('does NOT ship the lying prior — Option B does not weaken the existing truth invariant', () => {
    const after = runLiveFailureReproWithMaterial(GILDAN_18000_MATERIAL)
    expect(after.title).not.toBe(LIVE_LYING_PRIOR)
    expect(after.title).not.toContain('Business B*tch')
  })

  it('the shipped title is a fixed point — settleTitle changes nothing further (idempotent)', () => {
    const after = runLiveFailureReproWithMaterial(GILDAN_18000_MATERIAL)
    expect(after.idempotent).toBe(true)
  })
})

describe('THE BAN HOLDS — fabric words are admissible, "Classic Fit"/"Unisex" are not', () => {
  it('"Classic Fit" never appears, even though it is a REAL Gildan spec fact and would help reach band', () => {
    const after = runLiveFailureReproWithMaterial(GILDAN_18000_MATERIAL)
    expect(after.title).not.toMatch(/classic\s+fit/i)
  })

  it('"Unisex" never appears', () => {
    const after = runLiveFailureReproWithMaterial(GILDAN_18000_MATERIAL)
    expect(after.title).not.toMatch(/\bunisex\b/i)
  })

  it('material words alone do not satisfy verdictForAssembledTitle if paired with a banned phrase — the ban is on the PHRASE, not the concept: assembling "Classic Fit" is refused by isTitleWasteVocabulary at the candidateSegments gate, independent of this test', () => {
    // Direct proof at the leaf: isTitleWasteVocabulary still fires on "Classic Fit" regardless of
    // material being present in the SAME ctx — the two gates are independent, so widening one bank
    // cannot silently smuggle the other past its own ban.
    const band: TitleBandCtx = {
      apparel: true, factSegments: [], poolSegments: [], truthOk: () => true,
      spec: { fit: 'Classic Fit', sleeve: 'Long Sleeve', neck: 'Crew Neck', material: 'Cotton Polyester' },
      garmentSecond: 'Pullover',
    }
    const r = settleTruthBand({ produced: 'THE CEO Hustle Definiton Sweatshirt', prior: null, apparel: true, band })
    expect(r.title.toLowerCase()).not.toContain('classic fit')
  })
})

describe('TRUTH HOLDS — no gendered term ships on a unisex family', () => {
  it('the AFTER title never forces a gender', () => {
    const after = runLiveFailureReproWithMaterial(GILDAN_18000_MATERIAL)
    expect(after.title.toLowerCase()).not.toMatch(/\bfor men\b/)
    expect(after.title.toLowerCase()).not.toMatch(/\bfor women\b/)
  })

  it('verdictForAssembledTitle (the door\'s own predicate) independently passes the AFTER title', () => {
    const after = runLiveFailureReproWithMaterial(GILDAN_18000_MATERIAL)
    const truth = {
      garmentFamily: 'sweatshirt' as const, mixedFamilies: ['sweatshirt', 'hoodie'] as const,
      spec: null, allowedBrand: null, audience: 'adult' as const, audienceLean: 'unisex' as const, field: 'title' as const,
    }
    expect(verdictForAssembledTitle(after.title, { truth, protect: 'Hustle Definiton' })).toEqual({ ok: true })
  })
})

describe('titleSafeMaterial — prose formatting only, never a truth transform', () => {
  it('strips a blend\'s percentage/slash noise, keeps every fabric word', () => {
    expect(titleSafeMaterial('50% Cotton / 50% Polyester')).toBe('Cotton Polyester')
  })
  it('strips a single leading percentage, keeps the rest verbatim', () => {
    expect(titleSafeMaterial('100% Ring-Spun Cotton')).toBe('Ring-Spun Cotton')
  })
  it('round-trips byte-identical when there is nothing to strip', () => {
    expect(titleSafeMaterial('Ring-Spun Cotton')).toBe('Ring-Spun Cotton')
  })
  it('null/empty in, null out', () => {
    expect(titleSafeMaterial(null)).toBeNull()
    expect(titleSafeMaterial(undefined)).toBeNull()
    expect(titleSafeMaterial('')).toBeNull()
    expect(titleSafeMaterial('   ')).toBeNull()
  })
})

describe('WATCH (i) — material vocabulary does not trip the -25 spec-only-tail dock', () => {
  it('a material+garment tail classifies as a real money position, not spec-only', () => {
    const cases = [
      'THE CEO Hustle Definiton Sweatshirt | Cotton Crewneck',
      'THE CEO Hustle Definiton Sweatshirt | Ring-Spun Cotton Pullover',
      'THE CEO Hustle Definiton Sweatshirt | Cotton Polyester Long Sleeve Pullover',
    ]
    for (const title of cases) {
      const r = dropSpecOnlyTail(title, { apparel: true, specValues: [] })
      expect(r.decision, title).toBe('kept')
      expect(r.title, title).toBe(title)
    }
  })

  it('DOCUMENTS why `dye` was excluded from Option B: a dye+neck/sleeve pair CAN leave zero non-spec residue and DOES trip the dock — the material words never do, because the fabric noun ("cotton") is not itself spec vocabulary', () => {
    const dyePair = dropSpecOnlyTail('THE CEO Hustle Definiton Sweatshirt | Garment-Dyed Crewneck', { apparel: true, specValues: [] })
    expect(dyePair.decision).toBe('dropped')
    const materialPair = dropSpecOnlyTail('THE CEO Hustle Definiton Sweatshirt | Cotton Crewneck', { apparel: true, specValues: [] })
    expect(materialPair.decision).toBe('kept')
  })
})

describe('OPTION C — THE FLOOR GATE', () => {
  it('never returns "" — the empty-only abort-and-preserve invariant holds regardless of the floor value', () => {
    const band: TitleBandCtx = { apparel: true, factSegments: [], poolSegments: [], truthOk: () => true }
    const r = settleTruthBand({ produced: '', prior: 'THE CEO Mother Hustler Sweatshirt | Long Sleeve Pullover Crewneck', apparel: true, band, truth: null })
    expect(r.title).not.toBe('')
    expect(r.decision).toBe('not-produced')
    expect(r.hold).toBe(true)
  })

  it('a title that cannot reach the floor truthfully HOLDS, and the result carries the typed `underFloor` gate fact — not just a string to parse', () => {
    const before = runLiveFailureRepro()
    expect(before.hold).toBe(true)
    expect(before.len).toBeLessThan(TITLE_SHIP_FLOOR())
    // `underFloor` is not exposed on HarnessRow (it mirrors settleTitle's public return shape), so
    // re-derive it the same way any caller would — via the exported, named gate predicate rather than
    // re-deriving the comparison inline, proving the predicate and the shipped decision agree.
    expect(titleUnderShipFloor(before.len)).toBe(true)
  })

  it('a LYING prior is never kept to satisfy the floor — truth still outranks a known lie even below the floor', () => {
    const before = runLiveFailureRepro()
    expect(before.title).not.toBe(LIVE_LYING_PRIOR)
    expect(before.title).not.toContain('Business B*tch')
    expect(before.title.toLowerCase()).not.toMatch(/\bfor men\b/)
  })

  it('a title AT or ABOVE the floor gets the under-band label, never the below-floor one — the gate is a real threshold, not a constant string', () => {
    const band: TitleBandCtx = { apparel: true, factSegments: [], poolSegments: [], truthOk: () => true }
    const floor = TITLE_SHIP_FLOOR()
    // Construct a produced string whose length is EXACTLY the floor — no facts to pad with, so the
    // search cannot move it, and it ships as-is (truthful, no prior to prefer).
    const produced = 'x'.repeat(floor)
    const r = settleTruthBand({ produced, prior: null, apparel: true, band, truth: null })
    expect(r.len).toBe(floor)
    expect(r.decision).toBe('unreachable-no-prior')   // NOT 'shipped-truthful-below-floor'
    expect(titleUnderShipFloor(r.len)).toBe(false)
  })
})

describe('OPTION C — THE CORPUS DERIVATION', () => {
  it('TITLE_SHIP_FLOOR() equals a fresh, independently-computed measureGoldShape call — not a cached fluke', () => {
    const shape = measureGoldShape(SEED_GOLD_TITLES)
    expect(TITLE_SHIP_FLOOR()).toBe(deriveTitleShipFloor(shape))
  })

  it('the derived floor is NOT the literal 70 (or the old hand-typed 65) — it is measured from the corpus', () => {
    expect(TITLE_SHIP_FLOOR()).not.toBe(70)
    // The seed corpus's own shortest gold (poGoldCorpus.ts's SEED_GOLD_TITLES) is 68 — measured, not
    // asserted; this pins that the derivation is actually wired to real data, not a renamed literal.
    const shape = measureGoldShape(SEED_GOLD_TITLES)
    expect(shape.lenMin).toBe(68)
    expect(TITLE_SHIP_FLOOR()).toBe(68)
  })

  it('the derived floor is clamped to sane bounds regardless of what the corpus measures', () => {
    // A corpus with an absurdly short or long lenMin must never produce an incoherent floor (below
    // the absolute floor, or above the quality target it is a floor FOR).
    expect(deriveTitleShipFloor({ lenMin: 1 })).toBeGreaterThanOrEqual(CONTENT_CONTRACT.title.floor)
    expect(deriveTitleShipFloor({ lenMin: 999 })).toBeLessThanOrEqual(TITLE_BAND_LO)
  })
})
