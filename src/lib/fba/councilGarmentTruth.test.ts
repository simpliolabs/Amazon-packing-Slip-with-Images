/**
 * councilGarmentTruth.test.ts — PO 2026-08-22, verbatim: "Make sure the Council/Judges can read the
 * garment field."
 *
 * WHY THIS FILE EXISTS. PR #632 shipped a truth+band NET that deletes a garment lie ("Funny Work
 * Shirts" on a sweatshirt family) from the SHIPPED title after the council writes it, then re-pads
 * the band. That cures the symptom but leaves the council still WRITING the lie and burning a
 * candidate slot on it — the producer never saw the product's truth, only the door did.
 *
 * This pins the fix: `buildApparelTitleBrief` now renders a GARMENT TRUTH constraint (STATE
 * CONSTRAINTS, NOT EXEMPLARS — no sample title to parrot, per the editorial-audit-prompt-leak
 * lesson) from the SAME `PhraseTruthCtx` spine ctx the #632 net judges the shipped title with
 * (`contentTruth.ts`'s `garmentNounConstraint`, no second resolver); and `titleQualityJudge` — THE
 * one deterministic title measurement and the arbiter for both producer-side actors (the council's
 * fail-open winner-pick and the humanizer's adopt gate) — now caps a garment-lying candidate's score
 * so it can never outscore a truthful one.
 *
 * The #632 net (`applyTitleTruthNet`) is UNCHANGED — it stays as defense in depth. This file does
 * not touch it or its tests (contentTruthSpine.test.ts, titleTruthNetGate.test.ts).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildApparelTitleBrief, titleQualityJudge } from './listingPipeline'
import { audienceOfGarmentFamily, type PhraseTruthCtx } from './contentTruth'

/* ── Fixtures — the same shape contentTruthSpine.test.ts's SWEATS/TEE fixtures use ────────────── */

/** A Gildan 18000+18500 mixed sweatshirt/hoodie family — the live B0DSCDZC6K shape. */
const SWEATSHIRT: PhraseTruthCtx = {
  garmentFamily: 'sweatshirt',
  spec: { weightNote: 'heavyweight 8.0 oz fleece', neck: 'Crew Neck', sleeve: 'Long Sleeve', material: '50% Cotton / 50% Polyester' },
  allowedBrand: 'Gildan 18000',
  audience: audienceOfGarmentFamily('sweatshirt'),
  audienceLean: null,
  field: 'title',
}
const KIDS_TEE: PhraseTruthCtx = {
  garmentFamily: 'kids_tee',
  spec: { weightNote: 'lightweight 4.5 oz ring-spun' },
  allowedBrand: null,
  audience: audienceOfGarmentFamily('kids_tee'),
  audienceLean: null,
  field: 'title',
}
const baseCtx = {
  brandName: 'THE CEO',
  roleLine: 'You write Amazon apparel titles for THE CEO.',
  inputBlock: 'Brand: THE CEO\nDesign phrase (identity — KEEP this exact phrase in the title): Fall Vibes',
}

