/**
 * itemHighlightWriterGrammar.test.ts — Fix round B3 (RULING G1-G10, phase-b3-rulings.md), closing
 * review B2's two Blocking findings (phase-b2-review.md §2/§4).
 *
 * REPRODUCES FIRST (per the task's own instruction): every case below is the reviewer's `adv.mts`
 * adversary, adapted to vitest — the SAME REAL `buildItemHighlights` (for the admitted set),
 * `buildAdmittedUnits`, `judgeWriterArrangement`, and `runIhTail` the review ran against HEAD
 * `5165d0a`, where X1, X3, X5, X7, X8, X9, X10, X13 (+X19/X20 compliance leaks) SHIPPED as LIES —
 * pasted verbatim in phase-b-report.md's "Fix round B3" section. This file pins every one of those
 * as a must-reject, through the REAL judge — never a re-implementation of the grammar under test.
 *
 * THE CURE (spec §2c, ruling G1): a closed arrangement GRAMMAR. Abutment (no glue) is legal only
 * before a garment-head unit. List joins (`,` `and` `&` `—` `|`) may join anything. Relation joins
 * (`with`/`in`, optionally + `a`/`an`) may introduce ONLY a spec-class unit (spec-fact/brand/wear-
 * fact) — never a pool or identity unit. `for`/`of`/`to`/`your`/`on`/`from`/`that`/`this`/`the` are
 * removed from the closed glue set outright.
 */
import { describe, it, expect } from 'vitest'
import { buildItemHighlights, runIhTail } from './listingPipeline'
import {
  buildAdmittedUnits, judgeWriterArrangement, renderArrangement, validateArrangement,
  GLUE_WORDS, GLUE_PUNCTUATION, type AdmittedUnit, type ArrangementPart,
} from './itemHighlightWriter'
import { phraseTruthVerdict, type PhraseTruthCtx } from './contentTruth'
import { DEFAULT_BLANK_SPECS, type BlankSpecRow } from './blankSpecs'
import { scrubTrademarks } from './trademarkGuard'
import { scrubCelebrityNames } from './celebrityGuard'
import type { AnalyzedKeyword } from '@/lib/keyword-engine'

const kw = (keyword: string, searchVolume: number): AnalyzedKeyword => ({ keyword, searchVolume, themeFit: 3 } as unknown as AnalyzedKeyword)

const NEVER = /(?!)/
const BLEND_SWEAT: BlankSpecRow = { match: NEVER, spec: { brand: 'Gildan', brandInCopy: false, fit: 'Classic', material: '52% Cotton / 48% Polyester' } as never, styleCode: 'x', garmentFamily: 'sweatshirt' } as unknown as BlankSpecRow
const PURE_TEE: BlankSpecRow = { match: NEVER, spec: { brand: 'Gildan', brandInCopy: false, fit: 'Classic', material: '100% Ring-Spun Cotton' } as never, styleCode: 'x', garmentFamily: 'tee' } as unknown as BlankSpecRow
const CC = DEFAULT_BLANK_SPECS[0]

const SWEAT_POOL = ['soft cotton feel', 'cozy crewneck sweatshirt', 'brushed fleece lining', 'made for chilly fall weekends', 'perfect for lazy weekends', 'polyester blend comfort', 'warm layer for winter']
const TEE_POOL = ['soft graphic tee', 'vintage beach vibes', 'made for lazy summer days', 'great for weekend road trips', 'soft cotton feel', 'relaxed everyday style', 'soft vintage wash']

interface Setup { units: AdmittedUnit[]; runTail: (l: string) => { value: string; hold: string | null; reason?: string | null }; truthCtx: PhraseTruthCtx; value: string }

