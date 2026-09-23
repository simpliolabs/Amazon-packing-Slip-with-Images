/**
 * itemHighlightWriterRunAcceptance.test.ts — Fix round B2 (RULING W3/W4/W7/W8, rewriting the Part 2
 * acceptance this file used to carry). B2/B6 mechanics kept; every "accepted, ships" claim W3
 * requires is now proven through the REAL `runIhTail` via `produceItemHighlights`/
 * `produceItemHighlightsPerDesign` themselves — those two functions hardcode the real tail
 * internally (only the OpenAI CLIENT is mockable, via `deps.openai`) — so a test that calls them
 * cannot accidentally prove a mock the way the deleted `passthroughTail` shape could (phase-b-
 * review.md I1, reproduced live pre-fix in `itemHighlightWriterArrangement.test.ts`'s "six.mts"
 * reproduction block).
 *
 * No probe or test here loads an env file or makes a live model call (B10) — every OpenAI client is
 * either a hand-rolled stub object passed via `deps.openai`, or the `openai` MODULE itself mocked.
 */
import { describe, it, expect, vi } from 'vitest'

const create = vi.fn(async () => { throw new Error('OpenAI must never be called when IH_WRITER is off') })
vi.mock('openai', () => ({ default: class MockOpenAI { chat = { completions: { create } } } } as never))

import {
  buildItemHighlights, buildItemHighlightsPerDesign, produceItemHighlights, produceItemHighlightsPerDesign,
} from './listingPipeline'
import {
  runWriterForDesign, writerReadabilityVerdict, ihWriterMode, ihWriterModel, ihWriterMaxCallsBudget, ihWriterDeadlineMs,
  buildAdmittedUnits, renderArrangement, IH_WRITER_RETRY_CAP, enumerateWriterCandidates,
  type AdmittedUnit,
} from './itemHighlightWriter'
import { CONTENT_CONTRACT } from './contentContract'
import { lineHasSignificantRepeat } from './productDetailAttrs'
import { DEFAULT_BLANK_SPECS } from './blankSpecs'
import type { AnalyzedKeyword } from '@/lib/keyword-engine'
import type { PhraseTruthCtx } from './contentTruth'

const kw = (keyword: string, searchVolume: number, themeFit: number | null): AnalyzedKeyword =>
  ({ keyword, searchVolume, themeFit } as unknown as AnalyzedKeyword)
/** Per-design rated variant (migration 061) — every design key gets the SAME fit (>=30% share,
 *  DESIGN_RATED_MIN_SHARE, easily cleared at 100%), so a per-design fixture actually COMPOSES
 *  instead of holding `designs-unrated`. */
const kwPD = (keyword: string, searchVolume: number, themeFit: number, designKeys: readonly string[]): AnalyzedKeyword =>
  ({
    keyword, searchVolume, themeFit,
    themeFitByDesign: Object.fromEntries(designKeys.map((k) => [k, { fit: themeFit, about: keyword }])),
  } as unknown as AnalyzedKeyword)
const CC = DEFAULT_BLANK_SPECS[0]
// Gildan (brandInCopy: false -> allowedBrand null, no mandatory-brand insertion) — used where a
// fixture needs REAL spec facts (material/fit, for RULING K7's relation-join requirement) without
// the brand-net side effects `blankBrand: null` (an unresolved blank, zero spec facts at all) or
// `CC` (a mandatory brand) would introduce.
const GILDAN = DEFAULT_BLANK_SPECS[1]

// ─── test-only helper: turns a JS arrangement of {unit|glue} into the JSON the model would return ─

function arrangementJson(parts: readonly (string | { glue: string })[]): unknown {
  return { parts: parts.map((p) => (typeof p === 'string' ? { unit: p } : p)) }
}
function stubArrangementClient(responses: unknown[]) {
  let i = 0
  const mockCreate = vi.fn(async () => {
    const parts = responses[Math.min(i, responses.length - 1)]
    i++
    return { choices: [{ message: { content: JSON.stringify(parts) }, finish_reason: 'stop' }] }
  })
  return { client: { chat: { completions: { create: mockCreate } } } as never, create: mockCreate }
}
/** RULING H4 (fix round H1): a client that always THROWS — a genuine transport/client error, the
 *  ONLY shape still worth a retry up to `IH_WRITER_RETRY_CAP` (a well-formed, successfully-parsed
 *  response with no "pick" key no longer retries at all — see `stubArrangementClient` callers that
 *  used to rely on a no-"pick" response spending the full cap). */
function stubThrowingClient() {
  const mockCreate = vi.fn(async () => { throw new Error('simulated client/transport failure') })
  return { client: { chat: { completions: { create: mockCreate } } } as never, create: mockCreate }
}

/** Greedily assembles a VALID arrangement (real admitted units, joined only with "and"/",") that
 *  renders within [min, max] — deterministic, order-preserving over `units`. Returns null if no
 *  such assembly exists from this exact unit list. Test-only: exercises the SAME `renderArrangement`
 *  production code renders with, never a parallel re-implementation of it. RULING G1 (spec §2c):
 *  joins are "and"/","/"with" — "and"/"," are LIST joins (legal between ANY two units); "with" is
 *  used whenever the RIGHT-hand piece is a spec-fact/brand/wear-fact unit (the only class a
 *  RELATION join may introduce). RULING K7 (fix round B4): readability now counts ONLY a relation
 *  word ("with"/"in") as a clause's connecting word — a chain of "and"s alone reads as a keyword
 *  dump — so at least one "with" (when the chosen pieces include a spec-kind unit, as every REAL
 *  admitted set with a resolved blank does) keeps that one clause non-keyword-shaped, while the
 *  trailing "," still gives the tail's sentence-shape rule its required 2nd phrase. */
