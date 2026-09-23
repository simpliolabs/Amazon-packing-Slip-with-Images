/**
 * itemHighlightWriterFixRoundF1.test.ts — Round F1 (`.superpowers/sdd/2026-09-10-ih-writer/phase-
 * f1-rulings.md`), the FIRST live shadow run: PO ran IH_WRITER=shadow on B0DSCDZC6K (2026-09-23,
 * sha `f4317ce`), pasted the writer block verbatim. Six designs, `calls: 3` each, `accepted: false`
 * each, `writer: null` each — 18 billable calls, ZERO accepted lines.
 *
 * REPRODUCES FIRST (per the task's own instruction): every case below is rebuilt from the units
 * the live rejections NAMED — the six pool-unit shapes and the one shared spec fact — run through
 * the REAL `validateArrangement`/`judgeWriterArrangement`, never a re-implementation of the
 * grammar under test. At HEAD before this round's fix, every "12 of 18" case below produced the
 * EXACT message the PO pasted:
 *   "', with' is not a legal join between '<pool unit>' and '50% Cotton / 50% Polyester' — only a
 *   join followed by 'a'/'an' is"
 * and the one padded-glue case produced:
 *   "glue token ' with ' is outside the closed glue/punctuation set"
 * (verified by temporarily reverting this round's diff and re-running this file — RED before the
 * fix, GREEN after; see `phase-f1-report.md`).
 *
 * THE FIX THIS FILE PINS:
 *   F1 (Blocking) — a LIST join may be followed by a RELATION join ("<unit>, with <spec fact>"),
 *     under the EXACT SAME right-hand-unit legality rule a bare relation join already enforces.
 *   F2 (Blocking) — a glue token is normalised (trimmed, case-folded) BEFORE being matched against
 *     the closed glue/punctuation sets, so `' with '`/`'With'`/`'with'` are one token.
 *   F3 (Important) — the prompt carries a WORKED EXAMPLE, built by CODE from THIS design's own
 *     admitted units, that itself passes `validateArrangement` and the band.
 *   F4 (Important) — the user message states the max length, the example's own length, and says
 *     plainly that an over-length line is discarded.
 *   F5 (Important) — every one of the 18 live rejections, re-measured: the 12 `', with'` attempts
 *     now ACCEPT; the 3 over-length attempts (211/270/318 chars) still REFUSE, with the precise
 *     count; the 1 padded-glue attempt now ACCEPTS.
 *
 * DO NOT (per the ruling): no truth rule widened, no other path touched, hold semantics unchanged.
 */
import { describe, it, expect } from 'vitest'
import {
  validateArrangement, renderArrangement, judgeWriterArrangement, buildWriterPrompt,
  buildWorkedExample, buildAdmittedUnits,
  type AdmittedUnit, type ArrangementPart,
} from '@/lib/fba/itemHighlightWriter'
import { buildItemHighlights, runIhTail } from '@/lib/fba/listingPipeline'
import { DEFAULT_BLANK_SPECS, type BlankSpecRow } from '@/lib/fba/blankSpecs'
import type { AnalyzedKeyword } from '@/lib/keyword-engine'
import type { PhraseTruthCtx } from '@/lib/fba/contentTruth'

// ─── the live evidence, verbatim from phase-f1-rulings.md ─────────────────────────────────────────

/** The six pool-unit shapes the PO's pasted `writer` block named, each rejected 2x (12 of 18
 *  attempts) for the identical `', with'` join to the shared material fact below. */
const LIVE_POOL_UNITS = [
  'Embroidered Sweatshirts for Women',
  'Sweatshirts for Women Trendy',
  'Graphic Crewneck Sweatshirts Women',
  'Fall Graphic Sweatshirts for Women',
  'Fun Sweatshirts for Women',
  'Fall Crewneck',
] as const
const LIVE_MATERIAL = '50% Cotton / 50% Polyester'

/** A minimal, direct admitted-set fixture — exactly the two units a live rejection named, nothing
 *  else — so the grammar fix is isolated from every other admission/truth/readability concern. */
function liveUnits(poolText: string): AdmittedUnit[] {
  return [
    { id: 'pool', text: poolText, kind: 'pool', numberable: false },
    { id: 'mat', text: LIVE_MATERIAL, kind: 'spec-fact', numberable: false },
  ]
}
const listWithParts = (poolId = 'pool', matId = 'mat'): ArrangementPart[] => [
  { unit: poolId }, { glue: ',' }, { glue: 'with' }, { unit: matId },
]