function setup(o: { name: string; phrases?: string[]; pool: string[]; blank: BlankSpecRow; title?: string }): Setup {
  const title = o.title ?? `THE CEO ${o.name} Shirt`
  const input = {
    finalTitle: title, pool: o.pool.map((k, i) => kw(k, 5000 - i * 10)), apparelProduct: true,
    blankBrand: o.blank, netTitles: [title], designTokens: [o.name], capacityFamily: false, brandName: 'THE CEO',
  }
  const built = buildItemHighlights(input)
  const units = buildAdmittedUnits(built.composed!, { designName: o.name, identityPhrases: o.phrases ?? [], truthCtx: built.truthCtx! })
  const runTail = (l: string) => runIhTail(l, { titles: [title], blankBrand: o.blank, truthCtx: built.truthCtx!, capacityFamily: false, brandName: 'THE CEO', site: 'grammar-test' })
  return { units, runTail, truthCtx: built.truthCtx!, value: built.value }
}

const GLUE = new Set<string>([...GLUE_WORDS, ...GLUE_PUNCTUATION])

/** Resolves a spec array of unit TEXTS (matched case-insensitively against the setup's admitted
 *  units) and closed glue tokens into arrangement parts, mirroring the review's own `resolve()`. */
function resolve(spec: readonly (string | { u: string; number: 'plural' | 'singular' })[], units: readonly AdmittedUnit[]): { parts: ArrangementPart[] } | { missing: string } {
  const parts: ArrangementPart[] = []
  for (const s of spec) {
    if (typeof s === 'string' && GLUE.has(s)) { parts.push({ glue: s }); continue }
    const text = typeof s === 'string' ? s : s.u
    const u = units.find((x) => x.text.toLowerCase() === text.toLowerCase())
    if (!u) return { missing: text }
    parts.push(typeof s === 'string' ? { unit: u.id } : { unit: u.id, number: s.number })
  }
  return { parts }
}

