/**
 * titleMaterialFloorGate.test.ts — MATERIAL IS BANNED FROM THE TITLE (revoking Option B of the
 * 2026-09-01 band-supply-and-floor ruling) + OPTION C (real, corpus-derived ship floor, UNCHANGED
 * and still live).
 *
 * PO RULING 2026-09-03, VERBATIM: "We do not Put material in Title!" — this revokes PR #658's
 * Option B outright. `TitleBandCtx.spec` (titleBand.ts) no longer even carries a `material` field;
 * `titleSafeMaterial()` and `truthBandHarness.ts`'s `runLiveFailureReproWithMaterial()` are DELETED.
 * `runLiveFailureRepro()` — the EXACT historical B0DSCDZC6K/Hustle Definiton defect (a thin
 * 5-candidate fact bank, a lying prior, shipped at 58 chars) — is the one still-live reproduction
 * below; this file now proves the negative (material can never reach the pad, structurally) and
 * that removing it did NOT recreate the #630/#631 "subtractive net, no additive producer" collapse
 * — the pre-existing, truth-gated POOL bank (theme/occasion vocabulary from the listing's own
 * researched keywords) fills the same slot material used to occupy.
 *
 * ASSERT LENGTH ON EVERY TITLE TEST (three live failures shipped on content-only acceptance).
 */
import { describe, it, expect } from 'vitest'
import {
  runLiveFailureRepro, CATALOG, LIVE_LYING_PRIOR,
} from './truthBandHarness'
import {
  TITLE_BAND_LO, TITLE_BAND_HI, TITLE_SHIP_FLOOR, deriveTitleShipFloor, titleUnderShipFloor,
  settleTruthBand, dropSpecOnlyTail, verdictForAssembledTitle,
  type TitleBandCtx,
} from './titleBand'
import { measureGoldShape, SEED_GOLD_TITLES } from './poGoldCorpus'
import { CONTENT_CONTRACT } from './contentContract'

describe('THE STRUCTURAL BAN — TitleBandCtx.spec has no material field to populate', () => {
  it('the Gildan 18000 sweatshirt row STILL states a real material fact in BLANK_SPECS (bullets/description/Product-Detail prose are untouched) — the ban is TITLE-ONLY', () => {
    const row = CATALOG.find((r) => r.styleCode === '18000')!
    expect(row.spec.material).toBe('50% Cotton / 50% Polyester')
  })

  it('a TitleBandCtx literal cannot compile with a `material` key on `spec` — the ban is structural (a removed field), not a value the caller chooses to omit', () => {
    const band: TitleBandCtx = {
      apparel: true, factSegments: [], poolSegments: [], truthOk: () => true,
      // @ts-expect-error — `spec.material` was REMOVED from TitleBandCtx's type (titleBand.ts,
      // PO ruling 2026-09-03). If this line ever stops erroring, the type regressed and material
      // can be silently re-wired into the title pad again.
      spec: { fit: 'Classic Fit', sleeve: 'Long Sleeve', neck: 'Crew Neck', material: 'Cotton Polyester' },
      garmentSecond: 'Pullover',
    }
    // The ts-expect-error above is the real assertion; this just keeps the object used so eslint
    // doesn't flag it as dead code.
    expect(band.spec?.sleeve).toBe('Long Sleeve')
  })
})

describe('THE REPRODUCING CASE, STILL LIVE — a thin fact bank with no material candidate', () => {
  it('the exact historical defect — 58 chars, below the ship floor, hold fires (unchanged by the material revocation: this fixture never offered material)', () => {
    const before = runLiveFailureRepro()
    expect(before.title).toBe('THE CEO Hustle Definiton Sweatshirt | Long Sleeve Pullover')
    expect(before.len).toBe(58)
    expect(before.decision).toBe('shipped-truthful-below-floor')
    expect(before.hold).toBe(true)
  })
})