function partsFor(pieces: readonly AdmittedUnit[]): (string | { glue: string })[] {
  const parts: (string | { glue: string })[] = []
  const SPEC_KIND = new Set(['spec-fact', 'brand', 'wear-fact'])
  pieces.forEach((u, i) => {
    parts.push(u.id)
    if (i < pieces.length - 1) {
      const isLast = i === pieces.length - 2
      // The LAST join is ALWAYS ',' — guarantees the tail's own sentence-shape rule (>=1 comma) —
      // even when the final piece happens to be spec-kind too.
      const nextIsSpec = !isLast && SPEC_KIND.has(pieces[i + 1].kind)
      parts.push({ glue: nextIsSpec ? 'with' : (isLast ? ',' : 'and') })
    }
  })
  return parts
}
function buildAcceptableArrangement(units: readonly AdmittedUnit[], min: number, max: number): { json: unknown; expected: string } | null {
  const chosen: AdmittedUnit[] = []
  for (const u of units) {
    const trial = [...chosen, u]
    const text = renderTrial(trial)
    if (text.length > max) continue
    // RULING K1 (fix round B4): skip a candidate that would trip the ABSOLUTE no-repeat rule
    // (`lineHasSignificantRepeat`, imported — never a copy) — e.g. an identity unit ("Later
    // Gator") and a pool phrase that happens to echo it ("See You Later Alligator") both carry
    // "later". A real composer's own Tier-A selection never admits this either; this helper stays
    // parity-bounded with production instead of accidentally building an arrangement the judge's
    // own pre-tail check (K1) must reject on its first attempt.
    if (lineHasSignificantRepeat(text)) continue
    chosen.push(u)
    if (text.length >= min) break
  }
  if (chosen.length < 2) return null
  const text = renderTrial(chosen)
  if (text.length < min || text.length > max) return null
  return { json: arrangementJson(partsFor(chosen)), expected: text }
}
function renderTrial(pieces: readonly AdmittedUnit[]): string {
  const arr = arrangementJson(partsFor(pieces)) as { parts: { unit?: string; glue?: string }[] }
  return renderArrangement(arr.parts.map((p) => (p.unit ? { unit: p.unit } : { glue: p.glue as string })), pieces)
}

// ─── B9: the flag ──────────────────────────────────────────────────────────────────────────────

describe('B9: IH_WRITER mode resolution', () => {
  it('unset or unrecognized -> off (the DEFAULT, unlike CONTENT_RECONCILE_ENABLED\'s shadow default)', () => {
    expect(ihWriterMode(undefined)).toBe('off')
    expect(ihWriterMode('')).toBe('off')
    expect(ihWriterMode('bogus')).toBe('off')
  })
  it('shadow/on recognized case-insensitively', () => {
    expect(ihWriterMode('shadow')).toBe('shadow')
    expect(ihWriterMode('SHADOW')).toBe('shadow')
    expect(ihWriterMode('on')).toBe('on')
    expect(ihWriterMode('ON')).toBe('on')
  })
  it('IH_WRITER_MODEL defaults to gpt-4.1', () => {
    expect(ihWriterModel(undefined)).toBe('gpt-4.1')
    expect(ihWriterModel('gpt-5')).toBe('gpt-5')
  })
  it('W8: IH_WRITER_MAX_CALLS (the per-regen budget) defaults to 18, parses a positive int, ignores garbage', () => {
    expect(ihWriterMaxCallsBudget(undefined)).toBe(18)
    expect(ihWriterMaxCallsBudget('5')).toBe(5)
    expect(ihWriterMaxCallsBudget('0')).toBe(18)
    expect(ihWriterMaxCallsBudget('-3')).toBe(18)
    expect(ihWriterMaxCallsBudget('bogus')).toBe(18)
    // RULING W5 (fix round B7b, wire minor 1): strict, like `ihWriterDeadlineMs` below —
    // `Number.parseInt` alone parses only a PREFIX, so '2.9' silently became 2 and '/api/health'
    // echoed a value nobody set (review B6/wire, health2.out.txt: "on/-/2.9/1e3 -> 2").
    expect(ihWriterMaxCallsBudget('2.9')).toBe(18)
    expect(ihWriterMaxCallsBudget('1e3')).toBe(18)
    expect(ihWriterMaxCallsBudget('18ms')).toBe(18)
    expect(ihWriterMaxCallsBudget('  5  ')).toBe(5)
  })
  it('IH_WRITER_RETRY_CAP (the PER-DESIGN retry cap) is 3 — distinct constant from the per-regen budget', () => {
    expect(IH_WRITER_RETRY_CAP).toBe(3)
  })
  // RULING P11 (fix round B5, minor 1, wire m1): `ihWriterDeadlineMs` must reject anything that
  // does not parse CLEANLY as a positive integer, not merely "parses a leading digit run" —
  // `Number.parseInt` alone silently turns '1e3' into 1 and '45000ms' into 45000.
  it('IH_WRITER_DEADLINE_MS defaults to 45000, parses a clean positive int, falls back on anything else', () => {
    expect(ihWriterDeadlineMs(undefined)).toBe(45_000)
    expect(ihWriterDeadlineMs('30000')).toBe(30_000)
    expect(ihWriterDeadlineMs('0')).toBe(45_000)
    expect(ihWriterDeadlineMs('-5')).toBe(45_000)
    expect(ihWriterDeadlineMs('1e3')).toBe(45_000)
    expect(ihWriterDeadlineMs('45000ms')).toBe(45_000)
    expect(ihWriterDeadlineMs('  30000  ')).toBe(30_000)
    expect(ihWriterDeadlineMs('bogus')).toBe(45_000)
  })
})

// ─── Acceptance item 4: flag OFF is byte-identical and makes ZERO writer calls ───────────────────

