/**
 * itemHighlightWriterArrangement.test.ts — Fix round B2 (RULING W1-W2, superseding
 * itemHighlightWriterProvenance.test.ts, DELETED with the free-text parser it tested).
 *
 * REPRODUCES FIRST (per the task's own instruction): N3 from phase-b-review.md §4 — under the
 * PRIOR (deleted) free-text provenance mechanism, the identity unit "Girl Dad Shirt" could be
 * reordered plus glue-inserted into "Dad Shirt for Girls" and SHIP. `six.mts` — under the PRIOR
 * (deleted) acceptance harness, all six B0DSCDZC6K "accepted" lines were rejected by the REAL
 * `runIhTail` as under-floor, proving the acceptance tested a mock. Both were reproduced live at
 * HEAD `f6ea1f1` (before this round's edits) via `tsx` against the two probes named in the rulings
 * (`r4/judge39.mts`, `r4/six.mts`) — pasted in phase-b-report.md's "Fix round B2" section.
 *
 * THE CURE THIS FILE TESTS (spec §2b, ruling W1): the writer no longer returns text. It returns an
 * ARRANGEMENT — ordered unit IDs + closed glue tokens — and code renders it VERBATIM. There is no
 * model text for a parser to be fooled by, so N3's mechanism (and N4/N5/N6/N7/N8/N9/N10/N11/N15/N16)
 * is not merely re-caught by a tighter rule — it has NO OPERATION in this model that could produce
 * it: rendering never reorders, splits, or partially uses a unit; the only permitted mutation is a
 * numberable unit's trailing garment-head noun (singular/plural).
 */
import { describe, it, expect } from 'vitest'
import { ihFoldWord } from '@/lib/fba/productDetailAttrs'
import { phraseTruthVerdict, type PhraseTruthCtx } from '@/lib/fba/contentTruth'
import {
  buildAdmittedUnits, validateArrangement, renderArrangement, judgeWriterArrangement,
  GLUE_WORDS, GLUE_PUNCTUATION, NEVER_GLUE_WORDS, WRITER_TRUTH_REGEXES,
  type AdmittedUnit, type ArrangementPart,
} from '@/lib/fba/itemHighlightWriter'

const TEE_ADULT: PhraseTruthCtx = {
  garmentFamily: 'tee', spec: { material: '100% Ring-Spun Cotton', fit: 'Classic' },
  allowedBrand: null, audience: 'adult', field: 'highlights',
}

// ─── REPRODUCTION (N3): the prior mechanism's exact escape has NO operation in this model ────────

describe('reproduction: N3 (phase-b-review.md sec 4) — "Girl Dad Shirt" reordered into "Dad Shirt for Girls"', () => {
  it('folding every word of the LIE against the identity unit admits it at the TOKEN level (why the treadmill kept losing)', () => {
    const admittedTokens = new Set('Girl Dad Shirt'.split(/\s+/).map(ihFoldWord))
    const FUNCTION_WORDS = new Set(['for'])
    const lie = 'Dad Shirt for Girls'
    const results = lie.split(/\s+/).map((w) => ({ w, admitted: admittedTokens.has(ihFoldWord(w)) || FUNCTION_WORDS.has(ihFoldWord(w)) }))
    expect(results.every((r) => r.admitted), JSON.stringify(results)).toBe(true)
  })

  it('the CURE: under the arrangement model, the identity unit "Girl Dad Shirt" can only render its OWN word order — no arrangement over it (alone, or with glue) equals the reordered lie', () => {
    const units: AdmittedUnit[] = buildAdmittedUnits(
      { candidates: [], specFacts: [], brandPick: null, wearFact: null },
      { designName: 'Girl Dad Shirt', truthCtx: { ...TEE_ADULT, designTokens: ['Girl Dad'] } },
    )
    const identityUnit = units.find((u) => u.kind === 'identity')!
    expect(identityUnit.text).toBe('Girl Dad Shirt')
    // The UNIT renders verbatim, in its own order, with or without glue around it — there is no
    // "reorder" operation available at all.
    const bareRender = renderArrangement([{ unit: identityUnit.id }], units)
    expect(bareRender).toBe('Girl Dad Shirt')
    for (const glue of [...GLUE_WORDS]) {
      const withGlueBefore = renderArrangement([{ glue }, { unit: identityUnit.id }], units)
      const withGlueAfter = renderArrangement([{ unit: identityUnit.id }, { glue }], units)
      expect(withGlueBefore.toLowerCase()).not.toBe('dad shirt for girls')
      expect(withGlueAfter.toLowerCase()).not.toBe('dad shirt for girls')
    }
    // Exhaustively: no permutation of {the identity unit} with any single closed glue token
    // (word or punctuation, before/after/between — there IS only one unit here, so "between" is
    // moot) renders the reordered lie. The mechanism has no foothold because rendering never
    // reorders a unit's own text.
    expect(anyArrangementRenders('Dad Shirt for Girls', units)).toBe(false)
  })
})