describe('THE ADDITIVE REPLACEMENT — the pre-existing pool bank fills the gap material used to fill, from THEME/OCCASION vocabulary, never a fabric word', () => {
  const bandCtx = (poolSegments: string[]): TitleBandCtx => ({
    apparel: true,
    factSegments: ['Long Sleeve', 'Crew Neck'],   // the SAME true blank facts runLiveFailureRepro() offers — no material
    poolSegments,                                  // theme/occasion phrases from the listing's OWN researched pool
    truthOk: () => true,
    spec: { fit: null, sleeve: 'Long Sleeve', neck: 'Crew Neck' },
    garmentSecond: 'Pullover',
  })

  it('AFTER: with on-theme/occasion pool phrases offered (never material), the same thin-fact-bank scenario reaches the 70-75 band', () => {
    const r = settleTruthBand({
      produced: 'THE CEO Hustle Definiton Sweatshirt',
      prior: null,
      apparel: true,
      band: bandCtx(['Motivational', 'Gift']),
      truth: null,
    })
    expect(r.len, `shipped ${r.len} chars: "${r.title}"`).toBeGreaterThanOrEqual(TITLE_BAND_LO)
    expect(r.len).toBeLessThanOrEqual(TITLE_BAND_HI)
    expect(['in-band', 'refilled']).toContain(r.decision)
    expect(r.hold).toBe(false)
  })

  it('the filled words are THEME/OCCASION pool vocabulary, not a fabric word — proves the branch that ran, not merely a string\'s absence', () => {
    const r = settleTruthBand({
      produced: 'THE CEO Hustle Definiton Sweatshirt',
      prior: null,
      apparel: true,
      band: bandCtx(['Motivational', 'Gift']),
      truth: null,
    })
    expect(r.title).toMatch(/\bMotivational\b|\bGift\b/)
    expect(r.title.toLowerCase()).not.toMatch(/\b(cotton|polyester|ring[\s-]?spun|fleece)\b/)
  })

  it('a design whose researched pool carries NO theme/occasion phrase legitimately ships SHORTER than one whose pool does — the gap is reported honestly (never in-band), never papered over with an invented value', () => {
    const withTheme = settleTruthBand({
      produced: 'THE CEO Hustle Definiton Sweatshirt', prior: null, apparel: true,
      band: bandCtx(['Motivational', 'Gift']), truth: null,
    })
    const withoutTheme = settleTruthBand({
      produced: 'THE CEO Hustle Definiton Sweatshirt', prior: null, apparel: true,
      band: bandCtx([]),   // empty pool — nothing on-theme was researched for this design
      truth: null,
    })
    // The pool phrases are what closed the gap: remove them and the SAME scenario ships shorter.
    expect(withoutTheme.len).toBeLessThan(withTheme.len)
    // Never fabricated into "in-band" — an honest short title, not an invented value.
    expect(withoutTheme.decision).not.toBe('in-band')
    expect(withoutTheme.title.toLowerCase()).not.toMatch(/\b(cotton|polyester|ring[\s-]?spun|fleece)\b/)
  })
})

describe('THE BAN HOLDS — "Classic Fit"/"Unisex" stay banned exactly as before (material\'s removal did not touch this gate)', () => {
  it('"Classic Fit" never appears, even when a pool phrase alone would otherwise reach band', () => {
    const band: TitleBandCtx = {
      apparel: true, factSegments: [], poolSegments: ['Motivational', 'Classic Fit', 'Unisex'], truthOk: () => true,
      spec: { fit: 'Classic Fit', sleeve: 'Long Sleeve', neck: 'Crew Neck' },
      garmentSecond: 'Pullover',
    }
    const r = settleTruthBand({ produced: 'THE CEO Hustle Definiton Sweatshirt', prior: null, apparel: true, band, truth: null })
    expect(r.title).not.toMatch(/classic\s+fit/i)
    expect(r.title).not.toMatch(/\bunisex\b/i)
  })
})

