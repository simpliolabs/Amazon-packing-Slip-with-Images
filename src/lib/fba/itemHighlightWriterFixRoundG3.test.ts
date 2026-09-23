/**
 * itemHighlightWriterFixRoundG3.test.ts — Round G3/G4/G5 (`.superpowers/sdd/2026-09-10-ih-writer/
 * phase-g1-rulings.md`, THE DESIGN CHANGE: "the writer becomes a CHOOSER, not a composer"). G1/G2
 * (the truth-scope fix and the F1 narrowing) are pinned in `itemHighlightWriterFixRoundG1.test.ts`,
 * committed ahead of this file, and are NOT re-pinned here.
 *
 * WHAT PROMPTED THIS ROUND. `phase-f1-review.md` measured three rounds of teaching a grammar in
 * prose producing 18 live refusals (12 for a shape the grammar rejected, 3 over-length, 1 padded
 * glue), a worked example the real judge rejects 130 of 130 times, and a retry message that
 * contradicted the code. Meanwhile a brute-force SEARCH over the SAME family's units — no model
 * involved — found accepted, in-band lines. So the model stops composing and starts CHOOSING: code
 * enumerates every arrangement that already passes the FULL acceptance path
 * (`enumerateWriterCandidates`), ranks them, and the model returns ONE INDEX into the ranked list
 * (`buildWriterPrompt`, rebuilt as the chooser prompt). Every failure mode the model could produce
 * (malformed pick, missing key, out-of-range index, a client error, a timeout) collapses onto
 * candidate 1 — an arrangement ALREADY proven to ship — so an unvetted line can never reach a
 * customer; only "zero candidates" still falls back to the composer's own result.
 *
 * REPRODUCES FIRST: every fixture below is a REAL admitted-unit set built by the REAL
 * `buildAdmittedUnits`, judged by the REAL `judgeWriterArrangement`/`enumerateWriterCandidates` —
 * never a re-implementation of either. The chooser-loop tests use a REAL `runWriterForDesign` call
 * with a stub OpenAI client (never a live model call).
 *
 * DO NOT (per the ruling): widen a truth rule, touch title/bullets/backend/description, change
 * hold semantics, make a live model call, or load an env file.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  buildAdmittedUnits, enumerateWriterCandidates, buildWriterPrompt, runWriterForDesign,
  judgeWriterArrangement, renderArrangement, WRITER_RULE_REGISTRY, WRITER_CANDIDATE_TOP_K,
  IH_WRITER_RETRY_CAP,
  type AdmittedUnit, type WriterCandidate,
} from '@/lib/fba/itemHighlightWriter'
import { runIhTail } from '@/lib/fba/listingPipeline'
import { type BlankSpecRow } from '@/lib/fba/blankSpecs'
import { type PhraseTruthCtx } from '@/lib/fba/contentTruth'

// ─── shared fixtures ────────────────────────────────────────────────────────────────────────────

const NEVER: RegExp = /(?!)/
const BLEND: BlankSpecRow = { match: NEVER, spec: { brand: 'Gildan', brandInCopy: false, fit: 'Classic', material: '50% Cotton / 50% Polyester' } as never, styleCode: '18000', garmentFamily: 'sweatshirt' } as unknown as BlankSpecRow
const truthCtx: PhraseTruthCtx = { garmentFamily: 'sweatshirt', spec: { material: '50% Cotton / 50% Polyester', fit: 'Classic' } as never, allowedBrand: null, audience: 'adult', field: 'highlights' }
const runTail = (l: string) => runIhTail(l, { titles: [], blankBrand: BLEND, truthCtx, capacityFamily: false, site: 'g3-test' })

/** A real, multi-unit family — enough pool units and one truthful spec fact to give the search
 *  real room to work in, mirroring the live B0DSCDZC6K shape (`phase-f1-review.md`'s own units). */
function realUnits(designName = 'Dear Queen'): AdmittedUnit[] {
  const composed = { candidates: ['Fall Graphic Crewneck Sweatshirts', 'Made For Chilly Mornings', 'Cute Crewnecks', 'Cozy Fall Layer'], specFacts: ['Classic Fit'], brandPick: null, wearFact: null }
  return buildAdmittedUnits(composed, { designName, truthCtx })
}

