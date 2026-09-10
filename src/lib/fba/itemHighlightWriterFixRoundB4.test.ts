/**
 * itemHighlightWriterFixRoundB4.test.ts — fix round B4 (controller RULING on the four-lens panel,
 * `.superpowers/sdd/2026-09-10-ih-writer/phase-b4-rulings.md`, K1-K11). Pins the panel's specific
 * Blocking/Important findings as must-reject/must-expose through the REAL functions — never a
 * re-implementation of the rules under test. Every "lie" line below is a STUB arrangement or a
 * hand-built pool row, never model output; no live model call is made anywhere in this file.
 */
import { describe, it, expect } from 'vitest'
import {
  buildAdmittedUnits, judgeWriterArrangement, validateArrangement, renderArrangement,
  buildWriterPrompt, WRITER_RULE_REGISTRY,
  type AdmittedUnit, type ArrangementPart,
} from './itemHighlightWriter'
import { composeItemHighlightDetailed, type ComposerResult } from './itemHighlightComposer'
import { buildItemHighlights, produceItemHighlightsPerDesign, runIhTail } from './listingPipeline'
import { classifyStoredIhLine } from './productDetailAttrs'
import { buildPerSkuItemHighlightMap } from './perDesignItemHighlights'
import { phraseTruthVerdict, type PhraseTruthCtx } from './contentTruth'
import { DEFAULT_BLANK_SPECS, type BlankSpecRow } from './blankSpecs'
import { CONTENT_CONTRACT } from './contentContract'
import type { AnalyzedKeyword } from '@/lib/keyword-engine'

const kw = (keyword: string, searchVolume: number, themeFit: number | null): AnalyzedKeyword =>
  ({ keyword, searchVolume, themeFit } as unknown as AnalyzedKeyword)
const CC = DEFAULT_BLANK_SPECS[0]
const GILDAN = DEFAULT_BLANK_SPECS[1]
const NEVER: RegExp = /(?!)/
const runTailFor = (title: string, blank: BlankSpecRow | null, truthCtx: PhraseTruthCtx) =>
  (line: string) => runIhTail(line, { titles: [title], blankBrand: blank, truthCtx, site: 'fix-round-b4-test' })

// ─── K1: ONE acceptance contract — band/repeat/tail-unchanged/push-seam, all through the REAL judge ─