describe('TRUTH HOLDS — no gendered term ships on a unisex family, and a lying prior is never kept to satisfy the floor', () => {
  it('a LYING prior is never kept to satisfy the floor — truth still outranks a known lie even below the floor', () => {
    const before = runLiveFailureRepro()
    expect(before.title).not.toBe(LIVE_LYING_PRIOR)
    expect(before.title).not.toContain('Business B*tch')
    expect(before.title.toLowerCase()).not.toMatch(/\bfor men\b/)
  })

  it('verdictForAssembledTitle (the door\'s own predicate) independently passes a pool-filled AFTER title', () => {
    const band: TitleBandCtx = {
      apparel: true, factSegments: ['Long Sleeve', 'Crew Neck'], poolSegments: ['Motivational', 'Gift'], truthOk: () => true,
      spec: { fit: null, sleeve: 'Long Sleeve', neck: 'Crew Neck' },
      garmentSecond: 'Pullover',
    }
    const r = settleTruthBand({ produced: 'THE CEO Hustle Definiton Sweatshirt', prior: null, apparel: true, band, truth: null })
    const truth = {
      garmentFamily: 'sweatshirt' as const, mixedFamilies: ['sweatshirt', 'hoodie'] as const,
      spec: null, allowedBrand: null, audience: 'adult' as const, audienceLean: 'unisex' as const, field: 'title' as const,
    }
    expect(verdictForAssembledTitle(r.title, { truth, protect: 'Hustle Definiton' })).toEqual({ ok: true })
  })
})

describe('dropSpecOnlyTail — a general spec-only-tail dock, exercised independent of the title-pad wiring', () => {
  it('a garment-noun tail (from ANY source — pool phrase, prior copy) classifies as a real money position, not spec-only', () => {
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

  it('a dye+neck/sleeve pair CAN leave zero non-spec residue and DOES trip the dock — unrelated to the material-in-title ban, this is the pre-existing dye-vs-material asymmetry', () => {
    const dyePair = dropSpecOnlyTail('THE CEO Hustle Definiton Sweatshirt | Garment-Dyed Crewneck', { apparel: true, specValues: [] })
    expect(dyePair.decision).toBe('dropped')
    const materialPair = dropSpecOnlyTail('THE CEO Hustle Definiton Sweatshirt | Cotton Crewneck', { apparel: true, specValues: [] })
    expect(materialPair.decision).toBe('kept')
  })
})

describe('OPTION C — THE FLOOR GATE (unchanged by the material revocation)', () => {
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
    expect(titleUnderShipFloor(before.len)).toBe(true)
  })

  it('a title AT or ABOVE the floor gets the under-band label, never the below-floor one — the gate is a real threshold, not a constant string', () => {
    const band: TitleBandCtx = { apparel: true, factSegments: [], poolSegments: [], truthOk: () => true }
    const floor = TITLE_SHIP_FLOOR()
    const produced = 'x'.repeat(floor)
    const r = settleTruthBand({ produced, prior: null, apparel: true, band, truth: null })
    expect(r.len).toBe(floor)
    expect(r.decision).toBe('unreachable-no-prior')
    expect(titleUnderShipFloor(r.len)).toBe(false)
  })
})

describe('OPTION C — THE CORPUS DERIVATION (unchanged by the material revocation)', () => {
  it('TITLE_SHIP_FLOOR() equals a fresh, independently-computed measureGoldShape call — not a cached fluke', () => {
    const shape = measureGoldShape(SEED_GOLD_TITLES)
    expect(TITLE_SHIP_FLOOR()).toBe(deriveTitleShipFloor(shape))
  })

  it('the derived floor is NOT the literal 70 (or the old hand-typed 65) — it is measured from the corpus', () => {
    expect(TITLE_SHIP_FLOOR()).not.toBe(70)
    const shape = measureGoldShape(SEED_GOLD_TITLES)
    expect(shape.lenMin).toBe(68)
    expect(TITLE_SHIP_FLOOR()).toBe(68)
  })

  it('the derived floor is clamped to sane bounds regardless of what the corpus measures', () => {
    expect(deriveTitleShipFloor({ lenMin: 1 })).toBeGreaterThanOrEqual(CONTENT_CONTRACT.title.floor)
    expect(deriveTitleShipFloor({ lenMin: 999 })).toBeLessThanOrEqual(TITLE_BAND_LO)
  })
})