describe('Part 2 acceptance item 4: IH_WRITER=off (default/unset) — byte-identical, zero calls', () => {
  const prevMode = process.env.IH_WRITER

  it('produceItemHighlights(off) equals buildItemHighlights(...) exactly, and never touches OpenAI', async () => {
    delete process.env.IH_WRITER
    const pool = [
      kw('later gator shirt women', 450, 3), kw('see you later alligator', 900, 3), kw('alligator clothing women', 300, 3),
      kw('funny gator apparel', 250, 3), kw('novelty animal tops', 200, 2), kw('comfort colors graphic tee', 5000, 2),
      kw('swamp humor clothing', 150, 2),
    ]
    const title = 'THE CEO Later Gator Tee Shirt | Alligator Tshirt for Women'
    const sync = buildItemHighlights({ finalTitle: title, pool, apparelProduct: true, blankBrand: CC, netTitles: [title] })
    const viaWriter = await produceItemHighlights({ finalTitle: title, pool, apparelProduct: true, blankBrand: CC, netTitles: [title] })
    expect(viaWriter.value).toBe(sync.value)
    expect(viaWriter.hold).toBe(sync.hold)
    expect(create).not.toHaveBeenCalled()
    expect(process.env.IH_WRITER).toBeUndefined()
  })

  it('produceItemHighlightsPerDesign(off) equals buildItemHighlightsPerDesign(...) exactly, and never touches OpenAI', async () => {
    delete process.env.IH_WRITER
    const groups = [
      { key: 'A', designName: 'Alligator Love', skus: [{ sku: 'A1', asin: 'B0A0000001' }], titles: ['THE CEO Alligator Love Tee for Women'] },
      { key: 'B', designName: 'Gator Nation', skus: [{ sku: 'B1', asin: 'B0B0000001' }], titles: ['THE CEO Gator Nation Tee for Women'] },
    ]
    const pool = [
      kw('later gator shirt women', 450, 3), kw('see you later alligator', 900, 3), kw('alligator clothing women', 300, 3),
      kw('funny gator apparel', 250, 3), kw('novelty animal tops', 200, 2), kw('comfort colors graphic tee', 5000, 2),
      kw('swamp humor clothing', 150, 2), kw('gator nation pride wear', 5000, 3), kw('alligator love graphic tee', 5000, 3),
    ]
    const args = { groups, pool, apparelProduct: true, blankBrand: CC, familyTitleText: 'Gator Family' }
    const sync = buildItemHighlightsPerDesign(args)
    const viaWriter = await produceItemHighlightsPerDesign(args)
    expect(viaWriter.perDesign).toEqual(sync.perDesign)
    expect(viaWriter.perChild).toEqual(sync.perChild)
    expect(viaWriter.shared).toEqual(sync.shared)
    expect(create).not.toHaveBeenCalled()
  })

  it('shadow mode still ships the composer result unchanged (writer output never overrides bytes in shadow)', async () => {
    process.env.IH_WRITER = 'shadow'
    try {
      const pool = [
        kw('later gator shirt women', 450, 3), kw('see you later alligator', 900, 3), kw('alligator clothing women', 300, 3),
        kw('funny gator apparel', 250, 3), kw('novelty animal tops', 200, 2), kw('comfort colors graphic tee', 5000, 2),
        kw('swamp humor clothing', 150, 2),
      ]
      const title = 'THE CEO Later Gator Tee Shirt | Alligator Tshirt for Women'
      const sync = buildItemHighlights({ finalTitle: title, pool, apparelProduct: true, blankBrand: CC, netTitles: [title] })
      const noClient = { chat: { completions: { create: vi.fn(async () => ({ choices: [{ message: { content: '' }, finish_reason: 'stop' }] })) } } }
      const viaWriter = await produceItemHighlights(
        { finalTitle: title, pool, apparelProduct: true, blankBrand: CC, netTitles: [title] },
        { openai: noClient as never },
      )
      expect(viaWriter.value).toBe(sync.value)
      expect(viaWriter.hold).toBe(sync.hold)
    } finally {
      if (prevMode === undefined) delete process.env.IH_WRITER; else process.env.IH_WRITER = prevMode
    }
  })
})

// ─── W7: readability — must-fail / must-pass pins ─────────────────────────────────────────────────

describe('W7: readability that fails the PO\'s own line', () => {
  const units: AdmittedUnit[] = [{ id: 'u0', text: 'Retro Sunset', kind: 'identity', numberable: false }]

  it('the PO\'s "THIS READS AWFUL" live line, verbatim, FAILS (4 of 5 clauses are keyword-shaped)', () => {
    const v = writerReadabilityVerdict(
      'Crewneck Sweatshirts Women, Fall Sweatshirts for Women, Graphic Crewneck, 50% Cotton / 50% Polyester, Classic Fit',
      [],
    )
    expect(v.ok).toBe(false)
  })

  it('the DQG per-child line, verbatim, FAILS (6 of 7 clauses are keyword-shaped)', () => {
    const v = writerReadabilityVerdict(
      'Fall Sweatshirts for Women, Cute Crewnecks, Graphic Crewneck, Classic Fit, Unisex Fit, Long Sleeve, Piece-Dyed Fabric',
      [],
    )
    expect(v.ok).toBe(false)
  })

  it('must-pass: one arrangement that names the design and joins its units with glue (only 1 keyword-shaped clause)', () => {
    const v = writerReadabilityVerdict("Retro Sunset Cozy Graphic Sweatshirt with Pullover Comfort, Unisex Fit", units)
    expect(v.ok).toBe(true)
  })

  // RULING K7 (fix round B4, value Important I1): readability's "has a connecting word" test now
  // counts only RELATION words ("with"/"in") — "for" (a list-adjacent function word inside a unit's
  // OWN text, not inter-unit glue any more) no longer saves a clause from reading as a keyword
  // dump. These lines use "with" where the pre-K7 fixture used "for".
  // RULING P5 (fix round B5, value Blocking 1, SUPERSEDING K7's "at most one keyword-shaped
  // clause"): a trailing list of keyword-shaped clauses AFTER the required relation clause is now
  // ONE list section, not a per-clause count — "Classic Fit, Crew Neck" is a single 2-item trailing
  // list, the exact shape review B4 measured K7 wrongly rejecting (Dino Squad, Spreadsheet Queen).
  it('P5: one relation clause plus a trailing list of any length is ONE list section — passes', () => {
    expect(writerReadabilityVerdict('Retro Sunset Tee with Everyday Wear, Classic Fit', units).ok).toBe(true)
    expect(writerReadabilityVerdict('Retro Sunset Tee with Everyday Wear, Classic Fit, Crew Neck', units).ok).toBe(true)
  })
  // RULING Q11 (fix round B6, readability shape refined): a list SECTION is now a RUN OF TWO OR
  // MORE consecutive list clauses — a single lone list clause between two relation clauses is
  // ordinary prose, not a section (see the next test). So this pin needs a run of 2+ on EACH side
  // of the splitting relation clause to still trip "more than one list section".
  it('P5: a SECOND list section (each a run of 2+ list clauses) — split from the first by another relation clause — fails', () => {
    const v = writerReadabilityVerdict('Retro Sunset Tee with Everyday Wear, Classic Fit, Crew Neck, Ribbed Cuffs in Ring-Spun Cotton, Short Sleeve, Long Sleeve', units)
    expect(v.ok).toBe(false)
  })
  it('P5: a SINGLE lone list clause between two relation clauses is ordinary prose, not a list section — passes (RULING Q11, B08\'s own shape)', () => {
    const v = writerReadabilityVerdict('Retro Sunset Tee with Everyday Wear, Classic Fit, Crew Neck in Ring-Spun Cotton, Long Sleeve', units)
    expect(v.ok).toBe(true)
  })
  it('P5: zero relation clauses at all (a bare keyword list) fails, regardless of clause count', () => {
    expect(writerReadabilityVerdict('Retro Sunset Tee, Classic Fit, Crew Neck', units).ok).toBe(false)
  })
  it('B6.2: a gendered audience word beside "Unisex" fails', () => {
    expect(writerReadabilityVerdict('Retro Sunset Tee with Womens Everyday Fit, Unisex Sizing', units).ok).toBe(false)
  })
  it('B6.2: "Unisex" alone (no gendered word) passes', () => {
    expect(writerReadabilityVerdict('Retro Sunset Tee with Everyday Wear, Unisex Sizing', units).ok).toBe(true)
  })
  it('B6.3: when an identity unit exists, the line must name or evoke it', () => {
    expect(writerReadabilityVerdict('Graphic Tee with Everyday Wear, Classic Fit', units).ok).toBe(false)
  })
  it('B6.3: no identity unit at all -> this rule is a no-op', () => {
    expect(writerReadabilityVerdict('Graphic Tee with Everyday Wear, Classic Fit', []).ok).toBe(true)
  })
})