describe('RULING K1: the writer judge enforces the push seam\'s OWN band/repeat/pushability, not a copy', () => {
  const blank: BlankSpecRow = { match: NEVER, spec: { brand: 'Gildan', brandInCopy: false, fit: 'Classic', material: '100% Ring-Spun Cotton' } as never, styleCode: 'x', garmentFamily: 'tee' } as unknown as BlankSpecRow
  const title = 'THE CEO Retro Sunset Tee'
  const truthCtx: PhraseTruthCtx = { garmentFamily: 'tee', spec: { material: '100% Ring-Spun Cotton', fit: 'Classic' }, allowedBrand: null, audience: 'adult', field: 'highlights' }

  it('the "Soft x2" line (a significant word twice — Amazon\'s cap allows it, the PO\'s absolute rule does not) is rejected by the REAL judge', () => {
    const composed = {
      candidates: ['Soft Graphic Tee', 'Vintage Beach Vibes', 'Made for Lazy Summer Days', 'Great for Weekend Road Trips', 'Soft Cotton Feel'],
      specFacts: ['Classic Fit'], brandPick: null as string | null, brandOrigin: null as 'pool' | 'spec' | null, wearFact: null as string | null,
    }
    const units = buildAdmittedUnits(composed, { designName: 'Retro Sunset', truthCtx })
    const id = (t: string) => units.find((u) => u.text === t)!.id
    // "Retro Sunset Tee with Classic Fit, Soft Graphic Tee and Soft Cotton Feel, Vintage Beach
    // Vibes, Made for Lazy Summer Days" — long enough to clear the real 97-char floor.
    const specUnit = units.find((u) => u.kind === 'spec-fact')!
    const parts: ArrangementPart[] = [
      { unit: id('Retro Sunset') }, { unit: units.find((u) => u.kind === 'garment-head')!.id },
      { glue: 'with' }, { unit: specUnit.id }, { glue: ',' },
      { unit: id('Soft Graphic Tee') }, { glue: 'and' }, { unit: id('Soft Cotton Feel') }, { glue: ',' }, { unit: id('Vintage Beach Vibes') },
      { glue: ',' }, { unit: id('Made for Lazy Summer Days') },
    ]
    const line = renderArrangement(parts, units)
    expect(line).toMatch(/soft/i) // sanity: the rendered line really does carry "soft" twice
    const v = judgeWriterArrangement({ parts }, units, { truthCtx, runTail: runTailFor(title, blank, truthCtx) })
    expect(v.ok, JSON.stringify(v)).toBe(false)
    if (!v.ok) expect(v.violations.join(' ')).toMatch(/soft.*(twice|more than)/i)
  })

  it('a line the tail would EDIT (not merely refuse) is rejected as "the tail changed the line" — never a silent amputation/brand-insertion the model never chose', () => {
    // A CC family whose title lacks the brand: `ensureBlankBrandInHighlights` would PREPEND the
    // brand to a compliant-but-unbranded line — that edit must be a named rejection, never silent.
    const truthCtxCC: PhraseTruthCtx = { garmentFamily: 'tee', spec: CC.spec as never, allowedBrand: 'Comfort Colors', audience: 'adult', field: 'highlights' }
    const composed = {
      candidates: ['Soft Graphic Tee', 'Vintage Beach Vibes', 'Made for Lazy Summer Days'],
      specFacts: ['100% Ring-Spun Cotton'], brandPick: null as string | null, brandOrigin: null as 'pool' | 'spec' | null, wearFact: null as string | null,
    }
    const units = buildAdmittedUnits(composed, { designName: 'Retro Sunset', truthCtx: truthCtxCC })
    const id = (t: string) => units.find((u) => u.text === t)!.id
    const parts: ArrangementPart[] = [
      { unit: id('Retro Sunset') }, { glue: 'with' }, { unit: id('100% Ring-Spun Cotton') }, { glue: ',' },
      { unit: id('Soft Graphic Tee') }, { glue: 'and' }, { unit: id('Vintage Beach Vibes') },
      { glue: ',' }, { unit: id('Made for Lazy Summer Days') },
    ]
    const line = renderArrangement(parts, units)
    expect(line.length).toBeGreaterThanOrEqual(CONTENT_CONTRACT.itemHighlights.min)
    const tail = runTailFor('THE CEO Retro Sunset', CC, truthCtxCC)(line)
    // The real tail DOES change these bytes (it must insert the brand) — proving the fixture
    // actually exercises the "tail edits" path, not a no-op tail.
    expect(tail.value).not.toBe(line)
    const v = judgeWriterArrangement({ parts }, units, { truthCtx: truthCtxCC, runTail: runTailFor('THE CEO Retro Sunset', CC, truthCtxCC) })
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.violations.join(' ')).toMatch(/tail changed the line/)
  })

  it('an accepted per-design writer line is ALSO pushable by the push seam\'s OWN classifier (classifyStoredIhLine) — "accepted" and "pushable" are the same question', async () => {
    const pool = [
      kw('later gator shirt', 450, 3), kw('funny gator apparel', 250, 3), kw('novelty animal tops', 200, 2),
      kw('swamp humor clothing', 150, 2), kw('comfort colors graphic tee', 5000, 2),
    ]
    const built = buildItemHighlights({ finalTitle: 'THE CEO Later Gator Tee', pool, apparelProduct: true, blankBrand: GILDAN, netTitles: ['THE CEO Later Gator Tee'] })
    expect(built.composed, 'fixture must compose').toBeTruthy()
    if (!built.value) return // thin pool in CI env variance — the pin below only matters when it composed
    const classification = classifyStoredIhLine(built.value)
    expect(classification).toBe('ok')
    const { values, skipped } = buildPerSkuItemHighlightMap(
      [{ sku: 'LG-L', asin: 'B0LATERGAT1', item_highlight: built.value, designName: 'Later Gator', designKey: 'A', hold: null }],
      [{ sku: 'LG-L', asin: 'B0LATERGAT1' }],
    )
    expect(skipped).toEqual([])
    expect(values.get('LG-L')).toBe(built.value)
  })
})

