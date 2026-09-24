/**
 * itemHighlightWriterFixRoundQ1.test.ts — `.superpowers/sdd/2026-09-10-ih-writer/phase-q1-
 * rulings.md`, RULINGS Q1-Q7. Round P shipped THREE new net rules (P2 audience-crossing, P3
 * non-ASCII case, P5 punctuation position) with ZERO committed assertions —
 * `phase-p1-review-net.md` IMPORTANT 2 measured a mutant deleting all three GREEN. This file is
 * the fence: every rule this round and last touches gets a pin here, and every pin in this file
 * has been mutation-proved (copy-aside / restore-by-copy, never `git stash`) — see
 * `phase-q1-report.md` for the paste of each one actually going RED.
 *
 * DO NOT read this file as a redesign: Q1-Q7 are bounded fixes to `itemHighlightWriter.ts`'s own
 * search/net/prompt code, never to `phraseTruthVerdict`, `ihLineTruthVerdict` or any shared
 * composer predicate.
 */
import { describe, it, expect } from 'vitest'
import {
  humanizerRewriteVerdict, buildWriterPrompt, runWriterForDesign, enumerateWriterCandidates,
  buildAdmittedUnits, humanizeAdmittedUnits, isHumanizerEligible, type AdmittedUnit, type WriterCandidate,
} from '@/lib/fba/itemHighlightWriter'
import { runIhTail, produceItemHighlightsPerDesign } from '@/lib/fba/listingPipeline'
import { LEAN_FEM_CORE, LEAN_MASC_CORE, normalizeAudienceLean, type PhraseTruthCtx } from '@/lib/fba/contentTruth'
import { ihSpecFactFillers } from '@/lib/fba/productDetailAttrs'
import { titleCasePhrase } from '@/lib/fba/titleBand'
import type { BlankSpecRow } from '@/lib/fba/blankSpecs'
import type { AnalyzedKeyword } from '@/lib/keyword-engine'
import fixture from './__fixtures__/b0dscdzc6k-item-highlights-2026-09-23.json'

const CTX: PhraseTruthCtx = {
  garmentFamily: 'sweatshirt',
  spec: { material: '50% Cotton / 50% Polyester', fit: 'Classic', unisex: true } as never,
  allowedBrand: null, audience: 'adult', field: 'highlights', audienceLean: 'women',
}
const unit = (text: string, kind: AdmittedUnit['kind'] = 'pool'): AdmittedUnit => ({ id: 'x', text, kind, numberable: false })

// ─── RULING Q2: derived DIRECTLY from LEAN_FEM_CORE/LEAN_MASC_CORE — never a hand-typed word list ─
// A tiny regex-fragment expander over the ONE grammar these two core strings actually use: a
// sequence of atoms, each either a literal character or a `[...]` class, each optionally suffixed
// `?`. This makes the enumeration a SOURCE-SCAN of the canonical core, not a snapshot of it — if
// the core's own alternation grows a new word, this list grows with it.
function expandAtomSeq(pattern: string): string[] {
  const atoms: string[][] = []
  let i = 0
  while (i < pattern.length) {
    let choices: string[]
    if (pattern[i] === '[') {
      const end = pattern.indexOf(']', i)
      choices = pattern.slice(i + 1, end).split('')
      i = end + 1
    } else {
      choices = [pattern[i]]
      i += 1
    }
    if (pattern[i] === '?') { choices = ['', ...choices]; i += 1 }
    atoms.push(choices)
  }
  let results = ['']
  for (const choices of atoms) {
    const next: string[] = []
    for (const r of results) for (const c of choices) next.push(r + c)
    results = next
  }
  return [...new Set(results)]
}
function expandCore(core: string): string[] {
  return [...new Set(core.split('|').flatMap(expandAtomSeq))].filter((w) => w.length > 0)
}
const CANONICAL_AUDIENCE_WORDS = [...new Set([...expandCore(LEAN_FEM_CORE), ...expandCore(LEAN_MASC_CORE), 'adults', 'adult'])]