// ─── B7/B8/W8: eligibility + retry mechanics (isolated — NOT proof of shipping; see W3 below for that) ─

const TEE_CTX: PhraseTruthCtx = { garmentFamily: 'tee', spec: { material: '100% Ring-Spun Cotton', fit: 'Classic' }, allowedBrand: null, audience: 'adult', field: 'highlights' }
/** ISOLATED mechanics only (retry counting, eligibility gates) — a passthrough tail here tests
 *  `runWriterForDesign`'s OWN retry/eligibility logic in isolation, deliberately NOT the real
 *  `runIhTail`. Nothing in this describe block is cited as proof a line SHIPS — that proof lives in
 *  the "W3" describe block below, which calls `produceItemHighlights`/`produceItemHighlightsPerDesign`
 *  (both hardcode the real tail internally) instead. */
const passthroughTail = (line: string): { value: string; hold: string | null; reason?: string | null } => ({ value: line, hold: null, reason: null })
// RICH ENOUGH that the max-possible join (every unit once, minimal separators) clears the real
// floor (97c) — the W8 floor-reachability skip below is tested on its OWN dedicated thin fixture,
// not accidentally tripped by these mechanics-only fixtures.
const COMPOSED = {
  candidates: ['Soft Everyday Cotton Feel', 'Graphic Retro Tee', 'Perfect For Weekend Wear'],
  specFacts: ['Classic Fit', 'Relaxed Everyday Comfort'],
  brandPick: null as string | null, wearFact: null as string | null,
}

describe('B8/W8: eligibility', () => {
  it('skips the call for unrated-pool (PO ruling) — zero calls', async () => {
    const { client, create: c } = stubArrangementClient([arrangementJson(['u0'])])
    const r = await runWriterForDesign({ composed: COMPOSED, fallbackHold: 'unrated-pool', designName: 'Retro Sunset', truthCtx: TEE_CTX, runTail: passthroughTail, deps: { openai: client } })
    expect(r.accepted).toBe(false)
    expect(r.calls).toBe(0)
    expect(c).not.toHaveBeenCalled()
  })
  it('skips the call for zero admitted pool units — zero calls', async () => {
    const { client, create: c } = stubArrangementClient([arrangementJson(['u0'])])
    const r = await runWriterForDesign({ composed: { ...COMPOSED, candidates: [] }, fallbackHold: 'thin-candidates', designName: 'Retro Sunset', truthCtx: TEE_CTX, runTail: passthroughTail, deps: { openai: client } })
    expect(r.accepted).toBe(false)
    expect(r.calls).toBe(0)
    expect(c).not.toHaveBeenCalled()
  })
  it('W8: skips for a non-apparel family (garmentFamily "none") — zero calls', async () => {
    const { client, create: c } = stubArrangementClient([arrangementJson(['u0'])])
    const r = await runWriterForDesign({ composed: COMPOSED, fallbackHold: 'thin-candidates', designName: 'X', truthCtx: { ...TEE_CTX, garmentFamily: 'none' }, runTail: passthroughTail, deps: { openai: client } })
    expect(r.accepted).toBe(false)
    expect(r.calls).toBe(0)
    expect(c).not.toHaveBeenCalled()
  })
  it('W8: skips when the admitted units (all used once, joined minimally) cannot possibly reach the floor', () => {
    const thin = { candidates: ['Soft Tee'], specFacts: [], brandPick: null, wearFact: null }
    // Not run through runWriterForDesign directly (that also needs >=2 units to even try) — this
    // pins the FLOOR-REACHABILITY math itself: one short unit plus nothing else cannot reach 97.
    const units = buildAdmittedUnits(thin, { designName: null, truthCtx: TEE_CTX })
    const maxPossible = units.map((u) => u.text).join(', ')
    expect(maxPossible.length).toBeLessThan(CONTENT_CONTRACT.itemHighlights.min)
  })
  // RULING G3 (fix round G1, design change): `COMPOSED`'s own pool is 3 phrases, one of which
  // (`'Graphic Retro Tee'`) is dropped at admission for colliding with the identity ("Retro
  // Sunset") — the 2 that survive, even combined, cannot clear the 97-char floor (measured: every
  // combination renders 60-91 chars). Under the OLD compose-then-judge design that never mattered
  // to THIS pin: the model was always CALLED at least once whenever eligible, regardless of
  // whether any draft it could ever propose would pass. Under the chooser, `enumerateWriterCandidates`
  // runs a FREE, exhaustive local search FIRST — for a family no arrangement could ever pass, it
  // correctly finds zero candidates and skips the call entirely, a STRONGER guarantee ("never
  // spend a billable call on a hopeless family"), but the WRONG signal for what THIS pin is
  // actually about (whether these 3 hold reasons are exempt from the terminal early-skip list,
  // never whether a specific thin fixture happens to have a findable candidate). A richer,
  // LOCAL pool — never `COMPOSED`, which other tests in this file depend on staying exactly as
  // thin as it is — gives the search real room to find one.
  it('IS eligible for under-floor-no-repeat / thin-candidates / under-floor (non-zero pool, apparel family) — the search finds a REAL candidate, so the model is asked', async () => {
    const richComposed = {
      candidates: ['Soft Everyday Cotton Feel', 'Perfect For Weekend Wear', 'Made For Chilly Fall Mornings', 'Cozy Layer For Every Day'],
      specFacts: ['Classic Fit', 'Relaxed Everyday Comfort'],
      brandPick: null as string | null, wearFact: null as string | null,
    }
    for (const hold of ['under-floor-no-repeat', 'thin-candidates', 'under-floor']) {
      const { client } = stubArrangementClient([arrangementJson(['u0', { glue: 'with' }, 'u1'])])
      const r = await runWriterForDesign({ composed: richComposed, fallbackHold: hold, designName: 'Retro Sunset', truthCtx: TEE_CTX, runTail: passthroughTail, deps: { openai: client } })
      expect(r.calls, hold).toBeGreaterThan(0)
    }
  })
})