describe('buildApparelTitleBrief — GARMENT TRUTH constraint (STATE CONSTRAINTS, NOT EXEMPLARS)', () => {
  it('a sweatshirt-family brief states the sweatshirt constraint and the forbidden-noun list', () => {
    const { user } = buildApparelTitleBrief({ ...baseCtx, truth: SWEATSHIRT })
    expect(user).toContain('GARMENT TRUTH')
    expect(user).toContain('this product IS a SWEATSHIRT')
    // The spec facts thread through — brand/neck/sleeve/material, not just the family name.
    expect(user).toContain('Gildan 18000')
    expect(user).toContain('Crew Neck')
    expect(user).toContain('Long Sleeve')
    // Forbidden nouns are TEE-class words + hoodie (a sweatshirt is not a hoodie; a hoodie IS a
    // sweatshirt — the asymmetry contentTruth.ts's classesForFamily already encodes).
    expect(user).toMatch(/NEVER call it:[^.]*\bshirt\b/)
    expect(user).toMatch(/NEVER call it:[^.]*\btee\b/)
    expect(user).toMatch(/NEVER call it:[^.]*\bt-shirt\b/)
    expect(user).toMatch(/NEVER call it:[^.]*\bhoodie\b/)
    expect(user).toMatch(/may be called:[^.]*\bsweatshirt\b/)
  })

  it('a kids_tee family brief carries the kids audience, not just the garment noun', () => {
    const { user } = buildApparelTitleBrief({ ...baseCtx, truth: KIDS_TEE })
    expect(user).toContain('this product IS a KIDS TEE')
    expect(user).toContain('KIDS garment')
    expect(user).toMatch(/adult-only audience/)
  })

  it('CONSTRAINTS, NOT EXEMPLARS — the line states the fact and the ban, never a worked title', () => {
    const { user } = buildApparelTitleBrief({ ...baseCtx, truth: SWEATSHIRT })
    const line = (user.split('\n').find((l) => l.includes('GARMENT TRUTH')) ?? '')
    // No brand-front sample string, no pipe-separated worked example, on the garment-truth line itself.
    expect(line).not.toMatch(/THE CEO .*\|/)
  })

  it('unresolved blank / no truth threaded ⇒ byte-identical to every pre-2026-08-22 caller', () => {
    const withoutTruth = buildApparelTitleBrief({ ...baseCtx })
    const withNullTruth = buildApparelTitleBrief({ ...baseCtx, truth: null })
    expect(withoutTruth).toEqual(withNullTruth)
    expect(withoutTruth.user).not.toContain('GARMENT TRUTH')
  })

  it('a non-apparel / garmentFamily "none" ctx renders no garment rule (fails open like the predicate)', () => {
    const none: PhraseTruthCtx = { garmentFamily: 'none', spec: null, allowedBrand: null, audience: null, audienceLean: null, field: 'title' }
    const { user } = buildApparelTitleBrief({ ...baseCtx, truth: none })
    expect(user).not.toContain('GARMENT TRUTH')
  })
})

describe('titleQualityJudge — a garment-lying candidate cannot win (deterministic, fixed candidates)', () => {
  const LYING = 'THE CEO Fall Vibes Funny Work Shirts | Comfort Colors Tee for Women'
  const TRUTHFUL = 'THE CEO Fall Vibes Cozy Crewneck Sweatshirt | Autumn Pullover for Women'

  it('the truthful candidate outscores the garment-lying one on the SAME family', () => {
    const lyingVerdict = titleQualityJudge(LYING, { brandName: 'THE CEO', truth: SWEATSHIRT })
    const truthfulVerdict = titleQualityJudge(TRUTHFUL, { brandName: 'THE CEO', truth: SWEATSHIRT })
    expect(truthfulVerdict.score).toBeGreaterThan(lyingVerdict.score)
    // Decisive, not a graded nudge: capped low enough that no other bonus stack can buy it back.
    expect(lyingVerdict.score).toBeLessThanOrEqual(15)
    expect(lyingVerdict.problems.some((p) => p.includes('garment truth violation'))).toBe(true)
  })

  it('the SAME candidate scores unchanged when no truth ctx is threaded (backward-compatible)', () => {
    const noTruth = titleQualityJudge(LYING, { brandName: 'THE CEO' })
    const nullTruth = titleQualityJudge(LYING, { brandName: 'THE CEO', truth: null })
    expect(noTruth).toEqual(nullTruth)
    expect(noTruth.score).toBeGreaterThan(15)   // no cap fires — every existing caller/test unaffected
  })

  it('a candidate naming only the TRUE family is never capped', () => {
    const v = titleQualityJudge(TRUTHFUL, { brandName: 'THE CEO', truth: SWEATSHIRT })
    expect(v.problems.some((p) => p.includes('garment truth violation'))).toBe(false)
  })
})