describe('RULING Q2 (round Q, Blocking): AUDIENCE_NOUN_RE derived from LEAN_FEM_CORE/LEAN_MASC_CORE, source-scan enumeration', () => {
  it('sanity: the expander actually expanded the core into >= 20 distinct literal words (never a degenerate 0/1-word list)', () => {
    expect(CANONICAL_AUDIENCE_WORDS.length).toBeGreaterThanOrEqual(20)
    expect(CANONICAL_AUDIENCE_WORDS).toContain('women')
    expect(CANONICAL_AUDIENCE_WORDS).toContain('guys')
    expect(CANONICAL_AUDIENCE_WORDS).toContain('adults')
  })

  it("FAILS the instant a word the canonical core's own alternation admits is missing from the detector — every one of the core's literal expansions refuses the SAME claim-flip P2 was ruled for", () => {
    for (const word of CANONICAL_AUDIENCE_WORDS) {
      const cased = word.charAt(0).toUpperCase() + word.slice(1)
      const source = unit(`Embroidered Sweatshirts for ${cased}`)
      const rewrite = `Sweatshirts for the Embroidered ${cased}`
      const v = humanizerRewriteVerdict(source, rewrite, { ...CTX, audienceLean: 'unisex' })
      expect(v, `word=${word}`).toEqual({ ok: false, reason: 'audience-noun-crossing' })
    }
  })

  it('measured bug rows (phase-p1-review-net.md BLOCKING 1): Womens, Woman and lady all refuse now — the SAME flip the GENDER_FOLDS-derived set let through 18 of 22 times', () => {
    expect(humanizerRewriteVerdict(unit('Embroidered Sweatshirts for Womens'), 'Sweatshirts for the Embroidered Womens', { ...CTX, audienceLean: 'unisex' }))
      .toEqual({ ok: false, reason: 'audience-noun-crossing' })
    expect(humanizerRewriteVerdict(unit('Embroidered Sweatshirt for Woman'), 'Sweatshirt for the Embroidered Woman', { ...CTX, audienceLean: 'unisex' }))
      .toEqual({ ok: false, reason: 'audience-noun-crossing' })
    expect(humanizerRewriteVerdict(unit('Embroidered Sweatshirts for lady'), 'Sweatshirts for the Embroidered lady', { ...CTX, audienceLean: 'unisex' }))
      .toEqual({ ok: false, reason: 'audience-noun-crossing' })
  })

  it('every occurrence is checked, not only the first (`phase-p1-review-wire.md` IMPORTANT 4): a noun repeated in the source no longer hides a crossing behind its own first occurrence', () => {
    const v = humanizerRewriteVerdict(unit('Ladies Embroidered Sweatshirts for Ladies'), 'Ladies Sweatshirts for the Embroidered Ladies', { ...CTX, audienceLean: 'unisex' })
    expect(v).toEqual({ ok: false, reason: 'audience-noun-crossing' })
  })

  it('"Moms" — outside the 22-word canonical core, so the DETERMINISTIC net alone does not refuse it (measured, not asserted false) — closed instead by RULING Q3\'s safe-default referee, proved end to end below', () => {
    const v = humanizerRewriteVerdict(unit('Embroidered Sweatshirts for Moms'), 'Sweatshirts for the Embroidered Moms', { ...CTX, audienceLean: 'unisex' })
    expect(v).toEqual({ ok: true }) // reaches the ballot as an [ALT] — Q3 refuses it there.
  })
})