describe('RULING G1 (spec §2c): the closed arrangement grammar — must-reject pins (adv.mts X1-X13)', () => {
  const CASES: { id: string; o: Parameters<typeof setup>[0]; spec: (string | { u: string; number: 'plural' | 'singular' })[]; note: string }[] = [
    { id: 'X1', o: { name: 'Keep It Pure', pool: SWEAT_POOL, blank: BLEND_SWEAT }, spec: ['Keep It Pure', 'Soft Cotton Feel', ',', 'Cozy Crewneck Sweatshirt', 'with', 'Brushed Fleece Lining', ',', 'Made For Chilly Fall Weekends'], note: 'abutment: identity + pool reads as "Pure Soft Cotton Feel" on a 52/48 blend' },
    { id: 'X3', o: { name: 'Give It All', pool: SWEAT_POOL, blank: BLEND_SWEAT }, spec: ['Give It All', 'Soft Cotton Feel', ',', 'Cozy Crewneck Sweatshirt', 'with', 'Brushed Fleece Lining', ',', 'Made For Chilly Fall Weekends'], note: 'abutment: "All Soft Cotton" on a blend' },
    { id: 'X4', o: { name: 'Just Say No', pool: SWEAT_POOL, blank: BLEND_SWEAT }, spec: ['Just Say No', 'Polyester Blend Comfort', ',', 'Cozy Crewneck Sweatshirt', 'with', 'Brushed Fleece Lining', ',', 'Made For Chilly Fall Weekends'], note: 'abutment: "No Polyester Blend" (ambiguous reading) on a blend' },
    { id: 'X5', o: { name: 'Deep Pockets', pool: SWEAT_POOL, blank: BLEND_SWEAT }, spec: ['Cozy Crewneck Sweatshirt', 'with', 'Deep Pockets', ',', 'Soft Cotton Feel', 'and', 'Brushed Fleece Lining', ',', 'Made For Chilly Fall Weekends'], note: 'relation "with" introduces an identity unit (invented feature) — no pockets' },
    { id: 'X6', o: { name: 'Self Made', pool: SWEAT_POOL, blank: BLEND_SWEAT }, spec: ['Self Made', 'and', 'Soft Cotton Feel', ',', 'Cozy Crewneck Sweatshirt', 'with', 'Brushed Fleece Lining', ',', 'Made For Chilly Fall Weekends'], note: '"from" is no longer glue at all; "and" (list) is the nearest legal join, so this case cannot even express the original material-claim shape' },
    { id: 'X7', o: { name: 'Pink Lemonade', pool: TEE_POOL, blank: PURE_TEE }, spec: ['Soft Graphic Tee', 'in', 'Pink Lemonade', ',', 'Soft Cotton Feel', 'and', 'Vintage Beach Vibes', ',', 'Made For Lazy Summer Days'], note: 'relation "in" introduces an identity unit (invented colour) — every colour child' },
    { id: 'X8', o: { name: 'Little Man', pool: TEE_POOL, blank: PURE_TEE }, spec: ['Soft Graphic Tee', 'for', 'Little Man', ',', 'Vintage Beach Vibes', 'and', 'Soft Cotton Feel', ',', 'Great For Weekend Road Trips'], note: '"for" is no longer a closed glue token at all (adult blank, invented audience)' },
    { id: 'X9', o: { name: 'Birthday Boy', pool: TEE_POOL, blank: PURE_TEE }, spec: ['Soft Graphic Tee', 'for', 'Birthday Boy', ',', 'Vintage Beach Vibes', 'and', 'Soft Cotton Feel', ',', 'Great For Weekend Road Trips'], note: '"for" is no longer a closed glue token at all (adult blank, invented audience, design-own-word exemption)' },
    { id: 'X10', o: { name: 'Girl Dad', phrases: ['Girls'], pool: TEE_POOL, blank: PURE_TEE }, spec: ['Girl Dad', 'Soft Graphic Tee', 'for', 'Girls', ',', 'Vintage Beach Vibes', 'and', 'Soft Cotton Feel', ',', 'Great For Weekend Road Trips'], note: '"for" is not glue AND a single-word vision seed ("Girls") is never admitted as identity (RULING G2)' },
    { id: 'X11', o: { name: 'Baby Shark', pool: TEE_POOL, blank: PURE_TEE }, spec: ['Soft Graphic Tee', 'for', 'Baby Shark', ',', 'Vintage Beach Vibes', 'and', 'Soft Cotton Feel', ',', 'Great For Weekend Road Trips'], note: '"for" is no longer a closed glue token at all' },
    { id: 'X13', o: { name: 'Hold On Tight', pool: TEE_POOL, blank: PURE_TEE }, spec: [{ u: 'Hold On Tight', number: 'plural' }, 'Soft Graphic Tee', 'with', 'Vintage Beach Vibes', ',', 'Soft Cotton Feel', 'and', 'Relaxed Everyday Style'], note: 'RULING G3: "Tight" is not numberable (literal GARMENT_HEAD_WORDS membership) — wrong garment "tights" on a tee' },
  ]

  for (const c of CASES) {
    it(`${c.id}: ${c.note}`, () => {
      const s = setup(c.o)
      const r = resolve(c.spec, s.units)
      if ('missing' in r) {
        // Unbuildable is an ACCEPTABLE outcome for a must-reject pin — the lying clause simply has
        // no admitted unit to attach to any more (e.g. X10's single-word identity seed).
        expect(r.missing, `${c.id} unbuildable — unit "${r.missing}" not admitted (acceptable: it never ships)`).toBeTruthy()
        return
      }
      const v = judgeWriterArrangement({ parts: r.parts }, s.units, { truthCtx: s.truthCtx, runTail: s.runTail })
      expect(v.ok, `${c.id} MUST be rejected but SHIPPED: ${JSON.stringify(v)}`).toBe(false)
    })
  }

  it('X15 (true, control): the exact original spec array — abutting identity + pool with "with" — is now grammar-illegal (relation must introduce a spec unit), proving the fix generalizes; the NEAREST TRUE grammatical line (list joins only) still ships', () => {
    const s = setup({ name: 'Retro Sunset', pool: TEE_POOL, blank: PURE_TEE })
    const original = resolve(['Retro Sunset', { u: 'Tee', number: 'plural' }, 'with', 'Vintage Beach Vibes', ',', 'Soft Cotton Feel', 'and', 'Relaxed Everyday Style', ',', 'Made For Lazy Summer Days'], s.units)
    expect('missing' in original).toBe(false)
    if (!('missing' in original)) {
      const v = judgeWriterArrangement({ parts: original.parts }, s.units, { truthCtx: s.truthCtx, runTail: s.runTail })
      expect(v.ok, 'the ORIGINAL X15 spec now correctly fails grammar ("with" onto a pool unit)').toBe(false)
    }
    // Nearest TRUE grammatical line: abutment before the garment-head unit, then LIST joins —
    // "and" (not a bare ",") keeps at least two clauses non-keyword-shaped, same readability
    // constraint `buildAcceptableArrangement` (itemHighlightWriterRunAcceptance.test.ts) satisfies.
    const nearest = resolve(['Retro Sunset', { u: 'Tee', number: 'plural' }, 'and', 'Vintage Beach Vibes', ',', 'Soft Cotton Feel', 'and', 'Relaxed Everyday Style', ',', 'Made For Lazy Summer Days'], s.units)
    expect('missing' in nearest).toBe(false)
    if (!('missing' in nearest)) {
      const v = judgeWriterArrangement({ parts: nearest.parts }, s.units, { truthCtx: s.truthCtx, runTail: s.runTail })
      expect(v.ok, JSON.stringify(v)).toBe(true)
    }
  })
})