// ─── REPRODUCTION (six.mts): the acceptance harness must run through the REAL tail ────────────────

describe('reproduction: six.mts — the acceptance harness must prove the WIRE, not a passthrough mock', () => {
  it('a passthrough stub tail (`{value: line, hold: null}`) accepts a 67-73c line the real floor (97) would refuse — this is WHY W3 requires every acceptance test to call the real runIhTail', () => {
    const passthroughTail = (line: string) => ({ value: line, hold: null as string | null })
    const shortLine = "Don't Quit Cozy Graphic Sweatshirt with Pullover Comfort, Unisex Fit" // 68c, from the review's own six.mts
    expect(shortLine.length).toBeLessThan(97)
    // The mock says accepted...
    expect(passthroughTail(shortLine).value).toBe(shortLine)
    // ...but a floor door keyed to the REAL contract minimum refuses it — this is what the real
    // `runIhTail` does (itemHighlightWriterRunAcceptance.test.ts's W3 tests assert this through the
    // ACTUAL function, not a re-implementation here).
    expect(shortLine.length < 97).toBe(true)
  })
})

// ─── W1: the closed glue list never collides with a truth claim (kept from B2 per ruling W1) ─────

describe('W1: the closed glue list', () => {
  it('never contains a NEVER-GLUE word (negation/quantifier/purity/pronoun)', () => {
    for (const w of NEVER_GLUE_WORDS) expect(GLUE_WORDS.has(w), w).toBe(false)
  })

  it('no glue word matches any EXPORTED truth regex (audience, lean, fibre, fit, capability, purity) — a colliding lexicon word would silently exempt a real claim from every downstream judgment', () => {
    for (const glue of GLUE_WORDS) {
      for (const [label, re] of Object.entries(WRITER_TRUTH_REGEXES)) {
        const fresh = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g')
        expect(fresh.test(glue), `glue word "${glue}" must not match ${label}`).toBe(false)
      }
    }
  })

  it('GLUE_WORDS and GLUE_PUNCTUATION are disjoint (no symbol is also a "word")', () => {
    for (const p of GLUE_PUNCTUATION) expect(GLUE_WORDS.has(p)).toBe(false)
  })
})

// ─── W1: validateArrangement — rules (a)-(d) ──────────────────────────────────────────────────────