// ─── RULING Q3: falseAlt REQUIRED whenever an [ALT] is on the ballot; silence refuses it ─────────
describe('RULING Q3 (round Q, Blocking): the referee prompt is qualified, and falseAlt is REQUIRED — silence is the safe answer, never approval', () => {
  const candidates: WriterCandidate[] = [
    { parts: [{ unit: 'src' }], line: 'Fall Crewneck Sweatshirt', keywordShapedClauses: 0, distinctPoolUnits: 1, lengthFromTarget: 5, usesAlternateSpelling: 0 },
    { parts: [{ unit: 'alt' }], line: 'Sweatshirt Fall Crewneck', keywordShapedClauses: 0, distinctPoolUnits: 1, lengthFromTarget: 4, usesAlternateSpelling: 1 },
  ]

  it('(a) BOTH "already verified" sentences are qualified to grammar/length/repeats ONLY when an [ALT] is on the ballot', () => {
    const { system, user } = buildWriterPrompt(candidates, 'Test Design', ['Design name/theme: "Test Design"'])
    expect(system).toContain('for GRAMMAR, LENGTH AND REPEATS ONLY')
    expect(user).toContain('CANDIDATES (already verified for grammar, length and repeats — pick one by number):')
    expect(system).toContain('"falseAlt" is REQUIRED')
  })

  it('zero-alt ballot: BYTE-IDENTICAL to the pre-Q3/pre-P2 prompt (additive, never a behaviour change to the path every existing pin already covers)', () => {
    const zeroAlt: WriterCandidate[] = [{ ...candidates[0] }]
    const { system, user } = buildWriterPrompt(zeroAlt, 'Test Design', ['Design name/theme: "Test Design"'])
    expect(system).toBe('You choose ONE Amazon Item Highlight line for a t-shirt/apparel listing from a NUMBERED list of candidate lines — you do not write or edit any text, and no grammar, length or repeat rule is yours to apply: every candidate below has ALREADY been verified to satisfy every one of them. Return JSON: {"pick": <integer>} — the number of the ONE candidate you choose, and nothing else. Do not invent a number outside the list, and do not return any other key. Pick the candidate that reads best to a shopper — the one that sounds most like a real sentence about this product, not a list of keywords. If you are unsure, picking 1 is always a safe answer.')
    expect(user).toContain('CANDIDATES (already verified — pick one by number):')
  })

  it('(c) the [ALT] branch is suppressed entirely when truthFacts is empty (no design name, no spec/lean facts) — no [ALT] marker, no falseAlt ask, even though a candidate DOES carry an alternate', () => {
    const { system, user } = buildWriterPrompt(candidates, null, [])
    expect(user).not.toContain('[ALT]')
    expect(system).not.toContain('falseAlt')
    expect(user).toContain('CANDIDATES (already verified — pick one by number):')
  })

  function truthCtxWithAlt() {
    const truthCtx: PhraseTruthCtx = { ...CTX, audienceLean: 'women', designTokens: ['Test Design'] }
    const composed = { candidates: ['Graphic Crewneck Sweatshirts Women', 'Fall Crewneck'], specFacts: ['Classic Fit', '50% Cotton / 50% Polyester'], brandPick: null, wearFact: null } as never
    return { composed, truthCtx }
  }
  function humanizeDeps(pickBody: Record<string, unknown>) {
    return {
      openai: {
        chat: { completions: { create: async (req: { messages: { role: string; content: string }[] }) => {
          const system = req.messages.find((m) => m.role === 'system')?.content ?? ''
          const user = req.messages.find((m) => m.role === 'user')?.content ?? ''
          if (system.includes('rewrite a NUMBERED list')) {
            const lines = [...user.matchAll(/^(\d+)\.\s(.+)$/gm)]
            return { choices: [{ message: { content: JSON.stringify({ rewrites: lines.map(([, i, text]) => ({ i: Number(i), text: text === 'Graphic Crewneck Sweatshirts Women' ? 'Graphic Crewneck Sweatshirts for Women' : text })) }) }, finish_reason: 'stop' }] }
          }
          const opts = [...user.matchAll(/^(\d+)\.\s(.+)$/gm)].map(([, i, text]) => ({ i: Number(i), text }))
          const hit = opts.find((o) => o.text.includes('Graphic Crewneck Sweatshirts for Women'))
          return { choices: [{ message: { content: JSON.stringify({ pick: hit ? hit.i : 1, ...pickBody }) }, finish_reason: 'stop' }] }
        } } },
      } as never,
    }
  }

  it('(b) MISSING falseAlt on a well-formed {"pick": <ALT>} — measured bug (`phase-p1-review-net.md` BLOCKING 2b, `phase-p1-review-wire.md` BLOCKING 1): does NOT ship the ALT; falls back to slot 1', async () => {
    process.env.IH_HUMANIZER = 'on'
    try {
      const { composed, truthCtx } = truthCtxWithAlt()
      const r = await runWriterForDesign({ composed, fallbackHold: null, designName: 'Test Design', truthCtx, runTail: (line) => ({ value: line, hold: null }), deps: humanizeDeps({}) })
      expect(r.accepted).toBe(true)
      expect(r.value).not.toContain('Graphic Crewneck Sweatshirts for Women')
      expect(r.value).toContain('Graphic Crewneck Sweatshirts Women') // slot 1: the SOURCE spelling
      expect(r.reasons.some((x) => x.includes('missing/malformed "falseAlt"'))).toBe(true)
    } finally { delete process.env.IH_HUMANIZER }
  })

  it('MALFORMED falseAlt (a string, not an array of integers) on a picked ALT — same refusal', async () => {
    process.env.IH_HUMANIZER = 'on'
    try {
      const { composed, truthCtx } = truthCtxWithAlt()
      const r = await runWriterForDesign({ composed, fallbackHold: null, designName: 'Test Design', truthCtx, runTail: (line) => ({ value: line, hold: null }), deps: humanizeDeps({ falseAlt: 'none' }) })
      expect(r.value).not.toContain('Graphic Crewneck Sweatshirts for Women')
    } finally { delete process.env.IH_HUMANIZER }
  })

  it('EXPLICIT falseAlt: [] on a picked ALT — the referee explicitly judged it true; the ALT SHIPS', async () => {
    process.env.IH_HUMANIZER = 'on'
    try {
      const { composed, truthCtx } = truthCtxWithAlt()
      const r = await runWriterForDesign({ composed, fallbackHold: null, designName: 'Test Design', truthCtx, runTail: (line) => ({ value: line, hold: null }), deps: humanizeDeps({ falseAlt: [] }) })
      expect(r.value).toContain('Graphic Crewneck Sweatshirts for Women')
    } finally { delete process.env.IH_HUMANIZER }
  })

  it('the referee names its own pick in falseAlt — vetoed, not shipped (RULING P2, preserved)', async () => {
    process.env.IH_HUMANIZER = 'on'
    try {
      const { composed, truthCtx } = truthCtxWithAlt()
      const units = buildAdmittedUnits(composed, { designName: 'Test Design', truthCtx })
      const humanized = await humanizeAdmittedUnits(units, { truthCtx, designName: 'Test Design', deps: humanizeDeps({}) })
      const en = enumerateWriterCandidates(humanized.units, { truthCtx, runTail: (line) => ({ value: line, hold: null }) })
      const altIdx = en.candidates.findIndex((c) => c.usesAlternateSpelling > 0) + 1
      expect(altIdx).toBeGreaterThan(0)
      const r = await runWriterForDesign({ composed, fallbackHold: null, designName: 'Test Design', truthCtx, runTail: (line) => ({ value: line, hold: null }), deps: humanizeDeps({ falseAlt: [altIdx] }) })
      expect(r.value).not.toContain('Graphic Crewneck Sweatshirts for Women')
    } finally { delete process.env.IH_HUMANIZER }
  })

  it("end to end, real produceItemHighlightsPerDesign: 'Moms' is refused via THIS safe-default fallback (Q2's deterministic net does not cover it — measured above) — IH_HUMANIZER=on is byte-identical to =off on the real family with 'Moms' in the pool", async () => {
    const DESIGNS = fixture.designs.map((d) => ({ key: d.designKey, name: d.designName }))
    const KEYS = DESIGNS.map((d) => d.key)
    const kwFor = (keyword: string, searchVolume: number): AnalyzedKeyword =>
      ({ keyword, searchVolume, themeFit: 3, themeFitByDesign: Object.fromEntries(KEYS.map((k) => [k, { fit: 3 }])) } as unknown as AnalyzedKeyword)
    const POOL = ['embroidered sweatshirts for moms', 'fall crewneck']
    const titleFor = (n: string) => fixture.titleTemplate.replace('{design}', n)
    const BLANK: BlankSpecRow = {
      match: /(?!)/, spec: { brand: fixture.blank.brand, brandInCopy: fixture.blank.brandInCopy, fit: fixture.blank.fit, material: fixture.blank.material, unisex: fixture.blank.unisex } as never,
      styleCode: fixture.blank.styleCode, garmentFamily: fixture.blank.garmentFamily,
    } as unknown as BlankSpecRow
    const INPUT = {
      groups: DESIGNS.map((d, i) => ({ key: d.key, designName: d.name, skus: [{ sku: d.key + '-1', asin: 'B0Q1TEST' + i }], titles: [titleFor(d.name)] })),
      pool: POOL.map((k, i) => kwFor(k, 5000 - i * 10)), apparelProduct: true, blankBrand: BLANK,
      familyTitleText: DESIGNS.map((d) => titleFor(d.name)).join(' '), audienceLean: 'unisex' as never,
    }
    const flip = (text: string) => {
      const m = /^(\w+)\s+(.*\bfor\s+Moms)$/i.exec(text)
      return m ? m[2].replace(/for Moms$/i, 'for the ' + m[1] + ' Moms') : text
    }
    const stub = () => ({ chat: { completions: { create: async (req: { messages: { role: string; content: string }[] }) => {
      const system = req.messages.find((m) => m.role === 'system')?.content ?? ''
      const user = req.messages.find((m) => m.role === 'user')?.content ?? ''
      if (system.includes('rewrite a NUMBERED list')) {
        const lines = [...user.matchAll(/^(\d+)\.\s(.+)$/gm)]
        return { choices: [{ message: { content: JSON.stringify({ rewrites: lines.map(([, i, text]) => ({ i: Number(i), text: flip(text) })) }) }, finish_reason: 'stop' }] }
      }
      const m = /^(\d+)\..*\[ALT\]\s*$/m.exec(user)
      return { choices: [{ message: { content: JSON.stringify({ pick: m ? Number(m[1]) : 1 }) }, finish_reason: 'stop' }] } // NO falseAlt — the exact bug shape.
    } } } } as never)
    process.env.IH_WRITER = 'on'; process.env.IH_HUMANIZER = 'off'
    const off = await produceItemHighlightsPerDesign(INPUT as never, { openai: stub() })
    process.env.IH_HUMANIZER = 'on'
    const on = await produceItemHighlightsPerDesign(INPUT as never, { openai: stub() })
    delete process.env.IH_WRITER; delete process.env.IH_HUMANIZER
    for (let i = 0; i < off.perDesign.length; i++) {
      expect(on.perDesign[i].value, off.perDesign[i].designKey).toBe(off.perDesign[i].value)
      expect(on.perDesign[i].value).not.toMatch(/for the \w+ Moms/i)
    }
  })
})