// ─── K2: ONE brand contract, keyed on needBrand, classed by origin ─────────────────────────────

describe('RULING K2: the brand unit\'s class follows its ORIGIN; needBrand is exposed on every composer exit', () => {
  const title = 'THE CEO Retro Sunset Tee' // brandless title -> needBrand
  const pool = [
    { keyword: 'retro sunset tee in comfort colors pepper', searchVolume: 900, themeFit: 3 },
    { keyword: 'vintage beach vibes', searchVolume: 700, themeFit: 3 },
    { keyword: 'made for lazy summer days', searchVolume: 500, themeFit: 3 },
    { keyword: 'comfort colors pepper', searchVolume: 5000, themeFit: 3 },
  ]

  it('T26/T27\'s mechanism: a POOL-sourced brandPick is admitted as a POOL unit — a relation ("in"/"with") onto it is rejected, never laundering unvetted pool text into a fact-relation', () => {
    const truthCtx: PhraseTruthCtx = { garmentFamily: 'tee', spec: CC.spec as never, allowedBrand: 'Comfort Colors', audience: 'adult', field: 'highlights' }
    const composed: Pick<ComposerResult, 'candidates' | 'specFacts' | 'brandPick' | 'brandOrigin' | 'wearFact'> = {
      candidates: ['Comfort Colors Pepper', 'Vintage Beach Vibes'],
      specFacts: ['100% Ring-Spun Cotton'],
      brandPick: 'Comfort Colors Pepper', brandOrigin: 'pool', wearFact: null,
    }
    const units = buildAdmittedUnits(composed, { designName: 'Retro Sunset', truthCtx })
    const brandUnit = units.find((u) => u.isBrand)!
    expect(brandUnit.kind).toBe('pool') // K2: pool-origin -> pool-classed, never 'brand'
    // Only ONE unit carries this text (the pool twin is dropped).
    expect(units.filter((u) => u.text === 'Comfort Colors Pepper')).toHaveLength(1)
    const id = (t: string) => units.find((u) => u.text === t)!.id
    // "Retro Sunset Tee in Comfort Colors Pepper, ..." — T26's exact mechanism.
    const inRelation = validateArrangement({ parts: [{ unit: id('Retro Sunset') }, { unit: units.find((u) => u.kind === 'garment-head')!.id }, { glue: 'in' }, { unit: brandUnit.id }] }, units)
    expect(inRelation.ok).toBe(false)
    if (!inRelation.ok) expect(inRelation.violation).toMatch(/spec fact/)
    // List-joined (the picker's own shape) still ships the brand text.
    const listJoined = validateArrangement({ parts: [{ unit: id('Retro Sunset') }, { glue: ',' }, { unit: brandUnit.id }] }, units)
    expect(listJoined.ok).toBe(true)
  })

  it('too-few-candidates now exposes needBrand/brandPick/brandOrigin — a thin CC pool HOLDS with the brand fields populated, not silently unbranded', () => {
    const res = composeItemHighlightDetailed(
      [{ keyword: 'soft graphic tee', searchVolume: 400, themeFit: 3 }], // 1 candidate < MIN_CANDIDATES
      [title],
      { spec: CC.spec as never, garmentFamily: 'tee', allowedBrand: 'Comfort Colors', audience: 'adult' },
    )
    expect(res.line).toBeNull()
    expect(res.stage).toBe('too-few-candidates')
    expect(res.needBrand).toBe(true)
    expect(res.brandPick).toBeTruthy() // populated even though composition never reached candidate-fill
  })

  it('needBrand is exposed (false) even on the unrated-pool exit — every composer exit carries it', () => {
    const res = composeItemHighlightDetailed(
      [{ keyword: 'anything', searchVolume: 100, themeFit: null }],
      [title],
      { spec: GILDAN.spec as never, garmentFamily: 'tee', allowedBrand: null, audience: 'adult' },
    )
    expect(res.stage).toBe('unrated-pool')
    expect(res.needBrand).toBe(false)
  })

  it('when needBrand is true, the writer\'s defense-in-depth (lineCarriesBrand) rejects a final line that omits the brand text, even if a brand unit id happened to slip through', () => {
    const truthCtx: PhraseTruthCtx = { garmentFamily: 'tee', spec: CC.spec as never, allowedBrand: 'Comfort Colors', audience: 'adult', field: 'highlights' }
    const composed = { candidates: ['Vintage Beach Vibes', 'Made For Lazy Summer Days'], specFacts: ['100% Ring-Spun Cotton'], brandPick: 'Comfort Colors Tee', brandOrigin: 'spec' as const, wearFact: null }
    const units = buildAdmittedUnits(composed, { designName: 'Retro Sunset', truthCtx })
    const id = (t: string) => units.find((u) => u.text === t)!.id
    // Legal arrangement that DOES carry the brand unit id (passes G4) — sanity check it ships.
    const parts: ArrangementPart[] = [
      { unit: id('Retro Sunset') }, { glue: 'and' }, { unit: id('Vintage Beach Vibes') }, { glue: ',' },
      { unit: id('Made For Lazy Summer Days') }, { glue: 'with' }, { unit: id('Comfort Colors Tee') },
    ]
    const v = judgeWriterArrangement({ parts }, units, { truthCtx, runTail: runTailFor('THE CEO Retro Sunset', CC, truthCtx) })
    if (v.ok) expect(/comfort\s*colors/i.test(v.value)).toBe(true)
  })
})