describe('W1: validateArrangement', () => {
  const units: AdmittedUnit[] = buildAdmittedUnits(
    { candidates: ['Cozy Graphic Sweatshirt', 'Pullover Comfort'], specFacts: ['Classic Fit'], brandPick: null, wearFact: null },
    { designName: 'Don\'t Quit', truthCtx: { garmentFamily: 'sweatshirt', spec: { material: 'Cotton/Poly', fit: 'Classic' }, allowedBrand: null, audience: 'adult', field: 'highlights' } },
  )
  const u0 = units[0].id

  it('rejects a malformed payload (not {"parts":[...]})', () => {
    expect(validateArrangement({ line: 'nope' }, units)).toMatchObject({ ok: false })
    expect(validateArrangement(null, units)).toMatchObject({ ok: false })
    expect(validateArrangement({ parts: [] }, units)).toMatchObject({ ok: false })
  })

  it('(a) rejects a unit id that does not exist', () => {
    const v = validateArrangement({ parts: [{ unit: 'u999' }] }, units)
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.violation).toMatch(/does not exist/)
  })

  it('(b) rejects a unit used twice', () => {
    const v = validateArrangement({ parts: [{ unit: u0 }, { glue: 'with' }, { unit: u0 }] }, units)
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.violation).toMatch(/more than once/)
  })

  it('(c) rejects a glue token outside the closed glue/punctuation set', () => {
    const v = validateArrangement({ parts: [{ unit: u0 }, { glue: 'because' }] }, units)
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.violation).toMatch(/outside the closed/)
  })

  it('(c)/(f) accepts every closed glue token in a grammatically LEGAL position (spec §2c) — a relation must introduce a spec-fact unit, a list join may introduce any unit; "a"/"an" is tested separately (RULING K6: never legal standing alone, only riding a join)', () => {
    const specUnit = units.find((u) => u.kind === 'spec-fact')!.id // 'Classic Fit'
    const poolUnit = units.find((u) => u.kind === 'pool')!.id // 'Cozy Graphic Sweatshirt' — not u0
    for (const g of [...GLUE_WORDS, ...GLUE_PUNCTUATION].filter((w) => w !== 'a' && w !== 'an')) {
      const rightUnit = g === 'with' || g === 'in' ? specUnit : poolUnit
      const v = validateArrangement({ parts: [{ unit: u0 }, { glue: g }, { unit: rightUnit }] }, units)
      expect(v.ok, `glue "${g}" should validate: ${!v.ok ? v.violation : ''}`).toBe(true)
    }
  })

  it('(f) a RELATION join ("with"/"in") to a non-spec unit is a named grammar violation (spec §2c rule 3)', () => {
    const poolUnit = units.find((u) => u.kind === 'pool')!.id
    const v = validateArrangement({ parts: [{ unit: u0 }, { glue: 'with' }, { unit: poolUnit }] }, units)
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.violation).toMatch(/must introduce a spec fact/)
  })

  it('(f) two units ABUTTING with no glue is legal ONLY when the right-hand unit is a garment-head unit (spec §2c rule 1)', () => {
    const garmentHead = units.find((u) => u.kind === 'garment-head')!.id
    const poolUnit = units.find((u) => u.kind === 'pool')!.id
    expect(validateArrangement({ parts: [{ unit: u0 }, { unit: garmentHead }] }, units).ok).toBe(true)
    const v = validateArrangement({ parts: [{ unit: u0 }, { unit: poolUnit }] }, units)
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.violation).toMatch(/abut with no join/)
  })

  it('(f) no glue or punctuation may open or close the line (spec §2c rule 4 / RULING G9)', () => {
    const poolUnit = units.find((u) => u.kind === 'pool')!.id
    expect(validateArrangement({ parts: [{ glue: ',' }, { unit: u0 }, { glue: 'and' }, { unit: poolUnit }] }, units).ok).toBe(false)
    expect(validateArrangement({ parts: [{ unit: u0 }, { glue: 'and' }, { unit: poolUnit }, { glue: ',' }] }, units).ok).toBe(false)
  })

  it('(f) an article ("a"/"an") may sit only immediately before a spec unit, optionally riding a relation or list join (RULING G9)', () => {
    const specUnit = units.find((u) => u.kind === 'spec-fact')!.id
    const poolUnit = units.find((u) => u.kind === 'pool')!.id
    // "and a Classic Fit" — the spec's own §2c readability-ceiling example shape.
    expect(validateArrangement({ parts: [{ unit: u0 }, { glue: 'and' }, { glue: 'a' }, { unit: specUnit }] }, units).ok).toBe(true)
    // "with a <pool unit>" — the article precedes a NON-spec unit: illegal.
    const v = validateArrangement({ parts: [{ unit: u0 }, { glue: 'with' }, { glue: 'a' }, { unit: poolUnit }] }, units)
    expect(v.ok).toBe(false)
    // RULING K6: narrowed message — an article may only introduce a "Fit"/"Neck" spec fact.
    if (!v.ok) expect(v.violation).toMatch(/"Fit" or "Neck"/)
    // RULING K6: a BARE article with no preceding join is never legal, regardless of the
    // right-hand unit's kind (was silently accepted whenever that unit happened to be spec-class).
    const bare = validateArrangement({ parts: [{ unit: u0 }, { glue: 'a' }, { unit: specUnit }] }, units)
    expect(bare.ok).toBe(false)
    if (!bare.ok) expect(bare.violation).toMatch(/bare article/)
  })

  it('(g) [RULING G4] when the admitted units carry a brand unit, an arrangement omitting it is a named violation', () => {
    const withBrand = buildAdmittedUnits(
      { candidates: ['Cozy Graphic Tee'], specFacts: ['Classic Fit'], brandPick: 'Comfort Colors Tee', wearFact: null },
      { designName: 'Retro Sunset', truthCtx: { garmentFamily: 'tee', spec: { material: '100% Cotton', fit: 'Classic' }, allowedBrand: 'Comfort Colors', audience: 'adult', field: 'highlights' } },
    )
    const id = (t: string) => withBrand.find((u) => u.text === t)!.id
    const v = validateArrangement({ parts: [{ unit: id('Retro Sunset') }, { glue: ',' }, { unit: id('Cozy Graphic Tee') }] }, withBrand)
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.violation).toMatch(/missing required brand unit/)
    const withBrandOk = validateArrangement({ parts: [{ unit: id('Retro Sunset') }, { glue: ',' }, { unit: id('Comfort Colors Tee') }] }, withBrand)
    expect(withBrandOk.ok).toBe(true)
  })

  it('(d) rejects "number" on a unit whose last word is not a garment head noun', () => {
    const nonGarment = units.find((u) => !u.numberable)!
    const v = validateArrangement({ parts: [{ unit: nonGarment.id, number: 'plural' }] }, units)
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.violation).toMatch(/cannot take a number/)
  })

  it('(d) accepts "number" on a numberable unit', () => {
    const garmentHead = units.find((u) => u.kind === 'garment-head')!
    const v = validateArrangement({ parts: [{ unit: garmentHead.id, number: 'plural' }] }, units)
    expect(v.ok).toBe(true)
  })

  it('rejects an invalid "number" value', () => {
    const garmentHead = units.find((u) => u.kind === 'garment-head')!
    const v = validateArrangement({ parts: [{ unit: garmentHead.id, number: 'many' }] }, units)
    expect(v.ok).toBe(false)
  })

  it('rejects a part that is neither {"unit"} nor {"glue"}', () => {
    const v = validateArrangement({ parts: [{ text: 'hello' }] }, units)
    expect(v.ok).toBe(false)
  })
})