// ─── RULING P3 (round P), pinned here for the FIRST time (phase-p1-review-net.md IMPORTANT 2: a
// mutant deleting it was GREEN because no committed test exercised it at all) ─────────────────────
describe('RULING P3 (round P, Blocking): the non-ASCII per-CHARACTER case check — Café/Piñata/Ж all refuse case, pinned for the first time this programme', () => {
  it('Café -> CafÉ (accented Latin, invisible to WORD_RE) refuses case', () => {
    expect(humanizerRewriteVerdict(unit('Café Fall Crewneck'), 'CafÉ Fall Crewneck', CTX)).toEqual({ ok: false, reason: 'case' })
  })
  it('Piñata -> PiÑata refuses case', () => {
    expect(humanizerRewriteVerdict(unit('Piñata Fall Crewneck'), 'PiÑata Fall Crewneck', CTX)).toEqual({ ok: false, reason: 'case' })
  })
  it('Cyrillic ж -> Ж refuses case', () => {
    expect(humanizerRewriteVerdict(unit('жFall Crewneck'), 'ЖFall Crewneck', CTX)).toEqual({ ok: false, reason: 'case' })
  })
})

// ─── RULING Q4: the case exemption checked against the source's CASE-FOLDED budget ───────────────
describe('RULING Q4 (round Q, Blocking): the insertable-word canonical-lowercase exemption is checked against the CASE-FOLDED remaining budget, not the one exact-cased key the loop happens to hold', () => {
  it('measured bug rows (phase-p1-review-net.md BLOCKING 3), pinned RED: source-owned "The"/"For"/"And" LOWERCASED by the rewrite is now refused', () => {
    expect(humanizerRewriteVerdict(unit('The Fall Crewneck Women'), 'Fall Crewneck the Women', CTX)).toEqual({ ok: false, reason: 'case' })
    expect(humanizerRewriteVerdict(unit('Sweatshirts For Women Fall'), 'Sweatshirts for Women Fall', CTX)).toEqual({ ok: false, reason: 'case' })
    expect(humanizerRewriteVerdict(unit('Fall And Crewneck Women'), 'Fall Crewneck and Women', CTX)).toEqual({ ok: false, reason: 'case' })
  })

  it('the legitimate relocation stays GREEN: "The Fall Crewneck Women" -> "Fall Crewneck The Women" keeps the source\'s own exact casing', () => {
    expect(humanizerRewriteVerdict(unit('The Fall Crewneck Women'), 'Fall Crewneck The Women', CTX)).toEqual({ ok: true })
  })

  it('a GENUINELY new insertable word (source carries none of it at any casing) still passes via the canonical-lowercase exemption — the exemption is narrowed, not removed', () => {
    expect(humanizerRewriteVerdict(unit('Graphic Crewneck Sweatshirts Women'), 'Graphic Crewneck Sweatshirts for Women', CTX)).toEqual({ ok: true })
  })

  it('the reverse direction (source lowercase "the", rewrite Title-cased "The") is unaffected — still refused (unchanged control)', () => {
    expect(humanizerRewriteVerdict(unit('Fall the Crewneck Women'), 'Fall Crewneck The Women', CTX)).toEqual({ ok: false, reason: 'case' })
  })
})

