/**
 * itemHighlightWriterHumanizer.test.ts — ROUND M6 / J1-J7 (`.superpowers/sdd/2026-09-10-ih-writer/
 * phase-j1-rulings.md`; PO 2026-09-23, verbatim "A: go with a"; spec §3b).
 *
 * THE NET (J4) is what this file exists to prove, over GENERATED (source, rewrite) pairs — never a
 * mock, always the REAL `humanizerRewriteVerdict`/`humanizeAdmittedUnits` this repo ships. Every
 * "should reject" case below was independently VERIFIED against the real owner predicate it exercises
 * (`phraseTruthVerdict`, `scrubTrademarks`, `hasCelebrityName`, `lineCarriesBrand`) with a standalone
 * probe before being written here — see `phase-m1-report.md` §… for the transcript — so this is a
 * property test over REAL adversarial pairs, not invented ones asserted by construction.
 */
import { describe, it, expect } from 'vitest'
import {
  humanizerRewriteVerdict, isHumanizerEligible, humanizeAdmittedUnits, ihHumanizerMode,
  IH_HUMANIZER_CALL_BUDGET, buildHumanizerPrompt, buildAdmittedUnits, enumerateWriterCandidates, runWriterForDesign,
  type AdmittedUnit, type HumanizerRejectReason,
} from '@/lib/fba/itemHighlightWriter'
import { runIhTail } from '@/lib/fba/listingPipeline'
import { coverageTokens, isCovered } from '@/lib/keyword-engine/coverage-core'
import { normalizeAudienceLean, type PhraseTruthCtx } from '@/lib/fba/contentTruth'
import { ihSpecFactFillers } from '@/lib/fba/productDetailAttrs'
import { titleCasePhrase } from '@/lib/fba/titleBand'
import fixture from './__fixtures__/b0dscdzc6k-item-highlights-2026-09-23.json'

const CTX: PhraseTruthCtx = {
  garmentFamily: 'sweatshirt',
  spec: { material: '50% Cotton / 50% Polyester', fit: 'Classic', unisex: true } as never,
  allowedBrand: null,
  audience: 'adult',
  field: 'highlights',
  audienceLean: 'women', // 'women', not 'unisex' — so a "for Women" phrase is a TRUE assertion, not audience-lean-lie
}

const unit = (text: string, kind: AdmittedUnit['kind'] = 'pool'): AdmittedUnit => ({ id: 'x', text, kind, numberable: false })

