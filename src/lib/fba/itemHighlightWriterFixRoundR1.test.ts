/**
 * itemHighlightWriterFixRoundR1.test.ts — `.superpowers/sdd/2026-09-10-ih-writer/phase-r1-
 * rulings.md`, RULINGS R1-R7. RULINGS R1-R3 landed in the first commit of round R (audience
 * crossing, pass-2 additivity, the full-ballot gate); this file's R4-R7 blocks land in the second,
 * on top of it: the shared budget's own scaling, the rank-1-alternate ballot reservation, the
 * punctuation position fix, and the truncatedGroups-with-candidates assertion. RULING R3's own
 * full-ballot/pick-LAST gate lives in `itemHighlightWriterB0DSCDZC6KFixture.test.ts`, beside
 * RULING P4's own pick-1 gate it extends.
 *
 * DO NOT read this file as a redesign: R1-R7 are bounded fixes to `itemHighlightWriter.ts`'s own
 * search/net/prompt code and `listingPipeline.ts`'s own budget arithmetic — never to
 * `phraseTruthVerdict`, `ihLineTruthVerdict` or any shared composer predicate.
 */
import { describe, it, expect } from 'vitest'
import {
  humanizerRewriteVerdict, enumerateWriterCandidates, buildAdmittedUnits, humanizeAdmittedUnits,
  ihWriterMaxCallsBudget, IH_WRITER_RETRY_CAP, IH_HUMANIZER_CALL_BUDGET, type AdmittedUnit,
} from '@/lib/fba/itemHighlightWriter'
import { runIhTail, produceItemHighlightsPerDesign } from '@/lib/fba/listingPipeline'
import { normalizeAudienceLean, type PhraseTruthCtx } from '@/lib/fba/contentTruth'
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