/* ── PATH PARITY (INVARIANT 1): single-design (runTitleAgent) and multi-design/per-design
 * (buildNicheParentTitle, which also feeds the per-design title loop via buildTitleFor) both wire
 * the SAME truth ctx into the SAME brief builder / council judge / humanizer — mirrors the source-pin
 * idiom contentTruthSpine.test.ts already uses for the #632 net's own truth ctx. Neither producer is
 * exported (an OpenAI-mocked end-to-end call would dwarf what a source pin proves here), so this
 * checks the wiring the way that file already does for the sibling invariant. */
describe('single-design and multi-design title producers both thread the garment-truth ctx', () => {
  const src = readFileSync(join(process.cwd(), 'src', 'lib', 'fba', 'listingPipeline.ts'), 'utf8')

  it('runTitleAgent and buildNicheParentTitle both accept the truth ctx as a parameter', () => {
    for (const producer of ['runTitleAgent', 'buildNicheParentTitle']) {
      const at = src.indexOf(`async function ${producer}(`)
      expect(at, `${producer} not found`).toBeGreaterThan(0)
      const body = src.slice(at, at + 5000)
      expect(body, `${producer} does not accept the truth ctx`).toContain('truth: PhraseTruthCtx | null = null')
    }
  })

  it('every buildApparelTitleBrief call site threads truth (single-design ×2 + multi-design ×2)', () => {
    const callSites: number[] = []
    for (let idx = src.indexOf('buildApparelTitleBrief({'); idx !== -1; idx = src.indexOf('buildApparelTitleBrief({', idx + 1)) {
      callSites.push(idx)
    }
    expect(callSites.length).toBe(4)
    for (const at of callSites) {
      const window = src.slice(at, at + 1000)
      expect(window, `buildApparelTitleBrief call at offset ${at} does not thread truth`).toMatch(/\n\s*truth,/)
    }
  })

  it('every runTitleCouncil call site forwards truth to the deterministic judge', () => {
    const callSites: number[] = []
    for (let idx = src.indexOf('await runTitleCouncil(openai'); idx !== -1; idx = src.indexOf('await runTitleCouncil(openai', idx + 1)) {
      callSites.push(idx)
    }
    expect(callSites.length).toBe(2)   // single-design (runTitleAgent) + multi-design (buildNicheParentTitle)
    for (const at of callSites) {
      const line = src.slice(at, src.indexOf('\n', at))
      expect(line, `runTitleCouncil call at offset ${at} does not forward truth`).toMatch(/\btruth\s*\}\)/)
    }
  })

  it('every humanizeTitleTo75 call site forwards truth to the adopt-gate judge', () => {
    const callSites: number[] = []
    for (let idx = src.indexOf('humanizeTitleTo75(openai'); idx !== -1; idx = src.indexOf('humanizeTitleTo75(openai', idx + 1)) {
      callSites.push(idx)
    }
    expect(callSites.length).toBe(2)   // single-design humanizer + multi-design parent humanizer
    for (const at of callSites) {
      const window = src.slice(at, at + 1800)
      expect(window, `humanizeTitleTo75 call at offset ${at} does not forward truth`).toMatch(/\n\s*truth,/)
    }
  })

  it('a family-level ctx renders the identical constraint whichever producer path builds the brief', () => {
    // The ctx is built ONCE from the resolved blank upstream (truthCtxFor / buildGroupTruthCtx in
    // listingPipeline.ts) and has no producer-specific field — buildApparelTitleBrief is the ONE
    // shared renderer both runTitleAgent and buildNicheParentTitle call, so passing the identical
    // ctx object must render the identical GARMENT TRUTH line regardless of caller.
    const single = buildApparelTitleBrief({ ...baseCtx, truth: SWEATSHIRT })
    const multi = buildApparelTitleBrief({
      ...baseCtx,
      roleLine: 'You write Amazon apparel titles for THE CEO. This one is the BROADCAST PARENT TITLE for a variation family.',
      truth: SWEATSHIRT,
    })
    const garmentLine = (s: string) => s.split('\n').find((l) => l.includes('GARMENT TRUTH')) ?? ''
    expect(garmentLine(single.user)).toBe(garmentLine(multi.user))
  })
})