describe('ROUND M6/J1-J7: humanizerRewriteVerdict — J4, the net, over GENERATED (source, rewrite) pairs', () => {
  it('ACCEPTS a pure reorder that changes nothing the net checks (content words, length, truth, trademark, celebrity, brand all unaffected)', () => {
    expect(humanizerRewriteVerdict(unit('Sweatshirts for Women Trendy'), 'Trendy Sweatshirts for Women', CTX)).toEqual({ ok: true })
  })

  it('ACCEPTS inserting ONLY a closed-set function word ("for") — the exact §0 worked example: "Graphic Crewneck Sweatshirts Women" -> "...for Women"', () => {
    expect(humanizerRewriteVerdict(unit('Graphic Crewneck Sweatshirts Women'), 'Graphic Crewneck Sweatshirts for Women', CTX)).toEqual({ ok: true })
  })

  it('ACCEPTS a no-op rewrite (model says the phrase already reads naturally, returns it unchanged)', () => {
    expect(humanizerRewriteVerdict(unit('Fall Crewneck'), 'Fall Crewneck', CTX)).toEqual({ ok: true })
  })

  it('REJECTS empty/whitespace-only text — never ships a blank unit', () => {
    expect(humanizerRewriteVerdict(unit('Fall Crewneck'), '   ', CTX)).toEqual({ ok: false, reason: 'empty' })
  })

  it('J4.1 REJECTS a rewrite that gains a genuine content word ("Cute") — content-word multiset unequal under the ONE coverage predicate', () => {
    const v = humanizerRewriteVerdict(unit('Graphic Crewneck Sweatshirts Women'), 'Cute Graphic Crewneck Sweatshirts Women', CTX)
    expect(v).toEqual({ ok: false, reason: 'content-word-multiset' })
  })

  it('J4.1 REJECTS a rewrite that LOSES a content word ("Graphic" dropped) — same predicate catches removal too', () => {
    const v = humanizerRewriteVerdict(unit('Graphic Crewneck Sweatshirts Women'), 'Crewneck Sweatshirts Women', CTX)
    expect(v).toEqual({ ok: false, reason: 'content-word-multiset' })
  })

  it('J4.2 (first check) REJECTS an inserted word outside the closed set — "to" is a coverage STOPWORD (content multiset stays equal) but NOT one of the six insertable words, which is exactly why this is a SECOND, independent check from J4.1', () => {
    const v = humanizerRewriteVerdict(unit('Graphic Crewneck Sweatshirts Women'), 'Graphic Crewneck Sweatshirts to Women', CTX)
    // Prove the premise first: the coverage predicate really does consider these two multiset-equal.
    expect([...coverageTokens('Graphic Crewneck Sweatshirts to Women')].sort())
      .toEqual([...coverageTokens('Graphic Crewneck Sweatshirts Women')].sort())
    expect(v).toEqual({ ok: false, reason: 'inserted-word' })
  })

  it('J4.2 (second check) REJECTS "with" inserted inside a unit — content multiset would call this LEGAL (coverage drops "with" as a stopword too), which is exactly the hole this second, independent check exists to close', () => {
    const v = humanizerRewriteVerdict(unit('Graphic Crewneck Sweatshirts Women'), 'Graphic Crewneck Sweatshirts with Women', CTX)
    expect([...coverageTokens('Graphic Crewneck Sweatshirts with Women')].sort())
      .toEqual([...coverageTokens('Graphic Crewneck Sweatshirts Women')].sort())
    expect(v).toEqual({ ok: false, reason: 'relation-glue-in-unit' })
  })

  it('J4.2 (second check) REJECTS "in" the same way', () => {
    const v = humanizerRewriteVerdict(unit('Fun Sweatshirts for Women'), 'Fun Sweatshirts in Women', CTX)
    expect(v).toEqual({ ok: false, reason: 'relation-glue-in-unit' })
  })

  it('J4.3 REJECTS a rewrite more than 6 characters longer, even padded ONLY with closed-set words', () => {
    const source = unit('Fall Crewneck') // 13 characters
    const rewrite = 'Fall and the Crewneck' // 22 characters = +9; every added word ("and","the") IS insertable
    expect(rewrite.length - source.text.length).toBeGreaterThan(6)
    expect(humanizerRewriteVerdict(source, rewrite, CTX)).toEqual({ ok: false, reason: 'length' })
  })

  it('J4.3 ACCEPTS at exactly the +6 boundary, REJECTS one character past it — both rewrites add ONLY closed-set words, IN THE MIDDLE (never at either edge — RULING N2\'s own boundary-function-word rule below refuses an inserted function word stranded at the edge), so J4.1/J4.2/N1/N2 pass identically; length is the ONLY variable', () => {
    const source = unit('Fall Crewneck')
    const at6 = 'Fall and a Crewneck' // inserts "and a" between the two source words — both insertable, both pure additions, neither at an edge
    const at7 = 'Fall and an Crewneck' // inserts "and an" — one character longer than at6
    expect(at6.length - source.text.length).toBe(6)
    expect(at7.length - source.text.length).toBe(7)
    expect(humanizerRewriteVerdict(source, at6, CTX)).toEqual({ ok: true })
    expect(humanizerRewriteVerdict(source, at7, CTX)).toEqual({ ok: false, reason: 'length' })
  })

  it('J4.4 REJECTS a rewrite that a PURE REORDER makes untrue, even though content words are identical — the exact residual the adversary section names (a gold and its stuffed twin can be exact anagrams)', () => {
    // "Real Deal Cotton": "Real" is not ADJACENT to a fibre word (contentTruth.ts's PURITY_ADJACENT_RE
    // needs whitespace/hyphen adjacency) — passes truth. Reordered to "Real Cotton Deal", "Real" is
    // now adjacent to "Cotton" — a composition claim the blank's 50/50 material does not back.
    const source = unit('Real Deal Cotton')
    expect(source.text).not.toBe('Real Cotton Deal')
    const before = humanizerRewriteVerdict(source, 'Real Deal Cotton', CTX) // sanity: source's own text passes
    expect(before).toEqual({ ok: true })
    const v = humanizerRewriteVerdict(source, 'Real Cotton Deal', CTX)
    expect(v).toEqual({ ok: false, reason: 'truth:material-lie' })
  })

  it('J4.5 REJECTS a rewrite that a PURE REORDER turns into a scrubbed trademark ("World Cup") — re-admission is independent, never inherited from the source passing once', () => {
    const source = unit('Cup Fun World')
    const v = humanizerRewriteVerdict(source, 'Fun World Cup', CTX)
    expect(v).toEqual({ ok: false, reason: 'trademark' })
  })

  it('J4.5 REJECTS a rewrite that a PURE REORDER turns into a celebrity name ("Taylor Swift")', () => {
    const source = unit('Swift Fan Taylor')
    const v = humanizerRewriteVerdict(source, 'Fan Taylor Swift', CTX)
    expect(v).toEqual({ ok: false, reason: 'celebrity' })
  })

  it('J4.6 REJECTS a rewrite that a PURE REORDER makes CARRY the brand when the source did not — brand parity, never inherited', () => {
    const ctxWithBrand: PhraseTruthCtx = { ...CTX, allowedBrand: 'Comfort Colors' }
    const source = unit('Colors Comfort Club')
    const v = humanizerRewriteVerdict(source, 'Club Comfort Colors', ctxWithBrand)
    expect(v).toEqual({ ok: false, reason: 'brand-parity' })
  })

  it('J4.6 REJECTS the inverse too — a rewrite that DESTROYS the brand carry the source had', () => {
    const ctxWithBrand: PhraseTruthCtx = { ...CTX, allowedBrand: 'Comfort Colors' }
    const source = unit('Club Comfort Colors')
    const v = humanizerRewriteVerdict(source, 'Colors Comfort Club', ctxWithBrand)
    expect(v).toEqual({ ok: false, reason: 'brand-parity' })
  })
})

// ─── MUTATION PROOF (DISCIPLINE: "mutation-prove every pin") ──────────────────────────────────────
// Each of the 7 REJECT cases above pins a DIFFERENT one of the net's independent checks. Proven here
// by construction: disable any ONE check inside `humanizerRewriteVerdict` (comment it out) and AT
// LEAST ONE of the tests above goes RED, because each check has its own dedicated case whose OTHER
// checks all pass (verified inline above — e.g. the truth case's own `before` assertion proves the
// SOURCE already clears every earlier check, so only the truth check being live can be failing it).
// The executed mutation proof (copy-aside `itemHighlightWriter.ts`, comment out ONE check, run this
// file, restore by copy — `git stash` never used) is recorded in `phase-m1-report.md` §… for all 7
// checks; re-running it is not repeated here because it requires editing production source, which a
// committed test file must never do as a side effect of running.