describe('F1 (Blocking): a list join may be followed by a relation join', () => {
  for (const poolText of LIVE_POOL_UNITS) {
    it(`ACCEPTS '${poolText}, with ${LIVE_MATERIAL}' — the exact live-rejected shape`, () => {
      const units = liveUnits(poolText)
      const v = validateArrangement({ parts: listWithParts() }, units)
      expect(v.ok, !v.ok ? v.violation : '').toBe(true)
      if (v.ok) {
        expect(renderArrangement(v.parts, units)).toBe(`${poolText}, with ${LIVE_MATERIAL}`)
      }
    })
  }

  it('the SAME right-hand-unit rule a bare relation join already enforces still applies: a list join followed by "with" onto a POOL/BRAND/WEAR-FACT unit is still refused, named the SAME way a bare relation refusal is', () => {
    const units: AdmittedUnit[] = [
      { id: 'pool', text: 'Fall Crewneck', kind: 'pool', numberable: false },
      { id: 'pocket', text: 'Deep Pockets', kind: 'pool', numberable: false },
      { id: 'wear', text: 'Can be worn as Oversized', kind: 'wear-fact', numberable: false },
      { id: 'brand', text: 'Comfort Colors Tee', kind: 'pool', numberable: false, isBrand: true },
    ]
    const poolTarget = validateArrangement({ parts: [{ unit: 'pool' }, { glue: ',' }, { glue: 'with' }, { unit: 'pocket' }] }, units)
    expect(poolTarget.ok).toBe(false)
    if (!poolTarget.ok) expect(poolTarget.violation).toMatch(/must introduce a spec fact/)
    const wearTarget = validateArrangement({ parts: [{ unit: 'pool' }, { glue: ',' }, { glue: 'with' }, { unit: 'wear' }] }, units)
    expect(wearTarget.ok).toBe(false)
    if (!wearTarget.ok) expect(wearTarget.violation).toMatch(/cannot introduce the wear-fact unit/)
    const brandTarget = validateArrangement({ parts: [{ unit: 'pool' }, { glue: ',' }, { glue: 'with' }, { unit: 'brand' }] }, units)
    expect(brandTarget.ok).toBe(false)
    if (!brandTarget.ok) expect(brandTarget.violation).toMatch(/cannot introduce the brand unit/)
  })

  it('", in" is legal under the SAME rule (relation join is "with" OR "in", not only "with")', () => {
    const units = liveUnits('Fall Crewneck')
    const v = validateArrangement({ parts: [{ unit: 'pool' }, { glue: ',' }, { glue: 'in' }, { unit: 'mat' }] }, units)
    expect(v.ok, !v.ok ? v.violation : '').toBe(true)
  })

  it('end to end through judgeWriterArrangement (real tail): the live shape ships when it is also in-band and true for the family', () => {
    const material = '100% Ring-Spun Cotton'
    const truthCtx: PhraseTruthCtx = { garmentFamily: 'sweatshirt', spec: { material, fit: 'Classic' }, allowedBrand: null, audience: 'adult', field: 'highlights' }
    const units: AdmittedUnit[] = [
      { id: 'id', text: "Don't Quit", kind: 'identity', numberable: false },
      { id: 'pool', text: 'Fall Graphic Sweatshirts for Women', kind: 'pool', numberable: false },
      { id: 'mat', text: material, kind: 'spec-fact', numberable: false },
      { id: 'pool2', text: 'Cute Crewnecks', kind: 'pool', numberable: false },
      { id: 'pool3', text: 'Perfect Weekend Layer', kind: 'pool', numberable: false },
    ]
    const runTail = (l: string) => runIhTail(l, { titles: [], blankBrand: DEFAULT_BLANK_SPECS[1], truthCtx, capacityFamily: false, site: 'f1-test' })
    const parts: ArrangementPart[] = [{ unit: 'id' }, { glue: ',' }, { unit: 'pool2' }, { glue: ',' }, { glue: 'with' }, { unit: 'mat' }, { glue: ',' }, { unit: 'pool' }, { glue: 'and' }, { unit: 'pool3' }]
    const v = judgeWriterArrangement({ parts }, units, { truthCtx, runTail })
    expect(v.ok, JSON.stringify(v)).toBe(true)
  })
})