// ─── W1: renderArrangement — verbatim, glue spacing, punctuation attaches left ────────────────────

describe('W1: renderArrangement', () => {
  const units: AdmittedUnit[] = [
    { id: 'u0', text: 'Cozy Graphic Sweatshirt', kind: 'pool', numberable: false },
    { id: 'u1', text: 'Pullover Comfort', kind: 'pool', numberable: false },
    { id: 'u2', text: 'Unisex Fit', kind: 'spec-fact', numberable: false },
    { id: 'u3', text: 'Shirt', kind: 'garment-head', numberable: true },
  ]

  it('renders units VERBATIM, glue joined with single spaces', () => {
    const parts: ArrangementPart[] = [{ unit: 'u0' }, { glue: 'with' }, { unit: 'u1' }]
    expect(renderArrangement(parts, units)).toBe('Cozy Graphic Sweatshirt with Pullover Comfort')
  })

  it('comma punctuation attaches to the LEFT word — no space before it, one space after', () => {
    const parts: ArrangementPart[] = [{ unit: 'u0' }, { glue: ',' }, { unit: 'u2' }]
    expect(renderArrangement(parts, units)).toBe('Cozy Graphic Sweatshirt, Unisex Fit')
  })

  it('a unit is rendered exactly once even when the arrangement lists it once (sanity: no implicit repetition)', () => {
    const parts: ArrangementPart[] = [{ unit: 'u3' }]
    expect(renderArrangement(parts, units)).toBe('Shirt')
  })

  it('"number":"plural" toggles ONLY the numberable unit\'s trailing garment word, nothing else in the text', () => {
    const parts: ArrangementPart[] = [{ unit: 'u3', number: 'plural' }]
    expect(renderArrangement(parts, units)).toBe('Shirts')
  })

  it('"number":"singular" round-trips a plural garment-head unit back to singular', () => {
    const plural: AdmittedUnit[] = [{ id: 'p0', text: 'Sweatshirts', kind: 'garment-head', numberable: true }]
    expect(renderArrangement([{ unit: 'p0', number: 'singular' }], plural)).toBe('Sweatshirt')
  })

  it('number toggling never touches any OTHER word in a multi-word unit', () => {
    const compound: AdmittedUnit[] = [{ id: 'c0', text: 'Graphic Crewneck Sweatshirt', kind: 'pool', numberable: true }]
    expect(renderArrangement([{ unit: 'c0', number: 'plural' }], compound)).toBe('Graphic Crewneck Sweatshirts')
  })
})