// RULING G3 (fix round G1, design change): this describe block's ORIGINAL premise — the model
// COMPOSES an arrangement (a unit-id list), and code judges what it composed, retrying on a
// malformed one — is the exact design G3 replaces. `COMPOSED`'s own thin pool (2 units survive
// admission, neither combination clears the 97-char floor) means BOTH tests below now finish
// before the model is ever asked anything (`enumerateWriterCandidates` finds zero candidates,
// same as the eligibility fix above) — a DIFFERENT outcome than either test's original intent
// (grammar-retry mechanics; an honest re-word shipping). Rewritten below for the chooser: a richer
// pool proves candidates exist, and the "malformed" shape is now a missing "pick" key, not a bad
// unit id — there is no unit-id parsing left for the model to get wrong.
describe('mechanics: a malformed/hallucinating pick is retried, then falls back to candidate 1; a valid pick ships that exact candidate', () => {
  const richComposed = {
    candidates: ['Soft Everyday Cotton Comfort Feel', 'Made For Weekend Adventures', 'Perfect For Layering Season'],
    specFacts: ['Classic Fit'],
    brandPick: null as string | null, wearFact: null as string | null,
  }

  it('RULING H4 (fix round H1, supersedes this pin\'s own old title): a well-formed response with no "pick" key at all is a DECIDED answer, never retried — 1 call, ships the search\'s OWN top candidate', async () => {
    const { client, create: c } = stubArrangementClient([
      arrangementJson(['u999']), arrangementJson(['u998']), arrangementJson(['u997']),
    ])
    const units = buildAdmittedUnits(richComposed, { designName: 'Retro Sunset', truthCtx: TEE_CTX })
    const expectedTop = enumerateWriterCandidates(units, { truthCtx: TEE_CTX, runTail: passthroughTail }).candidates[0]
    expect(expectedTop, 'a candidate must exist for this pin to mean anything').toBeDefined()
    const r = await runWriterForDesign({ composed: richComposed, fallbackHold: 'thin-candidates', designName: 'Retro Sunset', truthCtx: TEE_CTX, runTail: passthroughTail, deps: { openai: client } })
    expect(r.accepted, JSON.stringify(r.reasons)).toBe(true) // G3 point 4: a malformed response never falls all the way back to "no line"
    expect(r.value).toBe(expectedTop.line)
    expect(c).toHaveBeenCalledTimes(1) // RULING H4: never retried — a well-formed keyless response is not a client error
    console.log('no-pick-key stub — fell back to candidate 1:', JSON.stringify(r.value))
  })

  it('a VALID pick ships that EXACT candidate on the first call — the model no longer composes, so there is no unit id to hallucinate', async () => {
    const units = buildAdmittedUnits(richComposed, { designName: 'Retro Sunset', truthCtx: TEE_CTX })
    const cands = enumerateWriterCandidates(units, { truthCtx: TEE_CTX, runTail: passthroughTail }).candidates
    expect(cands.length).toBeGreaterThan(1)
    const { client, create: c } = stubArrangementClient([{ pick: 2 }])
    const r = await runWriterForDesign({ composed: richComposed, fallbackHold: 'thin-candidates', designName: 'Retro Sunset', truthCtx: TEE_CTX, runTail: passthroughTail, deps: { openai: client } })
    expect(r.accepted, JSON.stringify(r.reasons)).toBe(true)
    expect(r.value).toBe(cands[1].line)
    expect(c).toHaveBeenCalledTimes(1)
    console.log('valid-pick stub — accepted:', r.value)
  })
})

// RULING G3 (fix round G1, design change): this pin's original claim — "an always-malformed stub
// makes exactly the retry cap of calls, then the composer result" — assumed the model is ALWAYS
// asked at least once when eligible. `COMPOSED`'s own thin pool (see the "eligibility" fix above)
// yields ZERO real candidates, so under the chooser this is now the "zero candidates" case: the
// search alone (no call at all) already proves no line could ever ship, and the composer's result
// stands at 0 calls — the SAME end state (never accepted, value never blanked), reached WITHOUT
// spending the 3 calls the old design always spent chasing a family that could never succeed.
describe('Part 2 acceptance item 3 (retained, re-grounded for G3): a family with ZERO real candidates spends ZERO calls, never accepted, value is never blanked to \'\' over a real fallback', () => {
  it('0 calls, never accepted, the composer\'s own result stands', async () => {
    const { client, create: c } = stubArrangementClient([arrangementJson(['does-not-exist'])])
    const units = buildAdmittedUnits(COMPOSED, { designName: 'Retro Sunset', truthCtx: TEE_CTX })
    expect(enumerateWriterCandidates(units, { truthCtx: TEE_CTX, runTail: passthroughTail }).candidates, 'this fixture is deliberately thin — no candidate should exist').toEqual([])
    const r = await runWriterForDesign({ composed: COMPOSED, fallbackHold: 'thin-candidates', designName: 'Retro Sunset', truthCtx: TEE_CTX, runTail: passthroughTail, deps: { openai: client } })
    expect(r.accepted).toBe(false)
    expect(r.value).toBe('')
    expect(r.calls).toBe(0)
    expect(c).not.toHaveBeenCalled()
  })

  it('produceItemHighlights(on), when the writer never accepts, ships the COMPOSER result — never blanks a HOLD to \'\'', async () => {
    process.env.IH_WRITER = 'on'
    try {
      const { client } = stubArrangementClient([arrangementJson(['does-not-exist'])])
      const small = [kw('rodeo outfit women', 400, 3), kw('hello darlin shirt', 350, 3), kw('cowgirl graphic tops', 300, 3)]
      const sync = buildItemHighlights({ finalTitle: 'THE CEO Darlin Tee', pool: small, apparelProduct: true, blankBrand: null, netTitles: null })
      const viaWriter = await produceItemHighlights({ finalTitle: 'THE CEO Darlin Tee', pool: small, apparelProduct: true, blankBrand: null, netTitles: null }, { openai: client as never })
      expect(viaWriter.value).toBe(sync.value)
      expect(viaWriter.hold).toBe(sync.hold)
    } finally { delete process.env.IH_WRITER }
  })
})

// ─── W3: PROVE THE WIRE — through the REAL runIhTail, via the entry points themselves ────────────