describe('F2 (Blocking): a glue token is normalised (trim + case-fold) before matching', () => {
  it("pins ' with ' (the live padded token) and 'With' as the SAME token as 'with'", () => {
    const units = liveUnits('Fall Crewneck')
    for (const spelling of [' with ', 'With', 'WITH', '\twith\n']) {
      const v = validateArrangement({ parts: [{ unit: 'pool' }, { glue: spelling }, { unit: 'mat' }] }, units)
      expect(v.ok, `'${spelling}': ${!v.ok ? v.violation : ''}`).toBe(true)
      if (v.ok) expect(renderArrangement(v.parts, units)).toBe(`Fall Crewneck with ${LIVE_MATERIAL}`)
    }
  })

  it("pins ' , ' (padded comma) as the SAME token as ','", () => {
    const units = liveUnits('Fall Crewneck')
    const v = validateArrangement({ parts: [{ unit: 'pool' }, { glue: ' , ' }, { unit: 'mat' }] }, units)
    expect(v.ok, !v.ok ? v.violation : '').toBe(true)
    if (v.ok) expect(renderArrangement(v.parts, units)).toBe(`Fall Crewneck, ${LIVE_MATERIAL}`)
  })

  it('a token that is NOT one of the closed set even after trim/fold is still refused (normalisation never widens the set itself)', () => {
    const units = liveUnits('Fall Crewneck')
    const v = validateArrangement({ parts: [{ unit: 'pool' }, { glue: ' For ' }, { unit: 'mat' }] }, units)
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.violation).toMatch(/outside the closed glue\/punctuation set/)
  })

  it('the exact live case: a padded relation AFTER a list join (", with ") is accepted (F1+F2 compose)', () => {
    const units = liveUnits('Fall Crewneck')
    const v = validateArrangement({ parts: [{ unit: 'pool' }, { glue: ',' }, { glue: ' With ' }, { unit: 'mat' }] }, units)
    expect(v.ok, !v.ok ? v.violation : '').toBe(true)
  })
})

describe('F5: the 3 over-length live rejections still refuse, with the precise count (band unchanged)', () => {
  const material = '100% Ring-Spun Cotton'
  const truthCtx: PhraseTruthCtx = { garmentFamily: 'sweatshirt', spec: { material, fit: 'Classic' }, allowedBrand: null, audience: 'adult', field: 'highlights' }
  const runTail = (l: string) => runIhTail(l, { titles: [], blankBrand: DEFAULT_BLANK_SPECS[1], truthCtx, capacityFamily: false, site: 'f1-test' })

  it('a line built from every live pool unit joined onto the material fact still overflows 125 and is named with the REAL rendered length', () => {
    const units: AdmittedUnit[] = [
      { id: 'id', text: "Don't Quit", kind: 'identity', numberable: false },
      ...LIVE_POOL_UNITS.map((t, i) => ({ id: `p${i}`, text: t, kind: 'pool' as const, numberable: false })),
      { id: 'mat', text: material, kind: 'spec-fact', numberable: false },
    ]
    const parts: ArrangementPart[] = [
      { unit: 'id' },
      ...LIVE_POOL_UNITS.flatMap((_, i) => (i === 0 ? [{ glue: ',' } as ArrangementPart, { unit: `p${i}` } as ArrangementPart] : [{ glue: 'and' } as ArrangementPart, { unit: `p${i}` } as ArrangementPart])),
      { glue: ',' }, { glue: 'with' }, { unit: 'mat' },
    ]
    const rendered = renderArrangement(parts, units)
    expect(rendered.length).toBeGreaterThan(125)
    const v = judgeWriterArrangement({ parts }, units, { truthCtx, runTail })
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.violations.join(' ')).toMatch(new RegExp(`rendered ${rendered.length} chars, max 125`))
  })
})

// ─── F3/F4: the worked example + the explicit max-length statement ────────────────────────────────

const kw = (keyword: string, searchVolume: number): AnalyzedKeyword => ({ keyword, searchVolume, themeFit: 3 } as unknown as AnalyzedKeyword)
const NEVER = /(?!)/
const BLEND_SWEAT: BlankSpecRow = { match: NEVER, spec: { brand: 'Gildan', brandInCopy: false, fit: 'Classic', material: '50% Cotton / 50% Polyester' } as never, styleCode: 'x', garmentFamily: 'sweatshirt' } as unknown as BlankSpecRow
const PURE_TEE: BlankSpecRow = { match: NEVER, spec: { brand: 'Gildan', brandInCopy: false, fit: 'Classic', material: '100% Ring-Spun Cotton' } as never, styleCode: 'x', garmentFamily: 'tee' } as unknown as BlankSpecRow
const HOODIE: BlankSpecRow = { match: NEVER, spec: { brand: 'Gildan', brandInCopy: false, fit: 'Relaxed', material: '80% Cotton / 20% Polyester' } as never, styleCode: 'x', garmentFamily: 'hoodie' } as unknown as BlankSpecRow
const CC = DEFAULT_BLANK_SPECS[0] // Comfort Colors — mandatory brand (brandInCopy defaults true)

const SWEAT_POOL = ['soft cotton feel', 'cozy crewneck sweatshirt', 'brushed fleece lining', 'made for chilly fall weekends', 'perfect for lazy weekends', 'polyester blend comfort', 'warm layer for winter']
const TEE_POOL = ['soft graphic tee', 'vintage beach vibes', 'made for lazy summer days', 'great for weekend road trips', 'soft cotton feel', 'relaxed everyday style', 'soft vintage wash']
const CC_POOL = ['comfort colors tee', 'garment dyed sweatshirt', 'soft ring spun cotton', 'crew neck sweatshirt', 'oversized fit sweatshirt', 'cozy fall layer', 'retro vintage wash']