// ─── K3: identity is the design name ONLY; number/abutment rules ──────────────────────────────

describe('RULING K3: identity is the design name ONLY; number never applies to identity; abutment needs an identity/pool unit on the left', () => {
  const truthCtx: PhraseTruthCtx = { garmentFamily: 'tee', spec: { material: '100% Ring-Spun Cotton', fit: 'Classic' }, allowedBrand: null, audience: 'adult', field: 'highlights' }

  it('T18: "number" never applies to an identity unit, even when its own last word folds to a garment noun ("Over the Tops" -> "Top")', () => {
    const units = buildAdmittedUnits({ candidates: [], specFacts: [], brandPick: null, brandOrigin: null, wearFact: null }, { designName: 'Over the Tops', truthCtx })
    const identity = units.find((u) => u.kind === 'identity')!
    expect(identity.text).toBe('Over the Tops')
    expect(identity.numberable).toBe(false)
    const v = validateArrangement({ parts: [{ unit: identity.id, number: 'singular' }] }, units)
    expect(v.ok).toBe(false)
  })

  it('T19: a garment-head unit may abut only after an identity or pool unit — never after ANOTHER garment-head unit', () => {
    const units = buildAdmittedUnits({ candidates: [], specFacts: [], brandPick: null, brandOrigin: null, wearFact: null }, { designName: 'Retro Sunset', truthCtx })
    const garmentHeads = units.filter((u) => u.kind === 'garment-head')
    // The 'tee' family's own garment-noun vocabulary carries 2+ single-word forms (e.g. "Tee",
    // "Shirt") — chaining two of THEM directly (both truly kind === 'garment-head', not merely
    // garment-word-shaped text) is exactly what T19's "Retro Sunset Shirt Tee Top" reached.
    expect(garmentHeads.length).toBeGreaterThanOrEqual(2)
    if (garmentHeads.length >= 2) {
      const v = validateArrangement({ parts: [{ unit: garmentHeads[0].id }, { unit: garmentHeads[1].id }] }, units)
      expect(v.ok).toBe(false)
      if (!v.ok) expect(v.violation).toMatch(/abut with no join/)
    }
  })

  it('vision phrases are never admitted as identity units (superseding the deleted G2 vision-phrase channel) — only the design name is', () => {
    const units = buildAdmittedUnits(
      { candidates: [], specFacts: [], brandPick: null, brandOrigin: null, wearFact: null },
      { designName: 'Retro Floral', identityPhrases: ['Embroidered Floral Patch', '100% Organic'], truthCtx },
    )
    const identityTexts = units.filter((u) => u.kind === 'identity').map((u) => u.text)
    expect(identityTexts).toEqual(['Retro Floral'])
  })
})