describe('W3: end-to-end through the REAL tail (produceItemHighlights / produceItemHighlightsPerDesign hardcode runIhTail internally — only the OpenAI client is a stub)', () => {
  const GATOR_POOL = [
    kw('later gator shirt women', 450, 3), kw('see you later alligator', 900, 3), kw('alligator clothing women', 300, 3),
    kw('funny gator apparel', 250, 3), kw('novelty animal tops', 200, 2), kw('comfort colors graphic tee', 5000, 2),
    kw('swamp humor clothing', 150, 2),
  ]
  const GATOR_TITLE = 'THE CEO Later Gator Tee Shirt | Alligator Tshirt for Women'

  // RULING G3 (fix round G1, design change): all three tests below used to stub the model's
  // COMPOSED arrangement directly (`buildAcceptableArrangement`, a real-but-hand-assembled parts
  // list) and assert it shipped VERBATIM after 1 call. The model no longer composes — it picks an
  // index into `enumerateWriterCandidates`'s own ranked output — so the stub now answers
  // `{"pick": 1}` and the expected value is the SEARCH's own top candidate, computed the SAME way
  // production does (never a hand-built parts list `buildAcceptableArrangement` assembles by its
  // own, different, greedy strategy). What each test proves — the WIRE from an accepted line to
  // the entry point's return, in on/shadow/per-design mode — is unchanged.
  it('a valid pick is accepted end-to-end: produceItemHighlights(on) returns an in-band accepted writer line', async () => {
    process.env.IH_WRITER = 'on'
    try {
      const input = { finalTitle: GATOR_TITLE, pool: GATOR_POOL, apparelProduct: true, blankBrand: GILDAN, netTitles: [GATOR_TITLE], identityDesignName: 'Later Gator' }
      const preview = buildItemHighlights(input)
      expect(preview.composed, 'fixture must compose for this test to mean anything').toBeTruthy()
      const { client } = stubArrangementClient([{ pick: 1 }])
      const result = await produceItemHighlights(input, { openai: client as never })
      // ASSERTED AT THE ENTRY POINT'S RETURN — downstream of the search -> pick -> the REAL tail's
      // OWN byte-identity check, all inside produceItemHighlights itself.
      expect(result.writerLog?.accepted, JSON.stringify(result.writerLog)).toBe(true)
      expect(result.value).toBe(result.writerLog?.writer)
      expect(result.value.length).toBeGreaterThanOrEqual(CONTENT_CONTRACT.itemHighlights.min)
      expect(result.value.length).toBeLessThanOrEqual(CONTENT_CONTRACT.itemHighlights.max)
      expect(result.hold).toBeNull()
    } finally { delete process.env.IH_WRITER }
  })

  it('the SAME valid pick, in SHADOW mode: the composer line ships, and the writer\'s accepted line appears in the shadow block', async () => {
    process.env.IH_WRITER = 'shadow'
    try {
      const input = { finalTitle: GATOR_TITLE, pool: GATOR_POOL, apparelProduct: true, blankBrand: GILDAN, netTitles: [GATOR_TITLE], identityDesignName: 'Later Gator' }
      const sync = buildItemHighlights(input)
      const { client } = stubArrangementClient([{ pick: 1 }])
      const result = await produceItemHighlights(input, { openai: client as never })
      // The COMPOSER's own bytes ship — never the writer's, in shadow.
      expect(result.value).toBe(sync.value)
      expect(result.hold).toBe(sync.hold)
      // ...but the writer's accepted line is visible in the shadow readout (spec §2a "Rollout": the
      // PO reads real lines before anything ships-affecting), and it is a REAL, in-band line —
      // never the composer's own bytes re-labelled as the writer's.
      expect(result.writerLog?.accepted, JSON.stringify(result.writerLog)).toBe(true)
      expect(result.writerLog?.writer).not.toBe(sync.value)
      expect(result.writerLog?.writer?.length).toBeGreaterThanOrEqual(CONTENT_CONTRACT.itemHighlights.min)
      expect(result.writerLog?.writer?.length).toBeLessThanOrEqual(CONTENT_CONTRACT.itemHighlights.max)
      expect(result.writerLog?.composer).toBe(sync.value)
    } finally { delete process.env.IH_WRITER }
  })

  it('produceItemHighlightsPerDesign(on): a valid pick accepted for ONE design ships through the per-child assembly — perChild/shared re-derived, not a second writer', async () => {
    process.env.IH_WRITER = 'on'
    try {
      // LEXICALLY DIVERSE pool (deliberately NOT sharing "alligator"/"gator" across every phrase, as
      // the acceptance item 4 fixture above does) — an arrangement joining several admitted
      // candidates must not itself trip the REAL repeat budget on a word the composer's own careful
      // selection would never have repeated.
      const groups = [
        { key: 'A', designName: 'Sunny Beach Vibes', skus: [{ sku: 'A1', asin: 'B0A0000001' }], titles: ['THE CEO Sunny Beach Vibes Tee for Women'] },
        { key: 'B', designName: 'Retro Road Trip', skus: [{ sku: 'B1', asin: 'B0B0000001' }], titles: ['THE CEO Retro Road Trip Tee for Women'] },
      ]
      const pool = [
        kwPD('funny graphic novelty tee', 450, 3, ['A', 'B']), kwPD('cute cartoon animal print', 900, 3, ['A', 'B']), kwPD('retro vintage style clothing', 300, 3, ['A', 'B']),
        kwPD('cozy everyday casual wear', 250, 3, ['A', 'B']), kwPD('bold bright colorful design', 200, 2, ['A', 'B']), kwPD('soft comfortable cotton feel', 5000, 2, ['A', 'B']),
        kwPD('playful humor apparel gift', 150, 2, ['A', 'B']), kwPD('trendy modern weekend outfit', 5000, 3, ['A', 'B']), kwPD('unique custom art print top', 5000, 3, ['A', 'B']),
      ]
      const input = { groups, pool, apparelProduct: true, blankBrand: GILDAN, familyTitleText: 'Beach Family' }
      const sync = buildItemHighlightsPerDesign(input)
      const designA = sync.perDesign.find((d) => d.designKey === 'A')!
      expect(designA.composed, 'fixture must compose design A for this test to mean anything').toBeTruthy()
      const { client } = stubArrangementClient([{ pick: 1 }])
      const result = await produceItemHighlightsPerDesign(input, { openai: client as never })
      const resultA = result.perDesign.find((d) => d.designKey === 'A')!
      const logA = result.writerLog?.find((r) => r.design === 'A')
      expect(logA?.accepted, JSON.stringify(logA)).toBe(true)
      expect(resultA.value).toBe(logA?.writer)
      // Downstream of the SAME assembly `buildItemHighlightsPerDesign` uses (assemblePerDesignItemHighlights) —
      // the per-child row for design A's own SKU carries the accepted writer line, not a re-derivation.
      const childA = result.perChild.find((c) => c.designKey === 'A')!
      expect(childA.item_highlight).toBe(logA?.writer)
    } finally { delete process.env.IH_WRITER }
  })
})

// ─── W5: identity threading + the NO-IDENTITY log ─────────────────────────────────────────────────