describe('ROUND M6/J1-J7: J2 — eligibility (POOL-class, never the brand carrier)', () => {
  it('a pool unit is eligible', () => {
    expect(isHumanizerEligible(unit('Fall Crewneck', 'pool'))).toBe(true)
  })
  it('identity, spec-fact, brand, wear-fact, garment-head are NEVER eligible', () => {
    for (const kind of ['identity', 'spec-fact', 'brand', 'wear-fact', 'garment-head'] as const) {
      expect(isHumanizerEligible(unit('x', kind))).toBe(false)
    }
  })
  it('a POOL-classed unit that IS the mandatory brand carrier (isBrand: true) is NEVER eligible — J2\'s own "never the brand carrier" clause, which `kind` alone cannot express (a pool-sourced brand stays kind:"pool")', () => {
    expect(isHumanizerEligible({ id: 'b', text: 'Comfort Colors Club', kind: 'pool', numberable: false, isBrand: true })).toBe(false)
  })
})

describe('ROUND M6/J1-J7: J6 — coverage is preserved, and pinned', () => {
  it('for every ACCEPTED rewrite in the property suite above, every keyword the SOURCE covered is still covered by the REWRITE (structural: J4.1 already pins content-multiset equality under `coverageTokens`, so `isCovered` cannot move)', () => {
    const ACCEPTED_PAIRS: [string, string][] = [
      ['Sweatshirts for Women Trendy', 'Trendy Sweatshirts for Women'],
      ['Graphic Crewneck Sweatshirts Women', 'Graphic Crewneck Sweatshirts for Women'],
      ['Fall Crewneck', 'Fall Crewneck'],
    ]
    // A representative keyword universe — single tokens and short phrases drawn from (and adjacent
    // to) both lines, so the sweep actually exercises `isCovered`'s cross-token logic, not just the
    // trivial "the whole phrase covers itself" case.
    const PROBE_KEYWORDS = [
      'sweatshirt', 'sweatshirts', 'women', 'trendy', 'graphic', 'crewneck', 'crewnecks', 'fall',
      'trendy sweatshirt', 'graphic crewneck', 'crewneck sweatshirts for women', 'nonexistent phrase',
    ]
    for (const [source, rewrite] of ACCEPTED_PAIRS) {
      expect(humanizerRewriteVerdict(unit(source), rewrite, CTX)).toEqual({ ok: true }) // precondition: really accepted
      for (const kw of PROBE_KEYWORDS) {
        if (isCovered(kw, source)) expect(isCovered(kw, rewrite)).toBe(true)
      }
    }
  })

  it('the coverage predicate itself: an accepted rewrite and its source always tokenize to the SAME sorted multiset (this is what makes the property above structural, not incidental)', () => {
    const pairs: [string, string][] = [
      ['Sweatshirts for Women Trendy', 'Trendy Sweatshirts for Women'],
      ['Graphic Crewneck Sweatshirts Women', 'Graphic Crewneck Sweatshirts for Women'],
    ]
    for (const [a, b] of pairs) expect([...coverageTokens(a)].sort()).toEqual([...coverageTokens(b)].sort())
  })
})

describe('ROUND M6/J1-J7: J7 — the flag, the budget constant, and byte-identical-off', () => {
  it('ihHumanizerMode defaults to "off" (unset, empty, or any typo)', () => {
    expect(ihHumanizerMode(undefined)).toBe('off')
    expect(ihHumanizerMode('')).toBe('off')
    expect(ihHumanizerMode('On ')).toBe('on') // trimmed, case-folded — same convention as ihWriterMode
    expect(ihHumanizerMode('onn')).toBe('off') // a genuine typo still falls to off
    expect(ihHumanizerMode('ON')).toBe('on') // case-insensitive is fine
    expect(ihHumanizerMode('on')).toBe('on')
  })

  it('IH_HUMANIZER_CALL_BUDGET is exactly 1 — the humanizer is never retried (unlike the picker\'s IH_WRITER_RETRY_CAP)', () => {
    expect(IH_HUMANIZER_CALL_BUDGET).toBe(1)
  })

  it('humanizeAdmittedUnits is a pure no-op when the flag is off — SAME array reference back, 0 calls, no network access attempted (deps.openai would throw if called)', async () => {
    const units: AdmittedUnit[] = [unit('Graphic Crewneck Sweatshirts Women')]
    const throwingDeps = { openai: { chat: { completions: { create: () => { throw new Error('must never be called with the flag off') } } } } } as never
    const result = await humanizeAdmittedUnits(units, { truthCtx: CTX, designName: 'X', deps: throwingDeps })
    expect(result).toEqual({ units, calls: 0, accepted: 0, rejected: 0 })
    expect(result.units).toBe(units) // reference equality — never even allocates a new array
  })

  it('humanizeAdmittedUnits is a pure no-op with the flag ON but zero eligible units (e.g. every unit is identity/spec-fact/brand) — never spends a call asking the model to rewrite nothing', async () => {
    process.env.IH_HUMANIZER = 'on'
    try {
      const units: AdmittedUnit[] = [unit('Business B*tch', 'identity'), unit('Classic Fit', 'spec-fact')]
      const throwingDeps = { openai: { chat: { completions: { create: () => { throw new Error('must never be called with zero eligible units') } } } } } as never
      const result = await humanizeAdmittedUnits(units, { truthCtx: CTX, designName: 'X', deps: throwingDeps })
      expect(result).toEqual({ units, calls: 0, accepted: 0, rejected: 0 })
    } finally { delete process.env.IH_HUMANIZER }
  })
})