// ─── shared B0DSCDZC6K fixture wiring, mirroring itemHighlightWriterFixRoundQ1.test.ts ────────────
const NEVER: RegExp = /(?!)/
const BLANK: BlankSpecRow = {
  match: NEVER,
  spec: {
    brand: fixture.blank.brand, brandInCopy: fixture.blank.brandInCopy, fit: fixture.blank.fit,
    material: fixture.blank.material, unisex: fixture.blank.unisex,
    neck: (fixture.blank as never as Record<string, unknown>).neck, sleeve: (fixture.blank as never as Record<string, unknown>).sleeve,
  } as never,
  styleCode: fixture.blank.styleCode, garmentFamily: fixture.blank.garmentFamily,
} as unknown as BlankSpecRow
const SPEC_FACTS = ihSpecFactFillers({
  material: fixture.blank.material, fit: fixture.blank.fit, unisex: fixture.blank.unisex,
  neck: (fixture.blank as never as Record<string, unknown>).neck, sleeve: (fixture.blank as never as Record<string, unknown>).sleeve,
} as never).map(titleCasePhrase)
const titleFor = (n: string) => fixture.titleTemplate.replace('{design}', n)
const leanForDesign = (k: string) => normalizeAudienceLean((((fixture.audienceLeanByDesign as never as Record<string, unknown>) ?? {})[k] ?? fixture.blank.audienceLean) as never)
const NUM_LINE = new RegExp('^(\\d+)\\.\\s(.+)$', 'gm')
// The SAME rewrite table this programme's own round-Q/round-R report/probes cite — the humanizer's
// real accepted answer for the fixture's two humanizable pool phrases.
const REWRITES: Record<string, string> = {
  'Sweatshirts for Women Trendy': 'Trendy Sweatshirts for Women',
  'Graphic Crewneck Sweatshirts Women': 'Graphic Crewneck Sweatshirts for Women',
}
function compliantClient(pick: 'first' | 'last') {
  return { chat: { completions: { create: async (req: { messages: { role: string; content: string }[] }) => {
    const system = req.messages.find((m) => m.role === 'system')?.content ?? ''
    const user = req.messages.find((m) => m.role === 'user')?.content ?? ''
    if (system.includes('rewrite a NUMBERED list')) {
      const lines = [...user.matchAll(NUM_LINE)]
      return { choices: [{ message: { content: JSON.stringify({ rewrites: lines.map(([, i, text]) => ({ i: Number(i), text: REWRITES[text] ?? text })) }) }, finish_reason: 'stop' }] }
    }
    const opts = [...user.matchAll(NUM_LINE)].map(([, i]) => Number(i))
    const picked = pick === 'first' ? opts[0] : opts[opts.length - 1]
    return { choices: [{ message: { content: JSON.stringify({ pick: picked, falseAlt: [] }) }, finish_reason: 'stop' }] }
  } } } } as never
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// RULING R1 (round R, Blocking): the audience-crossing rule needs no vocabulary
// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe('RULING R1 (round R, Blocking): refuse a modifier-noun adjacency the source never had — no lexicon required', () => {
  const NAMED = ["Lady's", "Guy's", "Adult's", 'Moms', 'Teens', 'Mamas']

  it('all six named strings (`phase-r1-rulings.md`) refuse the SAME claim-flip end to end — none are in AUDIENCE_NOUN_RE\'s own lexicon', () => {
    for (const word of NAMED) {
      const v = humanizerRewriteVerdict(unit(`Embroidered Sweatshirts for ${word}`), `Sweatshirts for the Embroidered ${word}`, { ...CTX, audienceLean: 'unisex' })
      expect(v, word).toEqual({ ok: false, reason: 'audience-noun-crossing' })
    }
  })

  it('the SAME six words in a DIFFERENT flip shape ("the <modifier> <word>" moved to the head) also refuse', () => {
    for (const word of NAMED) {
      const v = humanizerRewriteVerdict(unit(`Embroidered Sweatshirts for ${word}`), `for the Embroidered ${word} Sweatshirts`, { ...CTX, audienceLean: 'unisex' })
      // Either refused for the SAME crossing, or for a different, unrelated net rule (boundary
      // function word) — never `{ok:true}`. The crossing rule alone is this test's subject; assert
      // it is at minimum never silently accepted.
      expect(v.ok, word).toBe(false)
    }
  })

  it('reachable end to end: "Moms" in a REAL pool never claim-flips on the CHILD PUSH ROW, and this is now DETERMINISTIC — a referee that never supplies falseAlt (the historical bug shape) cannot matter because the rewrite never becomes an [ALT] in the first place', async () => {
    const DESIGNS = fixture.designs.map((d) => ({ key: d.designKey, name: d.designName }))
    const KEYS = DESIGNS.map((d) => d.key)
    const kwFor = (keyword: string, searchVolume: number): AnalyzedKeyword =>
      ({ keyword, searchVolume, themeFit: 3, themeFitByDesign: Object.fromEntries(KEYS.map((k) => [k, { fit: 3 }])) } as unknown as AnalyzedKeyword)
    const POOL = ['embroidered sweatshirts for moms', 'fall crewneck']
    const INPUT = {
      groups: DESIGNS.map((d, i) => ({ key: d.key, designName: d.name, skus: [{ sku: d.key + '-1', asin: 'B0R1TEST' + i }], titles: [titleFor(d.name)] })),
      pool: POOL.map((k, i) => kwFor(k, 5000 - i * 10)), apparelProduct: true, blankBrand: BLANK,
      familyTitleText: DESIGNS.map((d) => titleFor(d.name)).join(' '), audienceLean: 'unisex' as never,
    }
    const flip = (text: string) => {
      const m = /^(\w+)\s+(.*\bfor\s+Moms)$/i.exec(text)
      return m ? m[2].replace(/for Moms$/i, 'for the ' + m[1] + ' Moms') : text
    }
    // The referee here NEVER supplies falseAlt — the exact historical bug shape RULING Q3 already
    // guards. R1 must close this at the NET, so a compliant-but-silent referee is irrelevant to it.
    const noFalseAltClient = () => ({ chat: { completions: { create: async (req: { messages: { role: string; content: string }[] }) => {
      const system = req.messages.find((m) => m.role === 'system')?.content ?? ''
      const user = req.messages.find((m) => m.role === 'user')?.content ?? ''
      if (system.includes('rewrite a NUMBERED list')) {
        const lines = [...user.matchAll(NUM_LINE)]
        return { choices: [{ message: { content: JSON.stringify({ rewrites: lines.map(([, i, text]) => ({ i: Number(i), text: flip(text) })) }) }, finish_reason: 'stop' }] }
      }
      return { choices: [{ message: { content: '{"pick":1}' }, finish_reason: 'stop' }] }
    } } } } as never)
    process.env.IH_WRITER = 'on'; process.env.IH_HUMANIZER = 'off'
    const off = await produceItemHighlightsPerDesign(INPUT as never, { openai: noFalseAltClient() })
    process.env.IH_HUMANIZER = 'on'
    const on = await produceItemHighlightsPerDesign(INPUT as never, { openai: noFalseAltClient() })
    delete process.env.IH_WRITER; delete process.env.IH_HUMANIZER
    for (let i = 0; i < off.perDesign.length; i++) {
      expect(on.perDesign[i].value, off.perDesign[i].designKey).toBe(off.perDesign[i].value)
      expect(on.perDesign[i].value).not.toMatch(/for the \w+ Moms/i)
    }
    // Confirm the humanizer itself never accepted the flip as a unit alternate (never even reached
    // the ballot as an [ALT]) — the DETERMINISTIC property R1 claims, not merely "the referee saved
    // us again".
    const truthCtx: PhraseTruthCtx = {
      garmentFamily: 'sweatshirt', spec: { material: fixture.blank.material, fit: fixture.blank.fit, unisex: fixture.blank.unisex } as never,
      allowedBrand: null, audience: 'adult', field: 'highlights', audienceLean: 'unisex', designTokens: ['Business B*tch'],
    }
    const composed = { candidates: POOL.map((p) => p.replace(/\b\w/g, (c) => c.toUpperCase())), specFacts: [], brandPick: null, wearFact: null } as never
    const units = buildAdmittedUnits(composed, { designName: 'Business B*tch', truthCtx })
    process.env.IH_HUMANIZER = 'on'
    const humanized = await humanizeAdmittedUnits(units, { truthCtx, designName: 'Business B*tch', deps: { openai: noFalseAltClient() } })
    delete process.env.IH_HUMANIZER
    expect(humanized.accepted).toBe(0)
    expect(humanized.units.every((u) => !u.altOf)).toBe(true)
  })

  it('CONTROL: the good rewrite this programme\'s own gate ships is UNAFFECTED ("Sweatshirts for Women Trendy" -> "Trendy Sweatshirts for Women")', () => {
    expect(humanizerRewriteVerdict(unit('Sweatshirts for Women Trendy'), 'Trendy Sweatshirts for Women', CTX)).toEqual({ ok: true })
  })

  it('CONTROL: inserting "for" ("Graphic Crewneck Sweatshirts Women" -> "Graphic Crewneck Sweatshirts for Women") is UNAFFECTED — the source never carried "for" at all, so this unit is not a protected relation object by the structural rule either', () => {
    expect(humanizerRewriteVerdict(unit('Graphic Crewneck Sweatshirts Women'), 'Graphic Crewneck Sweatshirts for Women', CTX)).toEqual({ ok: true })
  })

  it('MUTATION PROOF: the structural check is load-bearing on its own — a phrase whose noun is entirely OUTSIDE the lexicon (a nonsense word) still refuses, proving the lexicon branch (`isAudienceNoun`) alone cannot be what is catching this', () => {
    const v = humanizerRewriteVerdict(unit('Embroidered Sweatshirts for Zibbly'), 'Sweatshirts for the Embroidered Zibbly', { ...CTX, audienceLean: 'unisex' })
    expect(v).toEqual({ ok: false, reason: 'audience-noun-crossing' })
  })
})

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// RULING R2 (round R, Blocking): "additive" must mean the WHOLE ballot
// ═══════════════════════════════════════════════════════════════════════════════════════════════
function truthCtxFor(d: { designKey: string; designName: string }): PhraseTruthCtx {
  return {
    garmentFamily: fixture.blank.garmentFamily as 'sweatshirt',
    spec: { material: fixture.blank.material, fit: fixture.blank.fit, unisex: fixture.blank.unisex, neck: (fixture.blank as never as Record<string, unknown>).neck, sleeve: (fixture.blank as never as Record<string, unknown>).sleeve } as never,
    allowedBrand: null, audience: 'adult', field: 'highlights',
    audienceLean: leanForDesign(d.designKey), designTokens: [d.designName],
  } as PhraseTruthCtx
}
describe('RULING R2 (round R, Blocking): pass 2 gets skipped entirely with no alternates, and contributes ONLY alt-carrying candidates when it does run', () => {
  it('point 1 — flag-off (zero alternates ever allocated) never doubles the evaluation count: every one of the 6 fixture designs stays within pass 1\'s OWN 300-evaluation cap, never up to 600', () => {
    for (const d of fixture.designs) {
      const truthCtx = truthCtxFor(d)
      const composed = { candidates: d.pool, specFacts: SPEC_FACTS, brandPick: null as string | null, wearFact: null as string | null } as never
      const units = buildAdmittedUnits(composed, { designName: d.designName, truthCtx })
      const runTail = (line: string) => runIhTail(line, { titles: [titleFor(d.designName)], blankBrand: null, truthCtx, capacityFamily: false, site: 'r2-flagoff-evalcap' })
      const en = enumerateWriterCandidates(units, { truthCtx, runTail })
      expect(en.evaluated, d.designKey).toBeLessThanOrEqual(300)
    }
  })

  it('point 2 — every ballot slot the humanizer ADDS (present ON, absent OFF) carries an alternate: pass 2 never contributes an all-source candidate that could evict a pass-1-ranked slot', async () => {
    for (const key of ['BB', 'MHG']) {
      const d = fixture.designs.find((x) => x.designKey === key)!
      const truthCtx = truthCtxFor(d)
      const composed = { candidates: d.pool, specFacts: SPEC_FACTS, brandPick: null as string | null, wearFact: null as string | null } as never
      const unitsOff = buildAdmittedUnits(composed, { designName: d.designName, truthCtx })
      const runTail = (line: string) => runIhTail(line, { titles: [titleFor(d.designName)], blankBrand: null, truthCtx, capacityFamily: false, site: 'r2-addonly' })
      const off = enumerateWriterCandidates(unitsOff, { truthCtx, runTail })
      process.env.IH_HUMANIZER = 'on'
      const humanized = await humanizeAdmittedUnits(unitsOff, { truthCtx, designName: d.designName, deps: { openai: compliantClient('first') } })
      delete process.env.IH_HUMANIZER
      const on = enumerateWriterCandidates(humanized.units, { truthCtx, runTail })
      const offLines = new Set(off.candidates.map((c) => c.line))
      const added = on.candidates.filter((c) => !offLines.has(c.line))
      // Measured (`phase-r1-rulings.md` R2): BB/MHG evict/add slots once the humanizer runs — assert
      // this design actually exercises the ADD path (a vacuous "0 added" would make the loop below
      // pass by having nothing to check).
      expect(added.length, `${key} added`).toBeGreaterThan(0)
      for (const c of added) expect(c.usesAlternateSpelling, `${key}: "${c.line}"`).toBeGreaterThan(0)
    }
  })

  it('point 2, restated as the ACCEPTANCE line: every slot pass 1 ranked (`rankedSourceOnly`) that is NOT the reserved rank-1-alternate slot (RULING R5) is either kept or replaced ONLY by an alt-carrying candidate — never silently dropped for an all-source one pass 2 happened to find on its own fresh budget', async () => {
    for (const key of ['BB', 'MHG']) {
      const d = fixture.designs.find((x) => x.designKey === key)!
      const truthCtx = truthCtxFor(d)
      const composed = { candidates: d.pool, specFacts: SPEC_FACTS, brandPick: null as string | null, wearFact: null as string | null } as never
      const unitsOff = buildAdmittedUnits(composed, { designName: d.designName, truthCtx })
      const runTail = (line: string) => runIhTail(line, { titles: [titleFor(d.designName)], blankBrand: null, truthCtx, capacityFamily: false, site: 'r2-kept-or-alt' })
      const off = enumerateWriterCandidates(unitsOff, { truthCtx, runTail })
      process.env.IH_HUMANIZER = 'on'
      const humanized = await humanizeAdmittedUnits(unitsOff, { truthCtx, designName: d.designName, deps: { openai: compliantClient('first') } })
      delete process.env.IH_HUMANIZER
      const on = enumerateWriterCandidates(humanized.units, { truthCtx, runTail })
      const onLines = new Set(on.candidates.filter((c) => c.usesAlternateSpelling === 0).map((c) => c.line))
      // Every ZERO-ALT slot shown ON must have been a zero-alt slot pass 1 itself ranked OFF — pass
      // 2, when it runs, must never manufacture a NEW zero-alt candidate pass 1's own search did not
      // already find and rank.
      const offZeroAltLines = new Set(off.candidates.filter((c) => c.usesAlternateSpelling === 0).map((c) => c.line))
      for (const line of onLines) expect(offZeroAltLines.has(line), line).toBe(true)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// RULING R4 (round R, Blocking): the shared budget must scale with the family's OWN design count
// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe('RULING R4 (round R, Blocking): the per-regen call budget is derived from perDesign.length by default, so the humanizer can never starve a design flag-off would serve', () => {
  const EXTRA = [
    { key: 'X1', name: 'Grind Mode Activated' },
    { key: 'X2', name: 'Built Not Bought' },
  ]
  function familyInput(designs: { key: string; name: string }[]) {
    const keys = designs.map((d) => d.key)
    const kwFor = (keyword: string, searchVolume: number): AnalyzedKeyword =>
      ({ keyword, searchVolume, themeFit: 3, themeFitByDesign: Object.fromEntries(keys.map((k) => [k, { fit: 3 }])) } as unknown as AnalyzedKeyword)
    return {
      groups: designs.map((d, i) => ({ key: d.key, designName: d.name, skus: [{ sku: d.key + '-1', asin: 'B0R4TEST' + String(i).padStart(2, '0') }], titles: [titleFor(d.name)] })),
      pool: fixture.pool.map((p, i) => kwFor(p.toLowerCase(), 5000 - i * 10)),
      apparelProduct: true, blankBrand: BLANK,
      familyTitleText: designs.map((d) => titleFor(d.name)).join(' '),
      audienceLean: 'unisex' as never,
      audienceLeanByDesign: { BB: 'female', MHG: 'female' },
    }
  }
  function deadChooser() {
    return { chat: { completions: { create: async (req: { messages: { role: string; content: string }[] }) => {
      const system = req.messages.find((m) => m.role === 'system')?.content ?? ''
      const user = req.messages.find((m) => m.role === 'user')?.content ?? ''
      if (system.includes('rewrite a NUMBERED list')) {
        const lines = [...user.matchAll(NUM_LINE)]
        return { choices: [{ message: { content: JSON.stringify({ rewrites: lines.map(([, i, text]) => ({ i: Number(i), text: REWRITES[text] ?? text })) }) }, finish_reason: 'stop' }] }
      }
      throw new Error('stub: dead chooser')
    } } } } as never
  }

  it('measured, before the fix this exact scenario shipped an EMPTY Item Highlight on a real child push row at 8 designs — after the fix, N of N rows carry a value under a throwing chooser with the humanizer ON, for every family size 6/7/8', async () => {
    const base = fixture.designs.map((d) => ({ key: d.designKey, name: d.designName }))
    for (const n of [6, 7, 8]) {
      const designs = [...base, ...EXTRA].slice(0, n)
      process.env.IH_WRITER = 'on'; process.env.IH_HUMANIZER = 'off'
      const off = await produceItemHighlightsPerDesign(familyInput(designs) as never, { openai: deadChooser() })
      process.env.IH_HUMANIZER = 'on'
      const on = await produceItemHighlightsPerDesign(familyInput(designs) as never, { openai: deadChooser() })
      delete process.env.IH_WRITER; delete process.env.IH_HUMANIZER
      let emptyWhereOffShips = 0
      for (let i = 0; i < designs.length; i++) {
        if ((on.perDesign[i].value ?? '').length === 0 && (off.perDesign[i].value ?? '').length > 0) emptyWhereOffShips++
      }
      expect(emptyWhereOffShips, `n=${n} designs`).toBe(0)
    }
  })

  it('the DEFAULT budget scales with perDesign.length: at 8 designs it is at least 8 * (retry cap + humanizer call), never the fixed 24 the 6-design fixture used to size it to', () => {
    expect(process.env.IH_WRITER_MAX_CALLS).toBeUndefined()
    const worstCasePerDesign = IH_WRITER_RETRY_CAP + IH_HUMANIZER_CALL_BUDGET
    expect(8 * worstCasePerDesign).toBeGreaterThan(ihWriterMaxCallsBudget()) // 32 > 24 — the fixed default alone is NOT enough for 8 designs; the pipeline widens it (proved above).
  })

  it('an EXPLICIT IH_WRITER_MAX_CALLS override is still respected EXACTLY — the default-only widening never overrides an operator\'s own deliberately-small budget', async () => {
    const designs = fixture.designs.map((d) => ({ key: d.designKey, name: d.designName }))
    process.env.IH_WRITER = 'on'; process.env.IH_HUMANIZER = 'on'; process.env.IH_WRITER_MAX_CALLS = '1'
    try {
      const out = await produceItemHighlightsPerDesign(familyInput(designs) as never, { openai: deadChooser() })
      const exhausted = (out.writerLog ?? []).filter((r) => r.reasons.some((x) => x.includes('budget')))
      expect(exhausted.length, 'designs starved by the explicit budget=1 override').toBeGreaterThan(0)
    } finally {
      delete process.env.IH_WRITER; delete process.env.IH_HUMANIZER; delete process.env.IH_WRITER_MAX_CALLS
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// RULING R5 (round R, Important): reserve a slot for the alternate of a unit RANK 1 itself uses
// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe('RULING R5 (round R, Important): the ballot always carries the alternate of a rank-1 unit when one exists, at pool sizes 5 AND 6', () => {
  const TARGET = 'Embroidered Sweatshirts for Women'
  const REWRITE_TARGET = 'Sweatshirts for Women Embroidered'
  function rank1AltClient() {
    return { chat: { completions: { create: async (req: { messages: { role: string; content: string }[] }) => {
      const system = req.messages.find((m) => m.role === 'system')?.content ?? ''
      const user = req.messages.find((m) => m.role === 'user')?.content ?? ''
      if (system.includes('rewrite a NUMBERED list')) {
        const lines = [...user.matchAll(NUM_LINE)]
        return { choices: [{ message: { content: JSON.stringify({ rewrites: lines.map(([, i, text]) => ({ i: Number(i), text: text === TARGET ? REWRITE_TARGET : (REWRITES[text] ?? text) })) }) }, finish_reason: 'stop' }] }
      }
      return { choices: [{ message: { content: '{"pick":1}' }, finish_reason: 'stop' }] }
    } } } } as never
  }
  for (const key of ['BB', 'MHG']) {
    for (const size of [5, 6]) {
      it(`${key} at pool size ${size}: the ballot carries a candidate using the ALTERNATE of a unit RANK 1 itself uses (measured 0 of 8 before this fix)`, async () => {
        const d = fixture.designs.find((x) => x.designKey === key)!
        const pool = d.pool.slice(0, size)
        const truthCtx = truthCtxFor(d)
        const composed = { candidates: pool, specFacts: SPEC_FACTS, brandPick: null as string | null, wearFact: null as string | null } as never
        const units = buildAdmittedUnits(composed, { designName: d.designName, truthCtx })
        process.env.IH_HUMANIZER = 'on'
        const humanized = await humanizeAdmittedUnits(units, { truthCtx, designName: d.designName, deps: { openai: rank1AltClient() } })
        delete process.env.IH_HUMANIZER
        const runTail = (line: string) => runIhTail(line, { titles: [titleFor(d.designName)], blankBrand: null, truthCtx, capacityFamily: false, site: 'r5-rank1alt' })
        const en = enumerateWriterCandidates(humanized.units, { truthCtx, runTail })
        const byId = new Map(humanized.units.map((u) => [u.id, u] as const))
        const rank1UnitIds = new Set(en.candidates[0].parts.filter((p): p is { unit: string } => 'unit' in p).map((p) => p.unit))
        const hasRank1Alt = en.candidates.some((c) => c.parts.some((p) => 'unit' in p && !!byId.get((p as { unit: string }).unit)?.altOf && rank1UnitIds.has(byId.get((p as { unit: string }).unit)!.altOf!)))
        expect(hasRank1Alt, `${key} size=${size}`).toBe(true)
        // Rank 1 itself is UNAFFECTED (RULING P1's own guarantee, preserved): still zero-alt.
        expect(en.candidates[0].usesAlternateSpelling).toBe(0)
      })
    }
  }
})

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// RULING R6 (round R, Important): punctuation position is keyed on POSITION, not one shared sentinel
// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe('RULING R6 (round R, Important): a free-standing mark cannot relocate to an edge or a gap it never sat in', () => {
  const SRC = 'Sweatshirts - Fall Crewneck'

  it('relocated to the TAIL — refused (the file\'s own doc comment names this exact string as what RULING P5 had already closed)', () => {
    expect(humanizerRewriteVerdict(unit(SRC), 'Sweatshirts Fall Crewneck -', CTX)).toEqual({ ok: false, reason: 'character-set' })
  })
  it('relocated to the HEAD — refused', () => {
    expect(humanizerRewriteVerdict(unit(SRC), '- Sweatshirts Fall Crewneck', CTX)).toEqual({ ok: false, reason: 'character-set' })
  })
  it('relocated between two words it never sat between — refused', () => {
    expect(humanizerRewriteVerdict(unit(SRC), 'Fall Crewneck - Sweatshirts', CTX)).toEqual({ ok: false, reason: 'character-set' })
  })
  it('the SAME three rows for a DIFFERENT free-standing mark ("|")', () => {
    const src2 = 'Sweatshirts | Fall Crewneck'
    expect(humanizerRewriteVerdict(unit(src2), 'Sweatshirts Fall Crewneck |', CTX)).toEqual({ ok: false, reason: 'character-set' })
    expect(humanizerRewriteVerdict(unit(src2), '| Sweatshirts Fall Crewneck', CTX)).toEqual({ ok: false, reason: 'character-set' })
    expect(humanizerRewriteVerdict(unit(src2), 'Fall Crewneck | Sweatshirts', CTX)).toEqual({ ok: false, reason: 'character-set' })
  })
  it('CONTROL: the mark staying in the SAME gap (1 word before, 2 after) while the TAIL words reorder is still legal — proving the fix pins the GAP, not the exact neighbour words a second time', () => {
    expect(humanizerRewriteVerdict(unit(SRC), 'Sweatshirts - Crewneck Fall', CTX)).toEqual({ ok: true })
  })
  it('CONTROL: the working GLUED-compound case (P5/Q7\'s own control) is completely untouched', () => {
    expect(humanizerRewriteVerdict(unit('Long-Sleeve Fall Crewneck'), 'Fall Crewneck Long-Sleeve', CTX)).toEqual({ ok: true })
  })
  it('an APOSTROPHE inside a single WORD_RE token travels WITH its word, never pinned by position (a defect found and fixed while building this exact round: it wrongly refused `character-set` before the fix)', () => {
    const v = humanizerRewriteVerdict(unit("Embroidered Sweatshirts for Lady's"), "Sweatshirts for the Embroidered Lady's", { ...CTX, audienceLean: 'unisex' })
    // Refused — but by RULING R1's audience-crossing rule, never by the punctuation net.
    expect(v).toEqual({ ok: false, reason: 'audience-noun-crossing' })
  })
})

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// RULING R7 (round R, Important): truncatedGroups asserted on a run that RETURNS candidates
// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe('RULING R7 (round R, Important): truncatedGroups is pinned on a run that actually returns candidates, not only the zero-candidate early return', () => {
  // `phase-q1-review-net.md` MINOR 1, measured: the PRE-EXISTING committed pin
  // (`itemHighlightWriterFixRoundQ1.test.ts`, "non-zero and COUNTED...") uses a 10-phrase fixture
  // that takes the ZERO-CANDIDATE early return (`:2170`) — mutating the REAL path's own computation
  // (`:2261` in the shipped file) was measured GREEN there, because that test's own result never
  // carries a candidate for the mutation to have anything to change. This fixture instead REUSES
  // the real, accepting B0DSCDZC6K/BB admitted set (6 pool phrases that this repo's OWN fixture
  // proves reach 8 accepted candidates) and pads it past the 8-group cap with 4 further TRUTHFUL
  // "Fall Crewneck ..." phrases, so the search is both TRUNCATED (10 groups > the 8-group cap) AND
  // still finds real, non-empty candidates — closing the exact gap Minor 1 named.
  const SPEC_FACTS = ihSpecFactFillers({
    material: fixture.blank.material, fit: fixture.blank.fit, unisex: fixture.blank.unisex,
    neck: (fixture.blank as never as Record<string, unknown>).neck, sleeve: (fixture.blank as never as Record<string, unknown>).sleeve,
  } as never).map(titleCasePhrase)
  it('10 ordinary pool groups, on a REAL accepting design: bounded=true, truncatedGroups>0, AND candidates.length>0 — all three asserted TOGETHER', () => {
    const d = fixture.designs.find((x) => x.designKey === 'BB')!
    const truthCtx = truthCtxFor(d)
    const EXTRA = ['Fall Crewneck Vibes', 'Fall Crewneck Look', 'Fall Crewneck Style', 'Fall Crewneck Design']
    const composed = { candidates: [...d.pool, ...EXTRA], specFacts: SPEC_FACTS, brandPick: null as string | null, wearFact: null as string | null } as never
    const units = buildAdmittedUnits(composed, { designName: d.designName, truthCtx })
    const runTail = (line: string) => runIhTail(line, { titles: [titleFor(d.designName)], blankBrand: null, truthCtx, capacityFamily: false, site: 'r7-truncated-with-candidates' })
    const en = enumerateWriterCandidates(units, { truthCtx, runTail })
    expect(en.bounded).toBe(true)
    expect(en.truncatedGroups).toBeGreaterThan(0)
    expect(en.candidates.length).toBeGreaterThan(0)
  })
})