describe('W5: single-design identity threading', () => {
  it('identityDesignName threads into the writer\'s own designName — the composer\'s designTokens is untouched (flag-off bytes unaffected)', async () => {
    process.env.IH_WRITER = 'on'
    try {
      const pool = [kw('gator apparel graphic', 300, 3), kw('novelty animal tops', 200, 2)]
      const input = { finalTitle: 'THE CEO Test Tee', pool, apparelProduct: true, blankBrand: CC, netTitles: null, identityDesignName: 'Later Gator' }
      const built = buildItemHighlights(input)
      // designTokens (composer-facing) was never set by this input — proving identityDesignName is a
      // SEPARATE channel, not a re-routing of the composer's own field.
      expect(built.truthCtx?.designTokens).toBeUndefined()
      if (built.composed) {
        const units = buildAdmittedUnits(built.composed, { designName: 'Later Gator', truthCtx: built.truthCtx! })
        expect(units.some((u) => u.kind === 'identity' && u.text === 'Later Gator')).toBe(true)
      }
    } finally { delete process.env.IH_WRITER }
  })

  it('when no identity resolves, IH_WRITER_NO_IDENTITY is logged and the shadow row says noIdentity:true', async () => {
    process.env.IH_WRITER = 'shadow'
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const small = [kw('rodeo outfit women', 400, 3), kw('hello darlin shirt', 350, 3), kw('cowgirl graphic tops', 300, 3)]
      const { client } = stubArrangementClient([arrangementJson(['does-not-exist'])])
      const result = await produceItemHighlights({ finalTitle: 'THE CEO Darlin Tee', pool: small, apparelProduct: true, blankBrand: null, netTitles: null }, { openai: client as never })
      if (result.writerLog) {
        expect(result.writerLog.design).toBeNull()
        expect(result.writerLog.noIdentity).toBe(true)
      }
      expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('IH_WRITER_NO_IDENTITY'))).toBe(true)
    } finally { delete process.env.IH_WRITER; warnSpy.mockRestore() }
  })
})

// ─── W8: per-regen budget + bounded concurrency ───────────────────────────────────────────────────

describe('W8/G8: per-regen call budget (shared across designs) + bounded concurrency', () => {
  it('when the budget cannot cover even ONE design\'s full retry cap, EVERY design is skipped with zero calls — RULING G8: the budget is RESERVED before a design starts, not checked after one finishes', async () => {
    process.env.IH_WRITER = 'on'
    process.env.IH_WRITER_MAX_CALLS = '1'
    try {
      const KEYS = ['A', 'B', 'C', 'D', 'E']
      const groups = KEYS.map((k) => ({ key: k, designName: `Design ${k}`, skus: [{ sku: `${k}1`, asin: `B0${k}0000001` }], titles: [`THE CEO Design ${k} Tee for Women`] }))
      const pool = [
        kwPD('funny graphic novelty tee', 450, 3, KEYS), kwPD('cute cartoon animal print', 900, 3, KEYS), kwPD('retro vintage style clothing', 300, 3, KEYS),
        kwPD('cozy everyday casual wear', 250, 3, KEYS), kwPD('bold bright colorful design', 200, 2, KEYS), kwPD('soft comfortable cotton feel', 5000, 2, KEYS),
        kwPD('playful humor apparel gift', 150, 2, KEYS), kwPD('trendy modern weekend outfit', 5000, 3, KEYS), kwPD('unique custom art print top', 5000, 3, KEYS),
      ]
      const input = { groups, pool, apparelProduct: true, blankBrand: null, familyTitleText: 'Beach Family' }
      const sync = buildItemHighlightsPerDesign(input)
      // Every stub call always fails (bad unit id). budget=1 cannot cover even one design's
      // IH_WRITER_RETRY_CAP (3) — RULING G8 (FIX ROUND B3): the FIRST design to run must RESERVE
      // its whole retry cap BEFORE starting, and 0 + 3 > 1, so it (and every design after it) is
      // skipped with zero calls. PRE-FIX (a soft "check after" bound), the first concurrent wave of
      // up to 3 designs would each have STARTED (seeing `callsUsed === 0 < budget` before any of
      // them finished) and spent their own full 3 calls apiece — an overshoot this fixture used to
      // rely on (9 calls, not 0) that G8 closes.
      const { client, create: c } = stubArrangementClient([arrangementJson(['does-not-exist'])])
      const result = await produceItemHighlightsPerDesign(input, { openai: client as never })
      expect(result.perDesign).toEqual(sync.perDesign) // nothing was accepted either way — composer result throughout
      expect(c).not.toHaveBeenCalled() // RULING G8: an exact bound — zero calls, not merely "fewer than every design's cap"
      const totalCalls = (result.writerLog ?? []).reduce((n, r) => n + r.calls, 0)
      expect(totalCalls).toBe(0)
      for (const row of result.writerLog ?? []) {
        expect(row.calls).toBe(0)
        expect(row.reasons.some((x) => x.includes('budget'))).toBe(true)
      }
    } finally { delete process.env.IH_WRITER; delete process.env.IH_WRITER_MAX_CALLS }
  })

  it('RULING G8 pin (phase-b3-rulings.md G8): budget 18 with 10 always-invalid designs spends AT MOST 18 calls — exactly 6 designs x 3 retries, never the soft-bound overshoot (+6 measured pre-fix)', async () => {
    process.env.IH_WRITER = 'on'
    process.env.IH_WRITER_MAX_CALLS = '18'
    try {
      const KEYS = Array.from({ length: 10 }, (_, i) => `D${i}`)
      const groups = KEYS.map((k) => ({ key: k, designName: `Design ${k}`, skus: [{ sku: `${k}1`, asin: `B0${k}0000001` }], titles: [`THE CEO Design ${k} Tee for Women`] }))
      const pool = [
        kwPD('funny graphic novelty tee', 450, 3, KEYS), kwPD('cute cartoon animal print', 900, 3, KEYS), kwPD('retro vintage style clothing', 300, 3, KEYS),
        kwPD('cozy everyday casual wear', 250, 3, KEYS), kwPD('bold bright colorful design', 200, 2, KEYS), kwPD('soft comfortable cotton feel', 5000, 2, KEYS),
        kwPD('playful humor apparel gift', 150, 2, KEYS), kwPD('trendy modern weekend outfit', 5000, 3, KEYS), kwPD('unique custom art print top', 5000, 3, KEYS),
      ]
      // RULING G3 (fix round G1, design change): `blankBrand: null` (an UNRESOLVED blank) gives no
      // material/fit spec fact at all — `enumerateWriterCandidates` then has no relation-eligible
      // unit to build a clause from and correctly finds ZERO candidates, so a design that gets to
      // run would spend 0 calls, never the full retry cap this pin's budget math depends on. GILDAN
      // (a RESOLVED blank, material+fit both real) gives the search real room, so a design that
      // reserves genuinely spends its cap chasing the always-no-"pick"-key stub below.
      const input = { groups, pool, apparelProduct: true, blankBrand: GILDAN, familyTitleText: 'Beach Family' }
      // RULING H4 (fix round H1): a well-formed no-"pick" response no longer retries at all (1
      // call, not the full cap), so this pin's ORIGINAL budget-exhaustion math needs a GENUINE
      // client/transport failure to still spend the full `IH_WRITER_RETRY_CAP` per design — every
      // stub call now THROWS. 18 / 3 = exactly 6 designs can reserve; the other 4 are skipped with
      // 0 calls each.
      const { client } = stubThrowingClient()
      const result = await produceItemHighlightsPerDesign(input, { openai: client as never })
      const totalCalls = (result.writerLog ?? []).reduce((n, r) => n + r.calls, 0)
      expect(totalCalls).toBeLessThanOrEqual(18)
      expect(totalCalls).toBe(18) // exact, not merely bounded — 6 * IH_WRITER_RETRY_CAP
      const ranDesigns = (result.writerLog ?? []).filter((r) => r.calls > 0).length
      expect(ranDesigns).toBe(18 / IH_WRITER_RETRY_CAP)
      const skipped = (result.writerLog ?? []).filter((r) => r.calls === 0)
      expect(skipped.length).toBe(KEYS.length - ranDesigns)
      for (const row of skipped) expect(row.reasons.some((x) => x.includes('budget'))).toBe(true)
    } finally { delete process.env.IH_WRITER; delete process.env.IH_WRITER_MAX_CALLS }
  })
})