describe('ROUND M6/J1-J7: fail-closed transport/shape handling — "a dead client, a timeout, a malformed answer or an index mismatch keeps EVERY unit\'s source text, spends the one call"', () => {
  function on<T>(fn: () => Promise<T>): Promise<T> {
    process.env.IH_HUMANIZER = 'on'
    return fn().finally(() => { delete process.env.IH_HUMANIZER })
  }

  it('a client/transport error keeps every eligible unit\'s source text, 1 call spent', async () => {
    const units: AdmittedUnit[] = [unit('Graphic Crewneck Sweatshirts Women'), unit('Fall Crewneck')]
    const deps = { openai: { chat: { completions: { create: async () => { throw new Error('boom') } } } } } as never
    const result = await on(() => humanizeAdmittedUnits(units, { truthCtx: CTX, designName: 'X', deps }))
    expect(result.units).toEqual(units)
    expect(result.calls).toBe(1)
    expect(result.accepted).toBe(0)
    expect(result.rejected).toBe(2)
  })

  it('a malformed answer (no "rewrites" key) keeps every eligible unit\'s source text, 1 call spent', async () => {
    // RULING N5: a 2-word-or-shorter atom never even reaches the call (see the N5 describe block
    // below) — this unit has 3 words, so it stays eligible for the call this test exists to probe.
    const units: AdmittedUnit[] = [unit('Fall Graphic Crewneck')]
    const deps = { openai: { chat: { completions: { create: async () => ({ choices: [{ message: { content: '{}' }, finish_reason: 'stop' }] }) } } } } as never
    const result = await on(() => humanizeAdmittedUnits(units, { truthCtx: CTX, designName: 'X', deps }))
    expect(result.units).toEqual(units)
    expect(result.calls).toBe(1)
  })

  it('an index mismatch (i values do not cover 1..N — a gap AND a duplicate) keeps every unit\'s source text, 1 call spent', async () => {
    const units: AdmittedUnit[] = [unit('Fall Crewneck'), unit('Fun Sweatshirts for Women')]
    const deps = {
      openai: { chat: { completions: { create: async () => ({ choices: [{ message: { content: JSON.stringify({ rewrites: [{ i: 1, text: 'Fall Crewneck' }, { i: 1, text: 'duplicate' }] }) }, finish_reason: 'stop' }] }) } } },
    } as never
    const result = await on(() => humanizeAdmittedUnits(units, { truthCtx: CTX, designName: 'X', deps }))
    expect(result.units).toEqual(units) // GLOBAL fallback, not a partial salvage of the one valid-looking entry
    expect(result.calls).toBe(1)
  })

  it('an out-of-range index (i=99 on a 2-unit list) keeps every unit\'s source text, 1 call spent', async () => {
    // RULING N5: BOTH units here are eligible AND at least one is 3+ words, so the batch is not
    // short-circuited by the N5 skip before the call this test exists to probe.
    const units: AdmittedUnit[] = [unit('Fall Crewneck'), unit('Fun Sweatshirts for Women')]
    const deps = {
      openai: { chat: { completions: { create: async () => ({ choices: [{ message: { content: JSON.stringify({ rewrites: [{ i: 99, text: 'Fall Crewneck' }, { i: 2, text: 'Fun Sweatshirts for Women' }] }) }, finish_reason: 'stop' }] }) } } },
    } as never
    const result = await on(() => humanizeAdmittedUnits(units, { truthCtx: CTX, designName: 'X', deps }))
    expect(result.units).toEqual(units)
    expect(result.calls).toBe(1)
  })

  it('a well-formed response where ONE unit\'s proposed rewrite fails the net keeps ONLY that unit\'s source text — per-unit failure is never a whole-batch failure (distinct from the shape-malformed cases above); RULING N2: the ACCEPTED rewrite is APPENDED as an alternate, never a replacement — the SOURCE units are never mutated', async () => {
    const units: AdmittedUnit[] = [unit('Graphic Crewneck Sweatshirts Women'), unit('Fall Crewneck')]
    const deps = {
      openai: {
        chat: {
          completions: {
            create: async () => ({
              choices: [{
                message: {
                  content: JSON.stringify({
                    rewrites: [
                      { i: 1, text: 'Graphic Crewneck Sweatshirts for Women' }, // legal
                      { i: 2, text: 'Fall Crewneck with Cotton' }, // illegal: adds content word AND "with"
                    ],
                  }),
                },
                finish_reason: 'stop',
              }],
            }),
          },
        },
      },
    } as never
    const result = await on(() => humanizeAdmittedUnits(units, { truthCtx: CTX, designName: 'X', deps }))
    expect(result.calls).toBe(1)
    expect(result.accepted).toBe(1)
    expect(result.rejected).toBe(1)
    // Both SOURCE units are untouched — no in-place mutation, ever.
    expect(result.units[0].text).toBe('Graphic Crewneck Sweatshirts Women')
    expect(result.units[0].sourceText).toBeUndefined()
    expect(result.units[1].text).toBe('Fall Crewneck')
    expect(result.units[1].sourceText).toBeUndefined()
    // The accepted rewrite is a NEW, THIRD unit — an alternate spelling of units[0], never a copy of it.
    expect(result.units.length).toBe(3)
    const alt = result.units[2]
    expect(alt.text).toBe('Graphic Crewneck Sweatshirts for Women')
    expect(alt.sourceText).toBe('Graphic Crewneck Sweatshirts Women')
    expect(alt.altOf).toBe(units[0].id)
  })
})

