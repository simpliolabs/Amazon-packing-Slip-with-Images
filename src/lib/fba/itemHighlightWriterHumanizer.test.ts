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
  IH_HUMANIZER_CALL_BUDGET, buildHumanizerPrompt, buildAdmittedUnits, runWriterForDesign,
  type AdmittedUnit, type HumanizerRejectReason,
} from '@/lib/fba/itemHighlightWriter'
import { coverageTokens, isCovered } from '@/lib/keyword-engine/coverage-core'
import type { PhraseTruthCtx } from '@/lib/fba/contentTruth'

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

  it('J4.3 ACCEPTS at exactly the +6 boundary, REJECTS one character past it — both rewrites add ONLY closed-set words (so J4.1/J4.2 pass identically); length is the ONLY variable', () => {
    const source = unit('Fall Crewneck')
    const at6 = 'Fall Crewneck and a' // adds " and a" — both insertable, both pure additions
    const at7 = 'Fall Crewneck and an' // adds " and an" — one character longer than at6
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
    const units: AdmittedUnit[] = [unit('Fall Crewneck')]
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

  it('an out-of-range index (i=99 on a 1-unit list) keeps every unit\'s source text, 1 call spent', async () => {
    const units: AdmittedUnit[] = [unit('Fall Crewneck')]
    const deps = {
      openai: { chat: { completions: { create: async () => ({ choices: [{ message: { content: JSON.stringify({ rewrites: [{ i: 99, text: 'Fall Crewneck' }] }) }, finish_reason: 'stop' }] }) } } },
    } as never
    const result = await on(() => humanizeAdmittedUnits(units, { truthCtx: CTX, designName: 'X', deps }))
    expect(result.units).toEqual(units)
    expect(result.calls).toBe(1)
  })

  it('a well-formed response where ONE unit\'s proposed rewrite fails the net keeps ONLY that unit\'s source text — per-unit failure is never a whole-batch failure (distinct from the shape-malformed cases above)', async () => {
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
    expect(result.units[0].text).toBe('Graphic Crewneck Sweatshirts for Women')
    expect(result.units[0].sourceText).toBe('Graphic Crewneck Sweatshirts Women')
    expect(result.units[1].text).toBe('Fall Crewneck') // rejected -> kept source
    expect(result.units[1].sourceText).toBeUndefined() // never set on a unit whose rewrite was refused
  })
})

describe('ROUND M6/J1-J7: J5 — provenance, end to end (the rewrite is what SHIPS; sourceText is provenance only)', () => {
  it('an accepted rewrite reaches the final rendered line through the REAL runWriterForDesign — the picker, the grammar and the tail all see the REWRITE, never the source', async () => {
    process.env.IH_HUMANIZER = 'on'
    try {
      const truthCtx: PhraseTruthCtx = { ...CTX, audienceLean: 'women', designTokens: ['Test Design'] }
      const composed = {
        candidates: ['Graphic Crewneck Sweatshirts Women', 'Fall Crewneck'],
        specFacts: ['Classic Fit', '50% Cotton / 50% Polyester'], brandPick: null as string | null, wearFact: null as string | null,
      } as never
      let sawRewriteAtTail = false
      const runTail = (line: string) => {
        if (line.includes('Graphic Crewneck Sweatshirts for Women')) sawRewriteAtTail = true
        expect(line).not.toContain('Sweatshirts Women,') // the UN-rewritten form must never reach the tail
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
      expect(r.value).toContain('Graphic Crewneck Sweatshirts for Women')
      expect(sawRewriteAtTail).toBe(true)
      expect(r.calls).toBe(2) // 1 humanize + 1 pick — J7's typical case
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