// ─── W1: buildAdmittedUnits ────────────────────────────────────────────────────────────────────────

describe('W1: buildAdmittedUnits', () => {
  it('rejects an identity phrase that itself asserts an untrue fact — never laundered in just because it is the design\'s own vocabulary', () => {
    const ctx: PhraseTruthCtx = { garmentFamily: 'tee', spec: { material: '100% Ring-Spun Cotton', fit: 'Classic' }, allowedBrand: null, audience: 'adult', field: 'highlights' }
    const units = buildAdmittedUnits({ candidates: [], specFacts: [], brandPick: null, wearFact: null }, { designName: 'Hooded Sweatshirt Club', truthCtx: ctx })
    expect(units.find((u) => u.kind === 'identity')).toBeUndefined()
  })

  it('every unit gets a stable, unique id in construction order', () => {
    const units = buildAdmittedUnits(
      { candidates: ['A', 'B'], specFacts: ['C'], brandPick: 'D', wearFact: 'E' },
      { designName: 'Name', truthCtx: { garmentFamily: 'tee', spec: { material: '100% Cotton', fit: 'Classic' }, allowedBrand: null, audience: 'adult', field: 'highlights' } },
    )
    const ids = units.map((u) => u.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toEqual(units.map((_, i) => `u${i}`))
  })

  it('adds the family\'s garment head noun(s) as single-word units, EVERY one numberable BY CONSTRUCTION (rule (a))', () => {
    for (const garmentFamily of ['tee', 'sweatshirt', 'hoodie'] as const) {
      const units = buildAdmittedUnits({ candidates: [], specFacts: [], brandPick: null, wearFact: null }, {
        truthCtx: { garmentFamily, spec: { material: '100% Cotton', fit: 'Classic' }, allowedBrand: null, audience: 'adult', field: 'highlights' },
      })
      const heads = units.filter((u) => u.kind === 'garment-head')
      expect(heads.length, garmentFamily).toBeGreaterThan(0)
      for (const h of heads) expect(h.numberable, `${garmentFamily}: "${h.text}"`).toBe(true)
    }
  })

  it('a non-apparel family ("none") gets ZERO garment-head units', () => {
    const units = buildAdmittedUnits({ candidates: [], specFacts: [], brandPick: null, wearFact: null }, {
      truthCtx: { garmentFamily: 'none', spec: null, allowedBrand: null, audience: null, field: 'highlights' },
    })
    expect(units.filter((u) => u.kind === 'garment-head')).toHaveLength(0)
  })

  // RULING K3 (fix round B4, truth Important "the vision channel"): identity units are the design
  // name ONLY — vision phrases (`identityPhrases`) are no longer admitted as identity units at all,
  // superseding this test's prior "dedupes design name vs. a vision phrase" scenario. A vision
  // phrase can still reach the line, but only as a truth-filtered composer POOL candidate.
  it('identity is the design name ONLY — identityPhrases never produces a second identity unit, even a 2+ word one', () => {
    const ctx: PhraseTruthCtx = { garmentFamily: 'tee', spec: { material: '100% Cotton', fit: 'Classic' }, allowedBrand: null, audience: 'adult', field: 'highlights' }
    const units = buildAdmittedUnits({ candidates: [], specFacts: [], brandPick: null, wearFact: null }, {
      designName: 'Girl Dad', identityPhrases: ['girl dad', 'Girl Dad Life'], truthCtx: ctx,
    })
    const identityTexts = units.filter((u) => u.kind === 'identity').map((u) => u.text)
    expect(identityTexts).toEqual(['Girl Dad'])
  })
})

// ─── EXHAUSTIVE SEARCH HELPER (test-only — NOT a parser; a brute-force feasibility oracle for
// asserting an EXACT target string cannot be reached by ANY arrangement over a small, fixed unit
// set). Never used in production code — see the module header for why a "parser" is exactly what
// this round deletes. ──────────────────────────────────────────────────────────────────────────────

function* permutations<T>(arr: readonly T[]): Generator<T[]> {
  if (arr.length <= 1) { yield [...arr]; return }
  for (let i = 0; i < arr.length; i++) {
    const rest = [...arr.slice(0, i), ...arr.slice(i + 1)]
    for (const p of permutations(rest)) yield [arr[i], ...p]
  }
}
function cartesian<T>(choices: readonly T[], length: number): T[][] {
  if (length <= 0) return [[]]
  const rest = cartesian(choices, length - 1)
  const out: T[][] = []
  for (const c of choices) for (const r of rest) out.push([c, ...r])
  return out
}
function anyArrangementRenders(target: string, units: readonly AdmittedUnit[]): boolean {
  const targetNorm = target.trim().toLowerCase()
  const gluePool: (string | null)[] = [null, ...GLUE_WORDS, ...GLUE_PUNCTUATION]
  const n = units.length
  for (let mask = 1; mask < (1 << n); mask++) {
    const subset = units.filter((_, i) => mask & (1 << i))
    for (const ordering of permutations(subset)) {
      const gapCount = ordering.length - 1
      for (const gaps of cartesian(gluePool, gapCount)) {
        const parts: ArrangementPart[] = []
        ordering.forEach((u, i) => {
          parts.push({ unit: u.id })
          if (i < gapCount && gaps[i]) parts.push({ glue: gaps[i] as string })
        })
        if (renderArrangement(parts, units).trim().toLowerCase() === targetNorm) return true
      }
    }
  }
  return false
}

// ─── W2: parity — the 12 NEW lies from phase-b-review.md sec 4 are UNREACHABLE by any arrangement ──

describe('W2: the 12 new adversarial lines (N1,N3-N11,N15,N16) are unrenderable — no operation produces them', () => {
  const GD = (): PhraseTruthCtx => ({ garmentFamily: 'tee', spec: { material: '100% Ring-Spun Cotton', fit: 'Classic' }, allowedBrand: null, audience: 'adult', designTokens: ['Girl Dad'], field: 'highlights' })
  const ident = (id: string, text: string): AdmittedUnit => ({ id, text, kind: 'identity', numberable: false })
  const pool = (id: string, text: string): AdmittedUnit => ({ id, text, kind: 'pool', numberable: false })
  const fact = (id: string, text: string): AdmittedUnit => ({ id, text, kind: 'spec-fact', numberable: false })

  const CASES: { id: string; units: AdmittedUnit[]; target: string }[] = [
    { id: 'N1', units: [ident('u0', 'Girl Dad'), pool('u1', 'Little Girl Dad Shirt'), pool('u2', 'Soft Graphic Tee')], target: 'Girl Dad Soft Graphic Tee for Your Little Girl' },
    { id: 'N3', units: [ident('u0', 'Girl Dad'), ident('u1', 'Girl Dad Shirt'), pool('u2', 'Soft Everyday Cotton Feel')], target: 'Dad Shirt for Girls' },
    { id: 'N4', units: [ident('u0', 'Baby Shark'), ident('u1', 'Baby Shark Tee'), pool('u2', 'Soft Everyday Cotton Feel')], target: 'Shark Tee for Baby' },
    { id: 'N5', units: [ident('u0', 'Girls Trip'), ident('u1', 'Girls Trip Tee'), pool('u2', 'Soft Everyday Cotton Feel')], target: 'Trip Tee for Girls' },
    { id: 'N6', units: [ident('u0', 'Girl Dad'), pool('u1', 'Shirt For Dad Of Girls'), pool('u2', 'Soft Everyday Cotton Feel')], target: 'Shirt from Dad for Girls' },
    { id: 'N7', units: [pool('u0', 'Cozy Crewneck Sweatshirt'), fact('u1', '52% Cotton / 48% Polyester'), pool('u2', 'Brushed Fleece Lining')], target: 'Cozy Crewneck Sweatshirt with 48% Cotton / 52% Polyester' },
    { id: 'N8', units: [pool('u0', 'Cozy Crewneck Sweatshirt'), pool('u1', 'Midweight 8.0 Oz Fleece')], target: 'Cozy Crewneck Sweatshirt in Midweight 0.8 Oz Fleece' },
    { id: 'N9', units: [pool('u0', 'No Polyester Feel'), pool('u1', 'Soft Graphic Tee')], target: 'Soft Graphic Tee with Polyester Feel' },
    { id: 'N10', units: [pool('u0', 'Soft Cotton-Like Feel'), pool('u1', 'Smooth Graphic Tee')], target: 'Smooth Graphic Tee with Soft Cotton Feel' },
    { id: 'N11', units: [pool('u0', 'Pure Joy Sweatshirt'), pool('u1', 'Soft Cotton Feel'), pool('u2', 'Cozy Crewneck Sweatshirt')], target: 'Pure Soft Cotton Feel' },
    { id: 'N15', units: [ident('u0', 'Girl Dad'), pool('u1', 'Dad Of Girls Gift'), pool('u2', 'Soft Graphic Tee')], target: 'Gift for Dad and Girls' },
    { id: 'N16', units: [ident('u0', 'Girl Dad'), pool('u1', 'Gift For Dad Of Little Ones'), pool('u2', 'Soft Graphic Tee')], target: 'Girl Dad Soft Graphic Tee for Little Ones' },
  ]

  for (const c of CASES) {
    it(`${c.id}: "${c.target}" cannot be rendered from [${c.units.map((u) => u.text).join(' | ')}]`, () => {
      expect(anyArrangementRenders(c.target, c.units), `${c.id} should be UNREACHABLE`).toBe(false)
    })
  }

  it('N18 (true control): the search itself CAN find a valid honest re-word — proving the negative results above are not an artifact of a broken search', () => {
    const units = [ident('u0', 'Girl Dad'), pool('u1', 'Dad of Girls Gift'), pool('u2', 'Soft Graphic Tee')]
    expect(anyArrangementRenders('Girl Dad Soft Graphic Tee, Dad of Girls Gift', units)).toBe(true)
  })

  it('sanity: GD() is a valid PhraseTruthCtx builder used only for documentation parity with phase-b-review.md\'s row shapes', () => {
    expect(GD().designTokens).toEqual(['Girl Dad'])
  })
})

// ─── W2: parity for a picker-bounded row — the writer ships it ONLY because the picker already could

describe('W2: picker-bounded rows (A4-class) — the writer\'s admission verdict on a VERBATIM unit equals the picker\'s own', () => {
  it('a pool unit that IS itself an admissible phrase renders (and ships) — the writer never becomes MORE permissive than the composer that supplied the unit', () => {
    const ctx: PhraseTruthCtx = { garmentFamily: 'tee', spec: { material: '100% Ring-Spun Cotton', fit: 'Classic' }, allowedBrand: null, audience: 'adult', designTokens: ['Girl Dad'], field: 'highlights' }
    const phrase = 'Great Tee For Girls' // admissible under the composer's OWN design-own-word rule (I1, FILED) — same as the picker would ship verbatim.
    expect(phraseTruthVerdict(phrase, ctx).ok).toBe(true) // the PICKER's verdict
    const units = buildAdmittedUnits({ candidates: [phrase], specFacts: [], brandPick: null, wearFact: null }, { designName: 'Girl Dad', truthCtx: ctx })
    const unit = units.find((u) => u.text === phrase)!
    // The WRITER's verdict: rendering this exact unit verbatim is not a NEW recombination — it is
    // the identical phrase the picker already admitted. Parity holds by construction: the unit only
    // exists because the composer's OWN admission put it in `candidates`.
    expect(renderArrangement([{ unit: unit.id }], units)).toBe(phrase)
  })
})

// ─── judgeWriterArrangement: the full pipe end-to-end on a stub tail ──────────────────────────────

describe('judgeWriterArrangement (validate -> render -> tail -> readability)', () => {
  const units: AdmittedUnit[] = buildAdmittedUnits(
    { candidates: ['Cozy Graphic Sweatshirt', 'Pullover Comfort', 'Extra Long Weekend Layer'], specFacts: ['Classic Fit', 'Unisex Fit'], brandPick: null, wearFact: null },
    { designName: "Don't Quit", truthCtx: { garmentFamily: 'sweatshirt', spec: { material: 'Cotton/Poly', fit: 'Classic' }, allowedBrand: null, audience: 'adult', field: 'highlights' } },
  )
  const passthroughTail = (line: string) => ({ value: line, hold: null as string | null, reason: null as string | null })

  it('a malformed arrangement is rejected with a named "arrangement:" violation', () => {
    const v = judgeWriterArrangement({ line: 'not an arrangement' }, units, { truthCtx: { garmentFamily: 'sweatshirt', spec: null, allowedBrand: null, audience: 'adult', field: 'highlights' }, runTail: passthroughTail })
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.violations.join(' ')).toMatch(/^arrangement:/)
  })

  it('a valid arrangement that the tail refuses reports the TAIL\'s reason (not the arrangement layer)', () => {
    const rejectingTail = (_line: string) => ({ value: '', hold: 'under-floor' as string | null, reason: 'material-lie' })
    // RULING K1 (fix round B4): the judge's OWN band/repeat pre-checks now run BEFORE the tail is
    // ever called, so this arrangement must itself clear the 97-125 band and carry no significant
    // repeat — otherwise the pre-check's OWN message would fire first, never reaching the stub tail.
    const designId = units.find((u) => u.kind === 'identity')!.id
    const poolA = units.find((u) => u.text === 'Cozy Graphic Sweatshirt')!.id
    const poolB = units.find((u) => u.text === 'Pullover Comfort')!.id
    const poolC = units.find((u) => u.text === 'Extra Long Weekend Layer')!.id
    const specA = units.find((u) => u.text === 'Classic Fit')!.id
    const specB = units.find((u) => u.text === 'Unisex Fit')!.id
    const parts = [
      { unit: designId }, { glue: ',' }, { unit: poolA }, { glue: ',' }, { unit: poolB }, { glue: ',' }, { unit: poolC },
      { glue: ',' }, { unit: specA }, { glue: 'and' }, { unit: specB },
    ]
    const v = judgeWriterArrangement({ parts }, units, { truthCtx: { garmentFamily: 'sweatshirt', spec: { material: 'Cotton/Poly', fit: 'Classic' }, allowedBrand: null, audience: 'adult', field: 'highlights' }, runTail: rejectingTail })
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.violations.join(' ')).toMatch(/tail: refused \(material-lie\)/)
  })

  it('a valid, tail-accepted, readable arrangement passes end to end', () => {
    // Grammar-legal (spec §2c): LIST joins ('and'/',') between the identity and two pool units,
    // then a RELATION join ('with') introducing a SPEC-fact unit — never a bare identity-pool
    // abutment or a relation onto a non-spec unit (both now named grammar violations, see the
    // describe block above). RULING K1: also clears the 97-125 band and carries no repeat, since
    // the judge checks those itself before ever calling the (here, pass-through) tail. RULING K7:
    // only ONE comma-clause lacks a relation word ("Don't Quit and Cozy Graphic Sweatshirt and
    // Pullover Comfort"), so it reads as one sentence, not a keyword dump.
    const designId = units.find((u) => u.kind === 'identity')!.id
    const poolA = units.find((u) => u.text === 'Cozy Graphic Sweatshirt')!.id
    const poolB = units.find((u) => u.text === 'Pullover Comfort')!.id
    const poolC = units.find((u) => u.text === 'Extra Long Weekend Layer')!.id
    const factId = units.find((u) => u.text === 'Classic Fit')!.id
    const parts = [
      { unit: designId }, { glue: 'and' }, { unit: poolA }, { glue: 'and' }, { unit: poolB },
      { glue: ',' }, { unit: poolC }, { glue: 'with' }, { unit: factId },
    ]
    const v = judgeWriterArrangement({ parts }, units, { truthCtx: { garmentFamily: 'sweatshirt', spec: { material: 'Cotton/Poly', fit: 'Classic' }, allowedBrand: null, audience: 'adult', field: 'highlights' }, runTail: passthroughTail })
    expect(v.ok, JSON.stringify(!v.ok && v.violations)).toBe(true)
  })
})