describe('ROUND M6/J1-J7 + RULING N2: J5 — provenance, end to end (an accepted rewrite is offered as an ALTERNATE spelling; the search/tail see BOTH, the chooser decides which SHIPS)', () => {
  it('an accepted rewrite reaches the final rendered line through the REAL runWriterForDesign when the model PICKS the candidate carrying it — and the search itself tries BOTH the source and the alternate spelling, never only one (RULING N2 supersedes the pre-N "never the source" property)', async () => {
    process.env.IH_HUMANIZER = 'on'
    try {
      const truthCtx: PhraseTruthCtx = { ...CTX, audienceLean: 'women', designTokens: ['Test Design'] }
      const composed = {
        candidates: ['Graphic Crewneck Sweatshirts Women', 'Fall Crewneck'],
        specFacts: ['Classic Fit', '50% Cotton / 50% Polyester'], brandPick: null as string | null, wearFact: null as string | null,
      } as never
      let sawSourceSpellingAtTail = false
      let sawAltSpellingAtTail = false
      const runTail = (line: string) => {
        if (line.includes('Sweatshirts Women,') || line.includes('Sweatshirts Women ')) sawSourceSpellingAtTail = true
        if (line.includes('Sweatshirts for Women')) sawAltSpellingAtTail = true
        return { value: line, hold: null }
      }
      const humanizeDeps = {
        openai: {
          chat: {
            completions: {
              create: async (req: { messages: { role: string; content: string }[] }) => {
                const system = req.messages.find((m) => m.role === 'system')?.content ?? ''
                if (system.includes('rewrite a NUMBERED list')) {
                  return { choices: [{ message: { content: JSON.stringify({ rewrites: [{ i: 1, text: 'Graphic Crewneck Sweatshirts for Women' }, { i: 2, text: 'Fall Crewneck' }] }) }, finish_reason: 'stop' }] }
                }
                return { choices: [{ message: { content: JSON.stringify({ pick: 1 }) }, finish_reason: 'stop' }] }
              },
            },
          },
        },
      } as never
      const units = buildAdmittedUnits(composed, { designName: 'Test Design', truthCtx })
      const eligibleTexts = units.filter(isHumanizerEligible).map((u) => u.text)
      expect(eligibleTexts).toContain('Graphic Crewneck Sweatshirts Women')
      const r = await runWriterForDesign({
        composed, fallbackHold: null, designName: 'Test Design', truthCtx, runTail, deps: humanizeDeps,
      })
      expect(r.accepted).toBe(true)
      // RULING N2: the search offers BOTH spellings to the tail — the source is never withheld from
      // it just because an alternate exists.
      expect(sawSourceSpellingAtTail).toBe(true)
      expect(sawAltSpellingAtTail).toBe(true)
      // The MODEL's own pick (candidate 1, which here carries the alternate — verified by a separate
      // ranking probe) is what actually ships; code never decided which reads better.
      expect(r.value).toContain('Graphic Crewneck Sweatshirts for Women')
      expect(r.calls).toBe(2) // 1 humanize + 1 pick — J7's typical case
    } finally { delete process.env.IH_HUMANIZER }
  })

  it('RULING N2: with a DEAD client (every call throws), no alternate unit is ever created, so the search only ever offers the SOURCE spelling — rank 1 is then byte-identical to the flag-off shape (the identity rewrite of every eligible unit)', async () => {
    process.env.IH_HUMANIZER = 'on'
    try {
      const truthCtx: PhraseTruthCtx = { ...CTX, audienceLean: 'women', designTokens: ['Test Design'] }
      const composed = {
        candidates: ['Graphic Crewneck Sweatshirts Women', 'Fall Crewneck'],
        specFacts: ['Classic Fit', '50% Cotton / 50% Polyester'], brandPick: null as string | null, wearFact: null as string | null,
      } as never
      const runTail = (line: string) => ({ value: line, hold: null })
      const deadDeps = { openai: { chat: { completions: { create: async () => { throw new Error('dead gateway') } } } } } as never
      const rOn = await runWriterForDesign({ composed, fallbackHold: null, designName: 'Test Design', truthCtx, runTail, deps: deadDeps })
      delete process.env.IH_HUMANIZER
      const rOff = await runWriterForDesign({ composed, fallbackHold: null, designName: 'Test Design', truthCtx, runTail, deps: deadDeps })
      expect(rOn.value).toBe(rOff.value) // byte-identical: the dead humanize call spent 1 extra call but changed 0 bytes
      expect(rOn.calls).toBe(rOff.calls + 1) // the one dead humanize call is still billed
    } finally { delete process.env.IH_HUMANIZER }
  })
})

describe('ROUND M6/J1-J7: J3 — the proposer prompt teaches ONLY what J4 enforces', () => {
  it('names the six closed function words and forbids "with"/"in", and asks for the numbered {"rewrites":[...]} shape', () => {
    const { system, user } = buildHumanizerPrompt([unit('Fall Crewneck')], 'Test Design')
    for (const w of ['for', 'a', 'an', 'the', 'of', 'and']) expect(system).toContain(`"${w}"`)
    expect(system.toLowerCase()).toContain('with')
    expect(system.toLowerCase()).toContain('json')
    expect(user).toContain('1. Fall Crewneck')
    expect(user).toContain('rewrites')
  })
})