// ─── RULING Q7 (first half): punctuation position keyed on the neighbour WORD pair ───────────────
describe('RULING Q7 (round Q, Important, first half): punctuation position keyed on the neighbour WORD pair, not the neighbour CHARACTERS', () => {
  it('measured bug (phase-p1-review-net.md IMPORTANT 1), pinned RED: a hyphen relocated between an UNRELATED word pair that merely shares the same boundary LETTERS no longer passes', () => {
    const v = humanizerRewriteVerdict(unit('Long-Sleeve Strong Sweatshirts'), 'Long Sleeve Strong-Sweatshirts', CTX)
    expect(v).toEqual({ ok: false, reason: 'character-set' })
  })
  it('the SAME reordering rows, pinned RED', () => {
    expect(humanizerRewriteVerdict(unit('Long-Sleeve Strong Sweatshirts'), 'Strong-Sweatshirts Long Sleeve', CTX)).toEqual({ ok: false, reason: 'character-set' })
    expect(humanizerRewriteVerdict(unit('Long-Sleeve Snug Sweatshirts'), 'Long Sleeve Snug-Sweatshirts', CTX)).toEqual({ ok: false, reason: 'character-set' })
  })
  it('CONTROL, pinned GREEN: the compound the source DID bind travels as a unit — reordering "Long-Sleeve Fall Crewneck" to "Fall Crewneck Long-Sleeve" keeps the SAME two neighbour words either side of the hyphen', () => {
    expect(humanizerRewriteVerdict(unit('Long-Sleeve Fall Crewneck'), 'Fall Crewneck Long-Sleeve', CTX)).toEqual({ ok: true })
  })
  it('KNOWN RESIDUAL, measured not claimed closed: a mark relocated between two OTHER occurrences of an identical word pair can still pass — this repo\'s real admitted pool text never repeats a word immediately either side of a punctuation mark', () => {
    const v = humanizerRewriteVerdict(unit('50/50 Cotton 50 50 Crewneck'), '50 50 Cotton 50/50 Crewneck', CTX)
    expect(v).toEqual({ ok: true }) // residual — documented, not silently claimed fixed.
  })
})