function stubClient(answers: unknown[]) {
  let n = 0
  const calls: unknown[] = []
  return {
    calls,
    client: {
      chat: { completions: { create: async () => {
        const a = answers[Math.min(n, answers.length - 1)]
        n++
        calls.push(a)
        return { choices: [{ message: { role: 'assistant', content: JSON.stringify(a) }, finish_reason: 'stop' }] }
      } } },
    } as never,
  }
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// G3 point 1: enumerateWriterCandidates — every candidate returned has ALREADY passed the FULL
// acceptance path, the search is bounded, and the bound is reported.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe('G3 point 1: enumerateWriterCandidates only ever returns judge-accepted arrangements, and reports its own bound', () => {
  it('a real multi-unit family produces at least one candidate, and EVERY candidate independently re-judges OK through the REAL judgeWriterArrangement', () => {
    const units = realUnits()
    const result = enumerateWriterCandidates(units, { truthCtx, runTail })
    expect(result.candidates.length).toBeGreaterThan(0)
    for (const c of result.candidates) {
      const v = judgeWriterArrangement({ parts: c.parts }, units, { truthCtx, runTail })
      expect(v.ok, `candidate ${JSON.stringify(c.line)} must independently re-judge OK`).toBe(true)
      if (v.ok) expect(v.value).toBe(c.line) // byte-identical to the REAL judge's own output bytes
    }
  })

  it('a family with NO relation-eligible unit at all (no spec-fact/brand unit) produces ZERO candidates — readability\'s "at least one relation clause" rule means none COULD ever pass', () => {
    const composed = { candidates: ['Only Pool Phrase Here'], specFacts: [], brandPick: null, wearFact: null }
    const units = buildAdmittedUnits(composed, { designName: 'No Relation', truthCtx })
    const result = enumerateWriterCandidates(units, { truthCtx, runTail })
    expect(result.candidates).toEqual([])
  })

  it('returns AT MOST WRITER_CANDIDATE_TOP_K (<=8) candidates, ranked best-first', () => {
    const units = realUnits()
    const result = enumerateWriterCandidates(units, { truthCtx, runTail })
    expect(result.candidates.length).toBeLessThanOrEqual(WRITER_CANDIDATE_TOP_K)
    expect(WRITER_CANDIDATE_TOP_K).toBeLessThanOrEqual(8)
  })

  it('reports `evaluated` (a positive count of real judge calls spent) and `bounded: false` for a search this small', () => {
    const units = realUnits()
    const result = enumerateWriterCandidates(units, { truthCtx, runTail })
    expect(result.evaluated).toBeGreaterThan(0)
    expect(result.bounded).toBe(false)
  })

  it('MUTATION-CLASS PIN: candidates are RANKED (fewer keyword-shaped clauses, then closer to the fill target, then more distinct pool units) — never merely FOUND in an arbitrary order', () => {
    const units = realUnits()
    const result = enumerateWriterCandidates(units, { truthCtx, runTail })
    expect(result.candidates.length).toBeGreaterThan(1) // a vacuous sort-order check needs 2+
    for (let i = 1; i < result.candidates.length; i++) {
      const a = result.candidates[i - 1]
      const b = result.candidates[i]
      const aKey = [a.keywordShapedClauses, a.lengthFromTarget, -a.distinctPoolUnits]
      const bKey = [b.keywordShapedClauses, b.lengthFromTarget, -b.distinctPoolUnits]
      // `a` (earlier) must never be STRICTLY WORSE than `b` (later) lexicographically.
      let cmp = 0
      for (let k = 0; k < aKey.length && cmp === 0; k++) cmp = aKey[k] - bKey[k]
      expect(cmp, `candidate ${i - 1} (${JSON.stringify(aKey)}) must rank <= candidate ${i} (${JSON.stringify(bKey)})`).toBeLessThanOrEqual(0)
    }
  })

  it('every returned candidate carries a relation clause (readability\'s own invariant, enforced structurally by the search, never merely by luck)', () => {
    const units = realUnits()
    const result = enumerateWriterCandidates(units, { truthCtx, runTail })
    for (const c of result.candidates) {
      const hasRelationGlue = c.parts.some((p) => !('unit' in p) && (p.glue === 'with' || p.glue === 'in'))
      expect(hasRelationGlue, JSON.stringify(c.parts)).toBe(true)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// G3 point 3/G4: the chooser PROMPT — numbered candidate lines, {"pick": N}, nothing about grammar.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe('G3 point 3 / G4: buildWriterPrompt shows numbered candidate lines and asks for one index', () => {
  const sample: WriterCandidate[] = [
    { parts: [], line: 'Dear Queen Sweatshirt, Fall Graphic Crewneck Sweatshirts, with 50% Cotton / 50% Polyester', keywordShapedClauses: 1, distinctPoolUnits: 1, lengthFromTarget: 5 },
    { parts: [], line: 'Dear Queen Sweatshirt, Made For Chilly Mornings, with 50% Cotton / 50% Polyester', keywordShapedClauses: 1, distinctPoolUnits: 1, lengthFromTarget: 2 },
  ]

  it('the user message numbers every candidate 1..N, in the ORDER given (already ranked by the caller)', () => {
    const { user } = buildWriterPrompt(sample, 'Dear Queen')
    expect(user).toContain(`1. ${sample[0].line}`)
    expect(user).toContain(`2. ${sample[1].line}`)
  })

  it('the system message asks for JSON {"pick": <integer>} and nothing else', () => {
    const { system } = buildWriterPrompt(sample, 'Dear Queen')
    expect(system).toMatch(/\{"pick":\s*<integer>\}/)
    expect(system.toLowerCase()).toContain('json') // response_format: json_object convention
  })

  it('the user message states the valid pick range explicitly', () => {
    const { user } = buildWriterPrompt(sample, 'Dear Queen')
    expect(user).toMatch(new RegExp(`pick.*1-${sample.length}`))
  })

  it('sends the design name when given, and omits it when null (no identity to name)', () => {
    const withName = buildWriterPrompt(sample, 'Dear Queen')
    expect(withName.user).toContain('Dear Queen')
    const noName = buildWriterPrompt(sample, null)
    expect(noName.user).not.toMatch(/DESIGN:/)
  })

  // G4's own words: "Keep the registry for the validator's messages... a test asserts the prompt
  // contains no rule sentence it no longer needs to teach."
  it('G4 NEGATIVE-CONTENT PIN: the rendered prompt contains NONE of WRITER_RULE_REGISTRY\'s sentences — nothing is taught to the model any more', () => {
    const { system, user } = buildWriterPrompt(sample, 'Dear Queen')
    const rendered = system + '\n' + user
    for (const rule of WRITER_RULE_REGISTRY) {
      expect(rendered, `rule "${rule.id}"'s sentence must NOT appear`).not.toContain(rule.sentence)
    }
  })

  it('G4 NEGATIVE-CONTENT PIN: no grammar/band/repeat vocabulary survives in the prompt (the deleted lessons, by name)', () => {
    const { system, user } = buildWriterPrompt(sample, 'Dear Queen')
    const rendered = system + '\n' + user
    expect(rendered).not.toMatch(/THE GRAMMAR/)
    expect(rendered).not.toMatch(/97-125 characters/)
    expect(rendered).not.toMatch(/EXAMPLE — a VALID answer/)
    expect(rendered).not.toMatch(/Repeat rule/)
    expect(rendered).not.toMatch(/READABILITY:/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// G3 points 4/5: runWriterForDesign's chooser-loop semantics, through the REAL function with a
// STUB client (never a live model call).
// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe('G3 points 4/5: every failure mode collapses onto candidate 1 (except zero candidates)', () => {
  afterEach(() => vi.restoreAllMocks())

  const composed = { candidates: ['Fall Graphic Crewneck Sweatshirts', 'Made For Chilly Mornings', 'Cute Crewnecks', 'Cozy Fall Layer'], specFacts: ['Classic Fit'], brandPick: null, wearFact: null }

  function expectedCandidates() {
    const units = buildAdmittedUnits(composed, { designName: 'Dear Queen', truthCtx })
    return enumerateWriterCandidates(units, { truthCtx, runTail }).candidates
  }

  it('a VALID pick (in range) ships that EXACT candidate, one call, source byModel', async () => {
    const cands = expectedCandidates()
    expect(cands.length).toBeGreaterThan(1)
    const { client } = stubClient([{ pick: 2 }])
    const out = await runWriterForDesign({ composed, fallbackHold: null, designName: 'Dear Queen', truthCtx, runTail, deps: { openai: client } })
    expect(out.accepted).toBe(true)
    expect(out.value).toBe(cands[1].line)
    expect(out.calls).toBe(1)
  })

  it('an OUT-OF-RANGE pick ships candidate 1 (index 0), one call — no retry (a retry could not fix a well-formed but wrong answer)', async () => {
    const cands = expectedCandidates()
    const { client, calls } = stubClient([{ pick: 999 }])
    const out = await runWriterForDesign({ composed, fallbackHold: null, designName: 'Dear Queen', truthCtx, runTail, deps: { openai: client } })
    expect(out.accepted).toBe(true)
    expect(out.value).toBe(cands[0].line)
    expect(out.calls).toBe(1)
    expect(calls.length).toBe(1)
  })

  it('a NON-INTEGER pick ("pick": "two") ships candidate 1, one call', async () => {
    const cands = expectedCandidates()
    const { client } = stubClient([{ pick: 'two' }])
    const out = await runWriterForDesign({ composed, fallbackHold: null, designName: 'Dear Queen', truthCtx, runTail, deps: { openai: client } })
    expect(out.accepted).toBe(true)
    expect(out.value).toBe(cands[0].line)
    expect(out.calls).toBe(1)
  })

  it('a pick of 0 (below the 1-based range) ships candidate 1, one call', async () => {
    const cands = expectedCandidates()
    const { client } = stubClient([{ pick: 0 }])
    const out = await runWriterForDesign({ composed, fallbackHold: null, designName: 'Dear Queen', truthCtx, runTail, deps: { openai: client } })
    expect(out.accepted).toBe(true)
    expect(out.value).toBe(cands[0].line)
    expect(out.calls).toBe(1)
  })

  it('a MISSING "pick" key ({}) is a client-error SHAPE — retried up to IH_WRITER_RETRY_CAP, then falls back to candidate 1', async () => {
    const cands = expectedCandidates()
    const { client, calls } = stubClient([{}, {}, {}])
    const out = await runWriterForDesign({ composed, fallbackHold: null, designName: 'Dear Queen', truthCtx, runTail, deps: { openai: client } })
    expect(out.accepted).toBe(true)
    expect(out.value).toBe(cands[0].line)
    expect(out.calls).toBe(IH_WRITER_RETRY_CAP)
    expect(calls.length).toBe(IH_WRITER_RETRY_CAP)
  })

  it('a MISSING "pick" key that RECOVERS on the 2nd call ships the RECOVERED pick, 2 calls, source byModel', async () => {
    const cands = expectedCandidates()
    expect(cands.length).toBeGreaterThan(1)
    const { client } = stubClient([{}, { pick: 2 }])
    const out = await runWriterForDesign({ composed, fallbackHold: null, designName: 'Dear Queen', truthCtx, runTail, deps: { openai: client } })
    expect(out.accepted).toBe(true)
    expect(out.value).toBe(cands[1].line)
    expect(out.calls).toBe(2)
  })

  it('the writer DEADLINE already passed before the first call ships candidate 1 with ZERO calls (G3 point 4: "a timeout — candidate 1 ships")', async () => {
    const cands = expectedCandidates()
    const { client, calls } = stubClient([{ pick: 2 }])
    const out = await runWriterForDesign({ composed, fallbackHold: null, designName: 'Dear Queen', truthCtx, runTail, deps: { openai: client }, deadlineAt: Date.now() - 1 })
    expect(out.accepted).toBe(true)
    expect(out.value).toBe(cands[0].line)
    expect(out.calls).toBe(0)
    expect(calls.length).toBe(0) // never even asked — the deadline was already gone
  })

  it('ZERO candidates (no relation-eligible unit at all) is the ONLY case that still returns accepted:false, calls:0 — the composer\'s own result stands', async () => {
    const noRelationComposed = { candidates: ['Only Pool Phrase Here'], specFacts: [], brandPick: null, wearFact: null }
    const { client, calls } = stubClient([{ pick: 1 }])
    const out = await runWriterForDesign({ composed: noRelationComposed, fallbackHold: null, designName: 'No Relation', truthCtx, runTail, deps: { openai: client } })
    expect(out.accepted).toBe(false)
    expect(out.value).toBe('')
    expect(out.calls).toBe(0)
    expect(calls.length).toBe(0) // never asked the model at all — nothing to choose from
  })

  it('logs IH_WRITER_PICK with {design, candidates, picked, source, calls} on a real run', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { client } = stubClient([{ pick: 1 }])
    await runWriterForDesign({ composed, fallbackHold: null, designName: 'Dear Queen', truthCtx, runTail, deps: { openai: client } })
    const pickLog = logSpy.mock.calls.map((c) => String(c[0])).find((s) => s.includes('IH_WRITER_PICK'))
    expect(pickLog, 'an IH_WRITER_PICK log line must be emitted').toBeDefined()
    const parsed = JSON.parse(pickLog!)
    expect(parsed).toMatchObject({ tag: 'IH_WRITER_PICK', design: 'Dear Queen', picked: 1, source: 'byModel', calls: 1 })
    expect(typeof parsed.candidates).toBe('number')
  })
})