// ─── RULING N1 (round N, phase-n1-rulings.md, Blocking) — the character-set check ─────────────────
// M1's net review measured that `humanizerRawWords`'s `[A-Za-z0-9]` tokenizer (and `coverageTokens`'
// own `[^a-z0-9\s]` strip) are BOTH blind to any character outside that class — so a fullwidth
// Latin "Ｗｏｍｅｎ", CJK, an emoji or a "™"/"®" produces ZERO word tokens and sails through J4.1/
// J4.2 untouched. Each case below pairs the FOREIGN-character attack with its ASCII-equivalent
// CONTROL, which the pre-N1 net already refused correctly (`content-word-multiset`) — proving N1
// closes a hole the OTHER checks structurally cannot see, never merely duplicating them.
describe('RULING N1: humanizerRewriteVerdict — the character-set check (fullwidth Latin, CJK, emoji, ™/® all invisible to WORD_RE)', () => {
  const source = unit('Fall Crewneck')

  it('REFUSES a fullwidth-Latin "Ｗｏｍｅｎ" appended — invisible to the raw-word tokenizer (0 word tokens), caught ONLY by the character-set check', () => {
    const rewrite = 'Fall Crewneck Ｗｏｍｅｎ'
    // Premise: the ASCII-blind checks really would let this through — humanizerRawWords tokenizes
    // to exactly the SOURCE's own two words (the fullwidth text yields zero [A-Za-z0-9] matches).
    expect(rewrite.match(/[A-Za-z0-9]+/g)).toEqual(['Fall', 'Crewneck'])
    expect(humanizerRewriteVerdict(source, rewrite, CTX)).toEqual({ ok: false, reason: 'character-set' })
  })

  it('REFUSES CJK "女性" appended, same mechanism', () => {
    expect(humanizerRewriteVerdict(source, 'Fall Crewneck 女性', CTX)).toEqual({ ok: false, reason: 'character-set' })
  })

  it('REFUSES an emoji appended', () => {
    expect(humanizerRewriteVerdict(source, 'Fall Crewneck 🎃', CTX)).toEqual({ ok: false, reason: 'character-set' })
  })

  it('REFUSES "™" appended', () => {
    expect(humanizerRewriteVerdict(source, 'Fall Crewneck™', CTX)).toEqual({ ok: false, reason: 'character-set' })
  })

  it('REFUSES "®" appended', () => {
    expect(humanizerRewriteVerdict(source, 'Fall Crewneck®', CTX)).toEqual({ ok: false, reason: 'character-set' })
  })

  it('REFUSES a punctuation character the source never carried (review IMPORTANT 2\'s "the punctuation hole" — folded into N1, never a separate rule) — a comma splitting a unit into a false clause', () => {
    expect(humanizerRewriteVerdict(source, 'Fall, Crewneck', CTX)).toEqual({ ok: false, reason: 'character-set' })
    expect(humanizerRewriteVerdict(source, 'Fall | Crewneck', CTX)).toEqual({ ok: false, reason: 'character-set' })
  })

  it('the ASCII-equivalent CONTROL for the fullwidth attack ("for Women") is refused too, but by a DIFFERENT, pre-existing check — proving N1 is an ADDITIONAL net, not a replacement for J4.1/J4.2', () => {
    // On a UNISEX design (CTX above is 'women' so this control needs its own unisex ctx to land on
    // the SAME refusal the M1 net review measured).
    const unisexCtx: PhraseTruthCtx = { ...CTX, audienceLean: 'unisex' }
    expect(humanizerRewriteVerdict(source, 'Fall Crewneck for Women', unisexCtx)).toEqual({ ok: false, reason: 'content-word-multiset' })
  })

  it('ACCEPTS a same-character reorder/insertion — the character-set check is never triggered by legal, in-alphabet rewrites (no false positives)', () => {
    expect(humanizerRewriteVerdict(source, 'Crewneck Fall', CTX)).toEqual({ ok: true })
  })

  it('is case-insensitive, matching J4.1/J4.2\'s own case-folded comparisons — a casing-only change is never mistaken for a foreign character', () => {
    expect(humanizerRewriteVerdict(unit('fall crewneck'), 'Fall Crewneck', CTX)).toEqual({ ok: true })
  })

  // MUTATION PROOF (DISCIPLINE): executed by copying `itemHighlightWriter.ts` aside, commenting out
  // the ONE line `if (humanizerCharacterSetViolation(...)) return { ok: false, reason: 'character-set' }`,
  // re-running this suite, and restoring the file by copy (never `git stash`) — recorded in
  // `phase-n1-report.md`. Every one of the five REFUSE cases above went RED (accepted, ok:true) with
  // the check disabled, and none of the other suites in this file changed. Not repeated here because
  // it requires editing production source, which a committed test file must never do at run time.
})