// ─── RULING Q7 (second half): truncated alt-groups are logged as a COUNT, never silent ───────────
describe('RULING Q7 (round Q, Important, second half): truncatedGroups is a real count on the result, never only the pre-existing boolean', () => {
  it('zero on the committed fixture (well under the 8-group cap)', async () => {
    const truthCtx: PhraseTruthCtx = { ...CTX, audienceLean: 'women', designTokens: ['Test'] }
    const units = buildAdmittedUnits({ candidates: ['Fall Crewneck', 'Graphic Tee'], specFacts: ['Classic Fit'], brandPick: null, wearFact: null } as never, { designName: 'Test', truthCtx })
    const en = enumerateWriterCandidates(units, { truthCtx, runTail: (line) => ({ value: line, hold: null }) })
    expect(en.truncatedGroups).toBe(0)
  })

  it('non-zero and COUNTED once a design carries more than WRITER_CANDIDATE_MAX_POOL_UNITS (8) ordinary pool groups', async () => {
    const truthCtx: PhraseTruthCtx = { ...CTX, audienceLean: 'unisex', designTokens: ['Test'] }
    // 10 ordinary pool phrases, each 2+ words so none is dropped by the short-atom skip — the cap
    // (8) is on GROUP COUNT, so this exercises the same truncation `bounded` already flagged, now
    // as a real number.
    const candidates = Array.from({ length: 10 }, (_, i) => `Fall Crewneck ${i}`)
    const units = buildAdmittedUnits({ candidates, specFacts: ['Classic Fit'], brandPick: null, wearFact: null } as never, { designName: 'Test', truthCtx })
    const en = enumerateWriterCandidates(units, { truthCtx, runTail: (line) => ({ value: line, hold: null }) })
    expect(en.bounded).toBe(true)
    expect(en.truncatedGroups).toBeGreaterThan(0)
  })
})