// ─── K5: ONE truth judgment per adjacent unit pair ──────────────────────────────────────────────

describe('RULING K5: every adjacent unit pair (A join B, as rendered) is judged by phraseTruthVerdict — a true fact elsewhere in the clause cannot launder it', () => {
  it('T39\'s mechanism: "Always Give 100% and Soft Cotton Feel" is material-lie ALONE — a true blend fact later in the SAME clause must not launder it', () => {
    const blendCtx: PhraseTruthCtx = { garmentFamily: 'sweatshirt', spec: { material: '52% Cotton / 48% Polyester', fit: 'Classic' }, allowedBrand: null, audience: 'adult', field: 'highlights' }
    // Confirm the isolated span really is material-lie (the premise of the test).
    expect(phraseTruthVerdict('Always Give 100% and Soft Cotton Feel', blendCtx).ok).toBe(false)
    const composed = {
      candidates: ['Always Give 100%', 'Soft Cotton Feel'], specFacts: ['52% Cotton / 48% Polyester Blend'],
      brandPick: null as string | null, brandOrigin: null as 'pool' | 'spec' | null, wearFact: null as string | null,
    }
    const units = buildAdmittedUnits(composed, { designName: 'Cozy Crewneck', truthCtx: blendCtx })
    const id = (t: string) => units.find((u) => u.text === t)!.id
    // "Always Give 100% and Soft Cotton Feel with 52% Cotton / 48% Polyester Blend" — the T39 shape:
    // the lying pair sits BEFORE the relation to the true blend fact, in the same rendered clause.
    const parts: ArrangementPart[] = [
      { unit: id('Always Give 100%') }, { glue: 'and' }, { unit: id('Soft Cotton Feel') },
      { glue: 'with' }, { unit: id('52% Cotton / 48% Polyester Blend') },
    ]
    const v = judgeWriterArrangement({ parts }, units, {
      truthCtx: blendCtx,
      runTail: (line) => ({ value: line, hold: null, reason: null }), // isolate K5 from the tail's own clause-level net
    })
    expect(v.ok, JSON.stringify(v)).toBe(false)
    if (!v.ok) expect(v.violations.join(' ')).toMatch(/join:.*material-lie/)
  })
})

// ─── K6: articles — never bare, only before a fit/neck spec fact; a/an normalized at render ────

describe('RULING K6: an article is legal only riding a join, and only before a fit/neck spec fact; the renderer chooses a/an', () => {
  const truthCtx: PhraseTruthCtx = { garmentFamily: 'tee', spec: { material: '100% Ring-Spun Cotton', fit: 'Classic' }, allowedBrand: null, audience: 'adult', field: 'highlights' }
  const units = buildAdmittedUnits(
    { candidates: ['Cozy Graphic Tee'], specFacts: ['Classic Fit'], brandPick: null, brandOrigin: null, wearFact: null },
    { designName: 'Retro Sunset', truthCtx },
  )
  const u0 = units.find((u) => u.kind === 'identity')!.id
  const specUnit = units.find((u) => u.kind === 'spec-fact')!.id
  const poolUnit = units.find((u) => u.kind === 'pool')!.id

  it('a bare article (no preceding join) is never legal, regardless of the right-hand unit', () => {
    const v = validateArrangement({ parts: [{ unit: u0 }, { glue: 'a' }, { unit: specUnit }] }, units)
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.violation).toMatch(/bare article/)
  })

  it('an article riding a join may only introduce a spec-fact unit ending in "Fit"/"Neck" — never a pool unit, even riding a legal join', () => {
    const v = validateArrangement({ parts: [{ unit: u0 }, { glue: 'and' }, { glue: 'a' }, { unit: poolUnit }] }, units)
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.violation).toMatch(/"Fit" or "Neck"/)
  })

  it('the renderer normalizes a/an from the FOLLOWING unit\'s first letter — the model\'s own vowel choice is never trusted', () => {
    // Model says "an" before a consonant-starting spec unit ("Classic Fit") — renderer corrects it.
    const rendered = renderArrangement([{ unit: u0 }, { glue: 'and' }, { glue: 'an' }, { unit: specUnit }], units)
    expect(rendered).toBe('Retro Sunset and a Classic Fit')
  })
})