// ─── RULING N2 (round N, Blocking) — the two deterministic hygiene rules ──────────────────────────
describe('RULING N2: humanizerRewriteVerdict — no adjacent duplicate function word, no inserted function word at either edge', () => {
  it('REFUSES a doubled adjacent function word ("for for") — the reviewer\'s own worked residual', () => {
    // "Embroidered Sweatshirts for Women" -> "Embroidered for for Sweatshirts Women": content words
    // unchanged (multiset-equal), the only addition is a SECOND "for", which the pre-N2 net's J4.1/
    // J4.2 both accepted (measured, `phase-m1-review-reading.md` residual.ts).
    const source = unit('Embroidered Sweatshirts for Women')
    const rewrite = 'Embroidered for for Sweatshirts Women'
    expect(rewrite.length).toBeLessThanOrEqual(source.text.length + 6)
    expect(humanizerRewriteVerdict(source, rewrite, CTX)).toEqual({ ok: false, reason: 'duplicate-function-word' })
  })

  it('REFUSES an inserted function word stranded at the START of the line', () => {
    const source = unit('Sweatshirts for Women Trendy')
    // "for Sweatshirts Women Trendy" reorders + the source's own "for" now opens the line — legal
    // under J4.1/J4.2 (same words, only "for" is inserted-set anyway) but stranded at the edge.
    // Use a genuinely INSERTED "the" at the front to isolate the boundary rule from a reorder.
    expect(humanizerRewriteVerdict(source, 'The Sweatshirts for Women Trendy', CTX)).toEqual({ ok: false, reason: 'boundary-function-word' })
  })

  it('REFUSES an inserted function word stranded at the END of the line', () => {
    const source = unit('Sweatshirts for Women Trendy')
    expect(humanizerRewriteVerdict(source, 'Sweatshirts for Women Trendy and', CTX)).toEqual({ ok: false, reason: 'boundary-function-word' })
  })

  it('does NOT fire on a boundary word the SOURCE itself already carried there (only INSERTED edge words are refused)', () => {
    // A pool phrase whose own first/last word happens to already be one of the six — reordering it
    // to keep that SAME word at the edge (never adding a new one there) must not be refused by a
    // rule that exists only for INSERTED edge words.
    const source = unit('The Real Deal')
    expect(humanizerRewriteVerdict(source, 'The Deal Real', CTX)).toEqual({ ok: true })
  })

  it('ACCEPTS a single inserted function word in the MIDDLE of a 4+ word phrase — the boundary rule is about the EDGES only', () => {
    const source = unit('Fall Graphic Sweatshirts Women')
    expect(humanizerRewriteVerdict(source, 'Fall Graphic Sweatshirts for Women', CTX)).toEqual({ ok: true })
  })

  // MUTATION PROOF (DISCIPLINE), recorded in `phase-n1-report.md`: disabling either
  // `humanizerAdjacentDuplicateFunctionWord` or `humanizerBoundaryInsertedFunctionWord` alone (by
  // copy-aside/comment/restore-by-copy) turns its own dedicated case above RED, while the other two
  // hygiene cases stay green — each rule has an independent witness.
})