// ─── Part 2 acceptance item 5: six B0DSCDZC6K-shaped designs, through the REAL tail (six.mts fix) ──

describe('Part 2 acceptance item 5: six B0DSCDZC6K-shaped designs — REAL runIhTail (the six.mts finding: the original 67-73c fixture only ever passed a MOCK tail)', () => {
  // B0DSCDZC6K per fba-generation-invariants-retrospective.md: a Gildan sweatshirt family, UNISEX
  // lean, six designs, where the picker itself holds most designs for want of a repeat-free fill —
  // exactly spec §2a's "Cost, refined" newly-ELIGIBLE case. RICHER than the original fixture (which
  // review I1 measured at 67-73c, under the REAL 97 floor) specifically so an HONEST re-word can
  // clear it for real — the point this acceptance row exists to prove, not assume.
  const SWEAT_UNISEX: PhraseTruthCtx = {
    garmentFamily: 'sweatshirt', spec: { material: 'Cotton/Polyester Blend', fit: 'Classic', unisex: true },
    allowedBrand: null, audience: 'adult', audienceLean: 'unisex', field: 'highlights',
  }
  const DESIGNS = ['Don\'t Quit', 'Boss Definition', 'Real King', 'Self Made', 'Beast Mode', 'Relax I\'m a CEO']
  // RULING K1 (fix round B4): the pool candidate template used to echo the design NAME itself
  // (`${name} Graphic Sweatshirt`) — harmless under the OLD flat Amazon cap (up to 2), but a real
  // significant-word repeat with the identity unit under the STRICTER absolute rule
  // (`lineHasSignificantRepeat`) K1 now checks pre-tail. Kept design-agnostic so an honest
  // arrangement naming the design via its OWN identity unit, once, never trips it.
  const composedByDesign = (_name: string) => ({
    candidates: ['Graphic Crewneck Sweatshirt', 'Cozy Pullover Comfort', 'Perfect for Layering Season'],
    specFacts: ['Classic Fit', 'Unisex Fit', 'Cotton Polyester Blend'],
    brandPick: null as string | null,
    wearFact: null as string | null,
  })
  const REAL_TAIL_CTX = { titles: ['THE CEO Cozy Sweatshirt'], blankBrand: null, truthCtx: SWEAT_UNISEX }

  // RULING G3 (fix round G1, design change): this row used to prove ONE hand-assembled, honest
  // re-word (`buildAcceptableArrangement`) shipped VERBATIM through a stub that answered with it
  // directly. The model no longer composes; it picks. Rewritten to measure the ACCEPTANCE THAT
  // MATTERS MOST for this round (phase-g1-rulings.md's own acceptance criterion): for each of the
  // six B0DSCDZC6K-shaped designs, does `enumerateWriterCandidates` — the REAL search, through the
  // REAL `runIhTail` — find at least one candidate, and does `runWriterForDesign` (with a REAL
  // `{"pick": 1}` stub, never a hand-fed arrangement) ship it end to end. Both are measured and
  // logged per design; the count logged below IS the number `phase-g1-report.md` reports.
  for (const name of DESIGNS) {
    it(`${name}: an honest re-word of REAL admitted units, run through the REAL runIhTail, clears the 97-125 floor and is accepted`, async () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { runIhTail } = await import('./listingPipeline')
      const composed = composedByDesign(name)
      const truthCtx = { ...SWEAT_UNISEX, designTokens: [name] }
      const units = buildAdmittedUnits(composed, { designName: name, truthCtx })
      expect(units.length).toBeGreaterThan(0)
      const runTail = (line: string) => runIhTail(line, { ...REAL_TAIL_CTX, truthCtx })
      const enumerated = enumerateWriterCandidates(units, { truthCtx, runTail })
      const { client, create: c } = stubArrangementClient([{ pick: 1 }])
      const r = await runWriterForDesign({
        composed, fallbackHold: 'under-floor-no-repeat', designName: name, truthCtx, runTail,
        deps: { openai: client },
      })
      console.log(JSON.stringify({
        tag: 'B0DSCDZC6K_ACCEPTANCE_REAL_TAIL', design: name, found: enumerated.candidates.length,
        calls: c.mock.calls.length, accepted: r.accepted, value: r.value || null, len: r.value.length, reasons: r.reasons,
      }))
      expect(enumerated.candidates.length, `${name}: fixture must supply enough admitted content for the search to find a candidate`).toBeGreaterThan(0)
      expect(r.accepted, JSON.stringify(r.reasons)).toBe(true)
      expect(r.value.length).toBeGreaterThanOrEqual(CONTENT_CONTRACT.itemHighlights.min)
      expect(r.value.length).toBeLessThanOrEqual(CONTENT_CONTRACT.itemHighlights.max)
      expect(r.value).toBe(enumerated.candidates[0].line)
    })
  }
})