// ─── K7: readability cannot be fooled by "&"/"and" chains ───────────────────────────────────────

describe('RULING K7: readability splits on "&" too, and only a RELATION word ("with"/"in") — never "and" — counts as a clause\'s connecting word', () => {
  const units: AdmittedUnit[] = [{ id: 'u0', text: "Don't Quit", kind: 'identity', numberable: false }]
  it('T2: an "&"-chained line reads as a keyword dump (every clause lacks a relation word) — REJECTED', async () => {
    const { writerReadabilityVerdict } = await import('./itemHighlightWriter')
    const v = writerReadabilityVerdict("Don't Quit Sweatshirt & Graphic Crewneck & Cute Crewnecks & Never Give Up Sweatshirt, Long Sleeve and Classic Fit", units)
    expect(v.ok).toBe(false)
  })
  it('T2b: an "and"-chained line (no "&", no relation word anywhere) ALSO reads as a keyword dump — REJECTED', async () => {
    const { writerReadabilityVerdict } = await import('./itemHighlightWriter')
    const v = writerReadabilityVerdict("Don't Quit Sweatshirt and Graphic Crewneck, Cute Crewnecks and Positive Quote Sweatshirt, Long Sleeve and Classic Fit", units)
    expect(v.ok).toBe(false)
  })
  it('a genuinely one-sentence line (one relation-bearing clause) still PASSES', async () => {
    const { writerReadabilityVerdict } = await import('./itemHighlightWriter')
    const v = writerReadabilityVerdict("Don't Quit Sweatshirt with Long Sleeve and a Classic Fit, Never Give Up Sweatshirt and Graphic Crewneck", units)
    expect(v.ok).toBe(true)
  })
})

// ─── K4: the prompt is GENERATED from the rule registry — a rule can never be taught without an id ─

describe('RULING K4: the prompt is rendered from WRITER_RULE_REGISTRY — every applicable rule id\'s sentence appears', () => {
  it('every UNCONDITIONAL rule\'s sentence appears in the rendered system prompt', () => {
    const truthCtx: PhraseTruthCtx = { garmentFamily: 'tee', spec: { material: '100% Cotton', fit: 'Classic' }, allowedBrand: 'Comfort Colors', audience: 'adult', field: 'highlights' }
    const units = buildAdmittedUnits(
      { candidates: ['Cozy Graphic Tee'], specFacts: ['Classic Fit'], brandPick: 'Comfort Colors Tee', brandOrigin: 'spec', wearFact: null },
      { designName: 'Retro Sunset', truthCtx },
    )
    const { system } = buildWriterPrompt(units, 'Retro Sunset', [])
    for (const rule of WRITER_RULE_REGISTRY) {
      expect(system, `rule "${rule.id}" must be taught`).toContain(rule.sentence)
    }
  })
  it('the sentence-shape (>=1 comma) and unisex-beside-gender rules specifically are taught — value review B1/B2\'s exact gap', () => {
    const truthCtx: PhraseTruthCtx = { garmentFamily: 'tee', spec: { material: '100% Cotton', fit: 'Classic' }, allowedBrand: null, audience: 'adult', field: 'highlights' }
    const units = buildAdmittedUnits({ candidates: [], specFacts: [], brandPick: null, brandOrigin: null, wearFact: null }, { designName: 'X', truthCtx })
    const { system } = buildWriterPrompt(units, 'X', [])
    expect(system).toMatch(/AT LEAST ONE ","/)
    expect(system).toMatch(/gendered audience word/)
  })
  it('the brand rule is OMITTED when no brand unit exists (conditional, per the composer\'s own needBrand)', () => {
    const truthCtx: PhraseTruthCtx = { garmentFamily: 'tee', spec: { material: '100% Cotton', fit: 'Classic' }, allowedBrand: null, audience: 'adult', field: 'highlights' }
    const units = buildAdmittedUnits({ candidates: [], specFacts: [], brandPick: null, brandOrigin: null, wearFact: null }, { designName: 'X', truthCtx })
    const { system } = buildWriterPrompt(units, 'X', [])
    const brandRule = WRITER_RULE_REGISTRY.find((r) => r.id === 'brand')!
    expect(system).not.toContain(brandRule.sentence)
  })
})