// ─── RULING N2 (round N, Blocking) — the ALTERNATES design: enumerateWriterCandidates offers BOTH
// spellings, mutually exclusive, and the rank prefers the SOURCE when every other discriminator
// ties ──────────────────────────────────────────────────────────────────────────────────────────
describe('RULING N2: enumerateWriterCandidates — alternates are mutually exclusive, and rank 1 changes ONLY when the alternate is genuinely closer to the fill target', () => {
  const SPEC_FACTS = ihSpecFactFillers({ material: fixture.blank.material, fit: fixture.blank.fit, unisex: fixture.blank.unisex } as never).map(titleCasePhrase)
  const titleFor = (n: string) => fixture.titleTemplate.replace('{design}', n)
  function scenario(designKey: string) {
    const d = fixture.designs.find((x) => x.designKey === designKey)!
    const override = (fixture.audienceLeanByDesign as Record<string, string>)[designKey]
    const truthCtx: PhraseTruthCtx = {
      garmentFamily: fixture.blank.garmentFamily as 'sweatshirt',
      spec: { material: fixture.blank.material, fit: fixture.blank.fit, unisex: fixture.blank.unisex } as never,
      allowedBrand: null, audience: 'adult', field: 'highlights',
      audienceLean: normalizeAudienceLean((override ?? fixture.blank.audienceLean) as never), designTokens: [d.designName],
    } as PhraseTruthCtx
    const composed = { candidates: d.pool, specFacts: SPEC_FACTS, brandPick: null as string | null, wearFact: null as string | null } as never
    const units = buildAdmittedUnits(composed, { designName: d.designName, truthCtx })
    const runTail = (line: string) => runIhTail(line, { titles: [titleFor(d.designName)], blankBrand: null, truthCtx, capacityFamily: false, site: 'n2-rank-test' })
    return { units, truthCtx, runTail }
  }

  it('HDG: appending a net-legal, LONGER alternate ("Crewneck for Fall", +4c) for the sole pool unit "Fall Crewneck" moves rank 1 from the SOURCE spelling (101c, 9c from the 110c fill target) to the ALTERNATE (105c, 5c from target) — the primary rank discriminator (band fit), not the source-preferring tiebreak, decides here', () => {
    const { units, truthCtx, runTail } = scenario('HDG')
    const source = units.find((u) => u.text === 'Fall Crewneck')!
    const rewrite = 'Crewneck for Fall'
    expect(humanizerRewriteVerdict(source, rewrite, truthCtx)).toEqual({ ok: true }) // precondition: net-legal
    const withoutAlt = enumerateWriterCandidates(units, { truthCtx, runTail })
    expect(withoutAlt.candidates[0]?.line).toBe('Hustle Definition Sweatshirt, Fall Crewneck, with 50% Cotton / 50% Polyester, Classic Fit, Unisex Fit')
    const alt: AdmittedUnit = { id: `${source.id}~alt0`, text: rewrite, kind: source.kind, numberable: false, altOf: source.id, sourceText: source.text }
    const withAlt = enumerateWriterCandidates([...units, alt], { truthCtx, runTail })
    expect(withAlt.candidates[0]?.line).toBe('Hustle Definition Sweatshirt, Crewneck for Fall, with 50% Cotton / 50% Polyester, Classic Fit, Unisex Fit')
    expect(withAlt.candidates[0]?.usesAlternateSpelling).toBe(1)
    // The mutual-exclusion invariant: NO candidate in the alt-aware search ever carries BOTH the
    // source unit and its own alternate.
    expect(withAlt.candidates.some((c) =>
      c.parts.some((p) => 'unit' in p && p.unit === source.id) && c.parts.some((p) => 'unit' in p && p.unit === alt.id),
    )).toBe(false)
  })

  it('the mutual-exclusion check is load-bearing, not merely redundant with the repeat budget: when a source and its alternate share ONLY garment-head words (repeat budget 2, not 1 — `Pullover Crewneck Sweatshirt`\'s three words are all in `GARMENT_HEAD_WORDS`), using BOTH does not exceed any per-word cap and would otherwise SHIP the same fact stated twice', () => {
    const identity: AdmittedUnit = { id: 'u0', text: 'Hustle Definition', kind: 'identity', numberable: false }
    const spec1: AdmittedUnit = { id: 's0', text: '50% Cotton / 50% Polyester', kind: 'spec-fact', numberable: false }
    const spec2: AdmittedUnit = { id: 's1', text: 'Classic Fit', kind: 'spec-fact', numberable: false }
    const spec3: AdmittedUnit = { id: 's2', text: 'Unisex Fit', kind: 'spec-fact', numberable: false }
    const source: AdmittedUnit = { id: 'u2', text: 'Pullover Crewneck Sweatshirt', kind: 'pool', numberable: true }
    const alt: AdmittedUnit = { id: 'u2~alt0', text: 'Crewneck Pullover Sweatshirt', kind: 'pool', numberable: true, altOf: 'u2', sourceText: source.text }
    const truthCtx: PhraseTruthCtx = {
      garmentFamily: 'sweatshirt', spec: { material: '50% Cotton / 50% Polyester', fit: 'Classic', unisex: true } as never,
      allowedBrand: null, audience: 'adult', field: 'highlights', audienceLean: 'unisex', designTokens: ['Hustle Definition'],
    } as PhraseTruthCtx
    const runTail = (line: string) => runIhTail(line, { titles: ['Hustle Definition Sweatshirt'], blankBrand: null, truthCtx, capacityFamily: false, site: 'n2-garment-mutex-test' })
    const result = enumerateWriterCandidates([identity, spec1, spec2, spec3, source, alt], { truthCtx, runTail })
    // Never a candidate stating the SAME fact twice, regardless of which words carry it.
    expect(result.candidates.some((c) =>
      c.parts.some((p) => 'unit' in p && p.unit === source.id) && c.parts.some((p) => 'unit' in p && p.unit === alt.id),
    )).toBe(false)
  })
  // MUTATION PROOF (DISCIPLINE), recorded in `phase-n1-report.md`: disabling `maskHasConflict`'s call
  // (the `if (maskHasConflict(mask)) continue` line) turns the test above RED — a candidate
  // "Hustle Definition, Pullover Crewneck Sweatshirt, Crewneck Pullover Sweatshirt, with 50% Cotton
  // / 50% Polyester" (110c) SHIPS, stating the same product fact twice in different word order, and
  // passes every OTHER gate (all three words are garment-head class, repeat budget 2, never
  // exceeded). Confirmed the FIRST mutual-exclusion test above (the plain "Fall Crewneck" pair) does
  // NOT distinguish this mutation — that pair's shared word "fall" is budget-1 and is caught by the
  // pre-existing repeat check regardless, which is why this second, garment-word-only case exists.

  it('BB: an alternate that does NOT improve band fit (source\'s rank 1 is already exactly AT the 110c fill target) never displaces it — the EXPLICIT tiebreak prefers the source on a genuine tie, proven by placing the alternate BEFORE its source in the input (so a lower-bit / evaluation-order accident could not be what decides it)', () => {
    const { units, truthCtx, runTail } = scenario('BB')
    const withoutAlt = enumerateWriterCandidates(units, { truthCtx, runTail })
    const rank1 = withoutAlt.candidates[0]!
    expect(rank1.lengthFromTarget).toBe(0) // already perfectly on target — nothing can rank ABOVE it
    const source = units.find((u) => u.text === 'Embroidered Sweatshirts for Women')!
    // A same-length reorder (net-legal, changes nothing the rank scores) — a genuine tie.
    const alt: AdmittedUnit = { id: `${source.id}~alt0`, text: 'Sweatshirts for Embroidered Women', kind: source.kind, numberable: false, altOf: source.id, sourceText: source.text }
    expect(humanizerRewriteVerdict(source, alt.text, truthCtx)).toEqual({ ok: true })
    // The alt is placed FIRST (production always appends alts LAST — this deliberately inverts that
    // so the alt would occupy a LOWER bit / be evaluated BEFORE its source), isolating the EXPLICIT
    // `usesAlternateSpelling` tiebreak from any incidental array-order effect.
    const withAlt = enumerateWriterCandidates([alt, ...units], { truthCtx, runTail })
    expect(withAlt.candidates[0]?.line).toBe(rank1.line) // unchanged — source spelling wins the tie
    expect(withAlt.candidates[0]?.usesAlternateSpelling).toBe(0)
  })
})