describe('RULING G4 (F3): brand required — X17 end to end through produceItemHighlights-equivalent (buildItemHighlights + buildAdmittedUnits + judgeWriterArrangement)', () => {
  it('an arrangement omitting the composer\'s mandatory brand unit is rejected; carrying it ships', () => {
    const s = setup({ name: 'Retro Sunset', pool: [...TEE_POOL, 'comfort colors tee'], blank: CC })
    // Otherwise grammar-legal (list joins throughout) — the ONLY thing wrong is the missing brand
    // unit, so this specifically isolates RULING G4, not an incidental grammar violation.
    const brandless = resolve(['Retro Sunset', ',', 'Soft Graphic Tee', ',', 'Vintage Beach Vibes', 'and', 'Made For Lazy Summer Days'], s.units)
    expect('missing' in brandless).toBe(false)
    if (!('missing' in brandless)) {
      const v = judgeWriterArrangement({ parts: brandless.parts }, s.units, { truthCtx: s.truthCtx, runTail: s.runTail })
      expect(v.ok, 'X17: an arrangement without the brand unit must be rejected now').toBe(false)
      if (!v.ok) expect(v.violations.join(' ')).toMatch(/missing required brand unit/)
    }
    const withBrand = resolve(['Retro Sunset', 'and', 'Soft Graphic Tee', ',', 'Comfort Colors Tee', 'and', 'Vintage Beach Vibes', ',', 'Made For Lazy Summer Days'], s.units)
    expect('missing' in withBrand).toBe(false)
    if (!('missing' in withBrand)) {
      const v = judgeWriterArrangement({ parts: withBrand.parts }, s.units, { truthCtx: s.truthCtx, runTail: s.runTail })
      expect(v.ok, JSON.stringify(v)).toBe(true)
      if (v.ok) expect(/comfort\s*colors/i.test(v.value)).toBe(true)
    }
  })
})

describe('RULING G5 (F4): defensive fail-closed — X19/X20 rejected even if an identity unit somehow carried a trademark/celebrity name', () => {
  const s = setup({ name: 'Retro Sunset', pool: TEE_POOL, blank: PURE_TEE })

  it('X19: a trademark-carrying identity unit (bypassing G2\'s own admission door) is still rejected by judgeWriterArrangement', () => {
    const injected: AdmittedUnit[] = [...s.units, { id: 'inject-tm', text: 'World Cup Champs', kind: 'identity', numberable: false }]
    const poolId = injected.find((u) => u.text === 'Soft Graphic Tee')!.id
    // A LIST join (grammar-legal) so the ONLY reason this can fail is the G5 scrub door, not abutment.
    const parts: ArrangementPart[] = [{ unit: 'inject-tm' }, { glue: ',' }, { unit: poolId }]
    expect(scrubTrademarks('World Cup Champs, Soft Graphic Tee')).not.toBe('World Cup Champs, Soft Graphic Tee')
    const v = judgeWriterArrangement({ parts }, injected, { truthCtx: s.truthCtx, runTail: s.runTail })
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.violations.join(' ')).toMatch(/trademark/)
  })

  it('X20: a celebrity-carrying identity unit is still rejected by judgeWriterArrangement', () => {
    const injected: AdmittedUnit[] = [...s.units, { id: 'inject-cel', text: 'Taylor Swift Fan', kind: 'identity', numberable: false }]
    const poolId = injected.find((u) => u.text === 'Soft Graphic Tee')!.id
    const parts: ArrangementPart[] = [{ unit: 'inject-cel' }, { glue: ',' }, { unit: poolId }]
    expect(scrubCelebrityNames('Taylor Swift Fan, Soft Graphic Tee', 'test')).not.toBe('Taylor Swift Fan, Soft Graphic Tee')
    const v = judgeWriterArrangement({ parts }, injected, { truthCtx: s.truthCtx, runTail: s.runTail })
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.violations.join(' ')).toMatch(/celebrity/)
  })

  it('RULING G2: the admission door itself never admits a trademarked or celebrity identity phrase in the first place', () => {
    const units = buildAdmittedUnits(
      { candidates: [], specFacts: [], brandPick: null, wearFact: null },
      { designName: 'World Cup Champs', identityPhrases: ['Taylor Swift Fan'], truthCtx: s.truthCtx },
    )
    expect(units.filter((u) => u.kind === 'identity')).toHaveLength(0)
  })
})