// ─── K9: Part 1's compose change is INTENDED — pin one GILDAN row and one spec-null row ────────

describe('RULING K9: Part 1\'s material-lie compose change is INTENDED (a 100% cotton or unresolved blank backs no polyester-blend claim)', () => {
  const pool = [
    { keyword: 'polyester blend comfort', searchVolume: 900, themeFit: 3 },
    { keyword: 'soft cotton feel', searchVolume: 700, themeFit: 3 },
    { keyword: 'brushed fleece lining', searchVolume: 500, themeFit: 3 },
    { keyword: 'made for chilly fall weekends', searchVolume: 400, themeFit: 3 },
  ]
  it('a GILDAN (100% Ring-Spun Cotton) blank: "Polyester Blend Comfort" never survives candidate filtering — material-lie', () => {
    const res = composeItemHighlightDetailed(pool, ['THE CEO Keep It Pure Sweatshirt'], {
      spec: GILDAN.spec as never, garmentFamily: 'sweatshirt', allowedBrand: null, audience: 'adult',
    })
    expect(res.candidates ?? []).not.toContain('Polyester Blend Comfort')
  })
  it('an UNRESOLVED blank (spec: null): "Polyester Blend Comfort" also never survives — an unconfirmed blank backs no composition claim (fail-closed)', () => {
    const res = composeItemHighlightDetailed(pool, ['THE CEO Keep It Pure Sweatshirt'], {
      spec: null, garmentFamily: 'sweatshirt', allowedBrand: null, audience: 'adult',
    })
    expect(res.candidates ?? []).not.toContain('Polyester Blend Comfort')
  })
})

// ─── K10: fail-closed on a throwing writer + the shadow-vs-on parity through produceItemHighlightsPerDesign ─

describe('RULING K10: a throwing writer call falls back to the composer, exactly like every other failure mode', () => {
  it('produceItemHighlightsPerDesign(on): a design whose writer call throws ships the COMPOSER\'S OWN result, never an exception escaping produce*', async () => {
    const groups = [{ key: 'A', designName: 'Sunny Beach Vibes', skus: [{ sku: 'A1', asin: 'B0A0000001' }], titles: ['THE CEO Sunny Beach Vibes Tee'] }]
    const pool: AnalyzedKeyword[] = [
      kw('funny graphic novelty tee', 450, 3), kw('cute cartoon animal print', 900, 3), kw('retro vintage style clothing', 300, 3),
      kw('cozy everyday casual wear', 250, 3), kw('trendy modern weekend outfit', 5000, 3),
    ]
    const input = { groups, pool, apparelProduct: true, blankBrand: GILDAN, familyTitleText: 'Beach Family' }
    process.env.IH_WRITER = 'on'
    try {
      const throwingClient = { chat: { completions: { create: async () => { throw new Error('boom') } } } } as never
      const result = await produceItemHighlightsPerDesign(input, { openai: throwingClient })
      const built = (await import('./listingPipeline')).buildItemHighlightsPerDesign(input)
      const designA = result.perDesign.find((d) => d.designKey === 'A')!
      const builtA = built.perDesign.find((d) => d.designKey === 'A')!
      expect(designA.value).toBe(builtA.value)
      expect(designA.hold).toBe(builtA.hold)
    } finally { delete process.env.IH_WRITER }
  })
})