// ─── RULING Q1: additive AND reachable, proved in the SAME run, on the REAL fixture ───────────────
describe('RULING Q1 (round Q, Blocking): pass 2 gets its OWN evaluation budget — additive (candidate 1 byte-identical to flag-off) AND reachable (an alt-carrying candidate reaches a BOUNDED search on BB/MHG at the family\'s real pool size 6) in the SAME run', () => {
  const SPEC_FACTS = ihSpecFactFillers({
    material: fixture.blank.material, fit: fixture.blank.fit, unisex: fixture.blank.unisex,
    neck: (fixture.blank as never as Record<string, unknown>).neck, sleeve: (fixture.blank as never as Record<string, unknown>).sleeve,
  } as never).map(titleCasePhrase)
  const titleFor = (n: string) => fixture.titleTemplate.replace('{design}', n)
  const leanFor = (k: string) => normalizeAudienceLean((((fixture.audienceLeanByDesign as never as Record<string, unknown>) ?? {})[k] ?? fixture.blank.audienceLean) as never)
  const REWRITES: Record<string, string> = {
    'Sweatshirts for Women Trendy': 'Trendy Sweatshirts for Women',
    'Graphic Crewneck Sweatshirts Women': 'Graphic Crewneck Sweatshirts for Women',
  }
  const NUM_LINE = new RegExp('^(\\d+)\\.\\s(.+)$', 'gm')
  function client(mode: 'ok1' | 'throw' | 'noKey' | 'outOfRange' | 'garbage', humanizeLive: boolean) {
    return { chat: { completions: { create: async (req: { messages: { role: string; content: string }[] }) => {
      const system = req.messages.find((m) => m.role === 'system')?.content ?? ''
      const user = req.messages.find((m) => m.role === 'user')?.content ?? ''
      if (system.includes('rewrite a NUMBERED list')) {
        if (!humanizeLive) throw new Error('humanize dead')
        const lines = [...user.matchAll(NUM_LINE)]
        return { choices: [{ message: { content: JSON.stringify({ rewrites: lines.map(([, i, text]) => ({ i: Number(i), text: REWRITES[text] ?? text })) }) }, finish_reason: 'stop' }] }
      }
      if (mode === 'throw') throw new Error('pick: transport dead')
      if (mode === 'noKey') return { choices: [{ message: { content: '{}' }, finish_reason: 'stop' }] }
      if (mode === 'outOfRange') return { choices: [{ message: { content: JSON.stringify({ pick: 99 }) }, finish_reason: 'stop' }] }
      if (mode === 'garbage') return { choices: [{ message: { content: 'not json at all' }, finish_reason: 'stop' }] }
      return { choices: [{ message: { content: JSON.stringify({ pick: 1 }) }, finish_reason: 'stop' }] }
    } } } } as never
  }

  it('ADDITIVE: MISMATCHES: 0 across 6 designs x pool sizes 2-6 x 6 chooser-failure modes (mirrors phase-q1-rulings.md acceptance line 1)', async () => {
    const mismatches: { design: string; size: number; mode: string }[] = []
    for (const d of fixture.designs) {
      for (let size = 2; size <= 6; size++) {
        const pool = d.pool.slice(0, size)
        const truthCtx: PhraseTruthCtx = {
          garmentFamily: fixture.blank.garmentFamily as 'sweatshirt',
          spec: { material: fixture.blank.material, fit: fixture.blank.fit, unisex: fixture.blank.unisex, neck: (fixture.blank as never as Record<string, unknown>).neck, sleeve: (fixture.blank as never as Record<string, unknown>).sleeve } as never,
          allowedBrand: fixture.blank.brandInCopy ? fixture.blank.brand : null, audience: 'adult', field: 'highlights',
          audienceLean: leanFor(d.designKey), designTokens: [d.designName],
        } as PhraseTruthCtx
        const composed = { candidates: pool, specFacts: SPEC_FACTS, brandPick: null, wearFact: null } as never
        const runTail = (line: string) => runIhTail(line, { titles: [titleFor(d.designName)], blankBrand: null, truthCtx, capacityFamily: false, site: 'q1-additive-sweep' })
        delete process.env.IH_HUMANIZER
        const off = await runWriterForDesign({ composed, fallbackHold: 'under-floor-no-repeat', designName: d.designName, truthCtx, runTail, deps: { openai: client('ok1', false) } })
        for (const mode of ['throw', 'noKey', 'outOfRange', 'garbage', 'ok1'] as const) {
          process.env.IH_HUMANIZER = 'on'
          const r = await runWriterForDesign({ composed, fallbackHold: 'under-floor-no-repeat', designName: d.designName, truthCtx, runTail, deps: { openai: client(mode, true) } })
          if (r.value !== off.value) mismatches.push({ design: d.designKey, size, mode })
        }
        process.env.IH_HUMANIZER = 'on'
        const rd = await runWriterForDesign({ composed, fallbackHold: 'under-floor-no-repeat', designName: d.designName, truthCtx, runTail, deps: { openai: client('ok1', true) }, deadlineAt: Date.now() + 40 })
        if (rd.value !== off.value) mismatches.push({ design: d.designKey, size, mode: 'deadline' })
        delete process.env.IH_HUMANIZER
      }
    }
    expect(mismatches, JSON.stringify(mismatches)).toEqual([])
  })

  it('REACHABLE: on BB and MHG at pool size 6, a BOUNDED search shows at least one candidate carrying an alternate — pass 2 got a real budget of its own', async () => {
    for (const key of ['BB', 'MHG']) {
      const d = fixture.designs.find((x) => x.designKey === key)!
      const truthCtx: PhraseTruthCtx = {
        garmentFamily: fixture.blank.garmentFamily as 'sweatshirt',
        spec: { material: fixture.blank.material, fit: fixture.blank.fit, unisex: fixture.blank.unisex, neck: (fixture.blank as never as Record<string, unknown>).neck, sleeve: (fixture.blank as never as Record<string, unknown>).sleeve } as never,
        allowedBrand: null, audience: 'adult', field: 'highlights', audienceLean: leanFor(d.designKey), designTokens: [d.designName],
      } as PhraseTruthCtx
      const composed = { candidates: d.pool, specFacts: SPEC_FACTS, brandPick: null, wearFact: null } as never
      const units = buildAdmittedUnits(composed, { designName: d.designName, truthCtx })
      process.env.IH_HUMANIZER = 'on'
      const humanized = await humanizeAdmittedUnits(units, { truthCtx, designName: d.designName, deps: { openai: client('ok1', true) } })
      const runTail = (line: string) => runIhTail(line, { titles: [titleFor(d.designName)], blankBrand: null, truthCtx, capacityFamily: false, site: 'q1-reach' })
      const en = enumerateWriterCandidates(humanized.units, { truthCtx, runTail })
      delete process.env.IH_HUMANIZER
      const altCarrying = en.candidates.filter((c) => c.usesAlternateSpelling > 0).length
      expect(en.bounded, `${key} bounded`).toBe(true)
      expect(altCarrying, `${key} candidates carrying an alt (evaluated=${en.evaluated})`).toBeGreaterThan(0)
      // P1's own guarantee, preserved: rank 1 (index 0) is NEVER the alt-carrying one.
      expect(en.candidates[0].usesAlternateSpelling).toBe(0)
    }
  })

  it("the fixture's OWN eligible pool is the family's real 6-phrase pool (sanity — this test is not measuring a toy pool)", () => {
    const bb = fixture.designs.find((d) => d.designKey === 'BB')!
    expect(bb.pool.length).toBe(6)
  })
})