function familyUnits(o: { name: string; pool: string[]; blank: BlankSpecRow; title?: string }): { units: AdmittedUnit[]; needBrand: boolean } {
  const title = o.title ?? `THE CEO ${o.name} Shirt`
  const built = buildItemHighlights({
    finalTitle: title, pool: o.pool.map((k, i) => kw(k, 5000 - i * 10)), apparelProduct: true,
    blankBrand: o.blank, netTitles: [title], designTokens: [o.name], capacityFamily: false, brandName: 'THE CEO',
  })
  const units = buildAdmittedUnits(built.composed!, { designName: o.name, truthCtx: built.truthCtx! })
  return { units, needBrand: !!built.composed?.needBrand }
}

describe('F3 (Important): buildWorkedExample validates + hits the band, for at least 6 families (including a Comfort Colors one)', () => {
  const FAMILIES: { label: string; o: Parameters<typeof familyUnits>[0] }[] = [
    { label: 'sweatshirt/blend, no brand', o: { name: "Don't Quit", pool: SWEAT_POOL, blank: BLEND_SWEAT } },
    { label: 'tee/pure cotton, no brand', o: { name: 'Retro Sunset', pool: TEE_POOL, blank: PURE_TEE } },
    { label: 'hoodie/blend, no brand', o: { name: 'Cozy Nights', pool: SWEAT_POOL, blank: HOODIE } },
    { label: 'sweatshirt, Comfort Colors (mandatory brand)', o: { name: 'Fall Vibes', pool: CC_POOL, blank: CC } },
    { label: 'tee, second identity', o: { name: 'Beach Please', pool: TEE_POOL, blank: PURE_TEE } },
    { label: 'sweatshirt, second identity, blend', o: { name: 'Give Thanks', pool: SWEAT_POOL, blank: BLEND_SWEAT } },
  ]

  let passCount = 0
  for (const f of FAMILIES) {
    it(`${f.label}: the generated example (when built) passes validateArrangement and the 97-125 band`, () => {
      const { units, needBrand } = familyUnits(f.o)
      const example = buildWorkedExample(units)
      if (!example) return // an acceptable outcome per F3's own doc — never a broken example
      passCount++
      expect(example.line.length).toBeGreaterThanOrEqual(97)
      expect(example.line.length).toBeLessThanOrEqual(125)
      const v = validateArrangement(example.json, units, needBrand)
      expect(v.ok, `${f.label}: example did not validate — ${!v.ok ? v.violation : ''}`).toBe(true)
      if (needBrand) {
        const brandUnit = units.find((u) => u.isBrand)
        expect(brandUnit && example.line.includes(brandUnit.text), `${f.label}: example dropped the mandatory brand`).toBe(true)
      }
    })
  }

  it('at least 6 of the families above produced a validated, in-band example', () => {
    expect(passCount).toBeGreaterThanOrEqual(6)
  })
})

describe('F4 (Important): the user message states the max length plainly, and shows the example when one was built', () => {
  it('always states the max and that an over-length line is discarded', () => {
    const units: AdmittedUnit[] = [
      { id: 'id', text: "Don't Quit", kind: 'identity', numberable: false },
      { id: 'pool', text: 'Fall Graphic Sweatshirts for Women', kind: 'pool', numberable: false },
      { id: 'mat', text: '50% Cotton / 50% Polyester', kind: 'spec-fact', numberable: false },
    ]
    const { user } = buildWriterPrompt(units, "Don't Quit", [])
    expect(user).toMatch(/THE MAXIMUM IS 125 CHARACTERS/)
    expect(user).toMatch(/DISCARDED/)
  })

  it('shows the worked example block, with its own JSON, rendered line and char count, when buildWorkedExample succeeds', () => {
    const { units } = familyUnits({ name: "Don't Quit", pool: SWEAT_POOL, blank: BLEND_SWEAT })
    const example = buildWorkedExample(units)
    expect(example).not.toBeNull()
    const { user } = buildWriterPrompt(units, "Don't Quit", [])
    if (example) {
      expect(user).toMatch(/EXAMPLE — a VALID answer for this exact design/)
      expect(user).toContain(JSON.stringify(example.line))
      expect(user).toContain(`${example.line.length} chars`)
    }
  })

  it('omits the example block (never a broken one) when no admitted-unit combination reaches the band', () => {
    const units: AdmittedUnit[] = [{ id: 'id', text: 'Hi', kind: 'identity', numberable: false }]
    expect(buildWorkedExample(units)).toBeNull()
    const { user } = buildWriterPrompt(units, 'Hi', [])
    expect(user).not.toMatch(/EXAMPLE — a VALID answer/)
  })
})