describe('RULING G2: identity admission requires 2+ word vision phrases (no single-word seeds) — closes X10\'s mechanism at the door', () => {
  it('a single-word vision phrase is never admitted as an identity unit; a 2+ word one still is', () => {
    const units = buildAdmittedUnits(
      { candidates: [], specFacts: [], brandPick: null, wearFact: null },
      { designName: 'Girl Dad', identityPhrases: ['Girls', 'Girl Dad Life'], truthCtx: { garmentFamily: 'tee', spec: { material: '100% Cotton', fit: 'Classic' }, allowedBrand: null, audience: 'adult', field: 'highlights' } },
    )
    const identityTexts = units.filter((u) => u.kind === 'identity').map((u) => u.text)
    expect(identityTexts).toContain('Girl Dad')
    expect(identityTexts).toContain('Girl Dad Life')
    expect(identityTexts).not.toContain('Girls')
  })
})

describe('RULING G9: validation hygiene', () => {
  const s = setup({ name: 'Retro Sunset', pool: TEE_POOL, blank: PURE_TEE })

  it('an unknown key on a unit part is a named violation, not silently dropped', () => {
    const poolId = s.units.find((u) => u.text === 'Soft Graphic Tee')!.id
    expect(validateArrangement({ parts: [{ unit: poolId, glue: 'for', text: 'Waterproof' }] }, s.units)).toMatchObject({ ok: false })
  })

  it('rendering: "&" "|" "—" are space-padded on both sides; "," attaches left (RULING G9)', () => {
    const a = s.units.find((u) => u.text === 'Retro Sunset')!
    const b = s.units.find((u) => u.text === 'Vintage Beach Vibes')!
    expect(renderArrangement([{ unit: a.id }, { glue: '&' }, { unit: b.id }], s.units)).toBe('Retro Sunset & Vintage Beach Vibes')
    expect(renderArrangement([{ unit: a.id }, { glue: '|' }, { unit: b.id }], s.units)).toBe('Retro Sunset | Vintage Beach Vibes')
    expect(renderArrangement([{ unit: a.id }, { glue: '—' }, { unit: b.id }], s.units)).toBe('Retro Sunset — Vintage Beach Vibes')
    expect(renderArrangement([{ unit: a.id }, { glue: ',' }, { unit: b.id }], s.units)).toBe('Retro Sunset, Vintage Beach Vibes')
  })
})

describe('sanity: the identity-truth admission gate is unaffected by this round (regression guard on phraseTruthVerdict itself)', () => {
  it('phraseTruthVerdict is still the ONE gate buildAdmittedUnits reads for identity truth', () => {
    const ctx = { garmentFamily: 'tee' as const, spec: { material: '100% Ring-Spun Cotton', fit: 'Classic' }, allowedBrand: null, audience: 'adult' as const, field: 'highlights' as const }
    expect(phraseTruthVerdict('Hooded Sweatshirt Club', ctx).ok).toBe(false)
  })
})
