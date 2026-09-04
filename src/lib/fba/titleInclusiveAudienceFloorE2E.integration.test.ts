/**
 * titleInclusiveAudienceFloorE2E.integration.test.ts — END-TO-END PROOF for the 2026-09-04 PO
 * ruling on B0DSCDZC6K, driving the REAL `runListingPipeline()` (never an isolated net), same
 * discipline `titleMaterialAndSleeveE2E.integration.test.ts` (PR #664) used.
 *
 * THE LIVE REGRESSION (measured from the DB 2026-09-04, after PR #664 revoked material from
 * titles): family B0DSCDZC6K, `audience_lean='unisex'`, ship floor derives to TITLE_SHIP_FLOOR()
 * (68). Four of six designs shipped BELOW it — "Hustle Definiton" (58), "Don't Quit" (61),
 * "Business B*tch" (65), "Mother Hustler" (65) — because removing material took ~17 characters
 * and, on the four SHORT design names, nothing true replaced them.
 *
 * WHY PR #664's OWN E2E TEST (all six 70-75) DISAGREED WITH LIVE — TWO INDEPENDENT causes, both
 * reproduced/eliminated here (verified empirically, not assumed — see the file history in the PR
 * this test ships with for the RED/GREEN trace):
 *   1. Its `makePool()` fixture was FOUR hand-picked, perfectly on-theme, perfectly ungendered
 *      keywords ('motivational entrepreneur sweatshirt', 'graphic sweatshirts for men', 'hustle
 *      mindset gift', 'boss lady sweatshirt') — a pool that trivially supplies fill for every
 *      design. The REAL B0DSCDZC6K pool is 69 keywords DOMINATED BY WOMEN'S-ONLY PHRASES, which
 *      the unisex truth net (`phraseTruthVerdict`'s `audience-lean-lie` rule) correctly rejects on
 *      a `unisex` family. THIS FIXTURE's pool (below) reproduces that shape and deliberately
 *      carries NO admissible generic residual (no "gift"-style phrase at all — a harsher pool than
 *      the real one might be, so this test cannot pass by accident on pool material Fix 1 never
 *      touches): a large majority of keywords are single-gender ("...for Women"/"Womens...") and
 *      get vetoed; the rest are on-theme but carry the WRONG GARMENT NOUN for a sweatshirt family
 *      (e.g. "funny work shirts", CORE-ranked, `themeFit=3` — the real pool's own CORE #5) and get
 *      vetoed for THAT reason instead. With this pool alone, the pad has ZERO market vocabulary to
 *      offer on ANY of the six designs — confirmed RED (see below).
 *   2. Its OpenAI stub returned a rich, generic plain-text title candidate for every design
 *      ("...Motivational Entrepreneur Graphic Sweatshirt for Everyone") that alone supplies most
 *      of the band gap regardless of the pool or the fix under test. This file's stub returns the
 *      minimal `'THE CEO Sweatshirt'` so the shipped length is driven by product FACTS (spec +
 *      family garment vocabulary) and the pool, not by incidental LLM-stub verbosity — the same
 *      class of fixture-mismatch, independently confirmed by reverting this file's own Fix-1
 *      changes and re-running: with BOTH corrections in place (harsh pool + minimal stub) but
 *      WITHOUT Fix 1, this file's own assertions go RED at HD=58/DQ=61/BB=65/MH=65, decision
 *      'refused-kept-prior' for all four — an EXACT byte-for-byte match to the brief's live
 *      2026-09-04 measurement, proving the fixture (not merely the assertions) reproduces live.
 *
 * FIX 1 — inclusive-audience vocabulary, TRUTH-CONDITIONED (PO ruling 2026-09-04, verbatim: "you
 * have Keywords From the Bank you Can Add - For Man And Wome[n]... Etc"), widened mid-flight to
 * the general USE-CASE/AUDIENCE/THEME vocabulary class (PO's second example: "Gift for Boss").
 * `titleBand.ts`'s `candidateSegments` now offers a CONSTRUCTED "for Men [and/&/ ]Women" fact when
 * `ctx.lean === 'unisex'` (a restatement of the family's own declared fact, not a market term), and
 * `listingPipeline.ts`'s `titleQualityJudge` no longer applies its corpus-frequency -15 dock to
 * that phrase on a `unisex` family. Product-fact vocabulary (material, banned by PR #664) is
 * UNTOUCHED — this is audience/theme vocabulary only.
 *
 * FIX 2 — the ship floor (`TITLE_SHIP_FLOOR()`, `settleTruthBand` in titleBand.ts) is asserted to
 * ACTUALLY hold on every shipped title: >= floor whenever true material allows it, and — this file
 * does not construct a scenario where it cannot, see titleFloorGateInvariants.test.ts for that —
 * never empty, never a lie.
 *
 * "PROVE THE BRANCH RAN": asserts on `TITLE_TRUTH_BAND`'s own `decision` value (via console spy),
 * never merely on the final string, so a passing assertion cannot be explained by an unrelated path.
 */
process.env.NEXT_PUBLIC_SUPABASE_URL = ''
process.env.SUPABASE_SERVICE_ROLE_KEY = ''
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = ''

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'

vi.mock('@/lib/fba/blankSpecs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/fba/blankSpecs')>()
  return { ...actual, loadBlankSpecRows: vi.fn(async () => [] as import('@/lib/fba/blankSpecs').BlankSpecRow[]) }
})

import { loadBlankSpecRows, type BlankSpecRow } from '@/lib/fba/blankSpecs'
import { runListingPipeline, type PipelineInput, type PipelineChild } from './listingPipeline'
import { TITLE_SHIP_FLOOR } from './titleBand'
import type { AnalyzedKeyword } from '../keyword-engine/engine'

const SUPABASE_ENV_KEYS = ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'NEXT_PUBLIC_SUPABASE_ANON_KEY'] as const
const savedSupabaseEnv: Record<string, string | undefined> = {}

beforeAll(() => {
  for (const key of SUPABASE_ENV_KEYS) { savedSupabaseEnv[key] = process.env[key]; delete process.env[key] }
})
afterAll(() => {
  for (const key of SUPABASE_ENV_KEYS) {
    if (savedSupabaseEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedSupabaseEnv[key]
  }
})

const mockedLoadBlankSpecRows = vi.mocked(loadBlankSpecRows)

// Byte-identical style to titleMaterialAndSleeveE2E.integration.test.ts's makeCatalog — the
// family's single dominant blank, Gildan 18000 heavyweight fleece sweatshirt.
function makeCatalog(): BlankSpecRow[] {
  return [
    { match: /\b1800(?:0)?(?=\D|$)|\b18000/i, styleCode: '18000', garmentFamily: 'sweatshirt',
      spec: { brand: 'Gildan', brandInCopy: false, fit: 'Classic', sleeve: 'Long Sleeve', neck: 'Crew Neck', weightNote: 'heavyweight 8.0 oz fleece', material: '50% Cotton / 50% Polyester' } },
  ]
}

/** The six real B0DSCDZC6K designs, live-measured 2026-09-04. */
const DESIGNS: { key: string; name: string }[] = [
  { key: 'HD', name: 'Hustle Definiton' },
  { key: 'DQ', name: "Don't Quit" },
  { key: 'BB', name: 'Business B*tch' },
  { key: 'MH', name: 'Mother Hustler' },
  { key: 'BCS', name: 'Billionare Coming Soon' },
  { key: 'ED', name: 'Entrepreneur Definition' },
]
/** The four that shipped below TITLE_SHIP_FLOOR() (68) on 2026-09-04, and their measured length. */
const REGRESSED_KEYS = new Set(['HD', 'DQ', 'BB', 'MH'])

function makeChildren(): PipelineChild[] {
  const out: PipelineChild[] = []
  for (const d of DESIGNS) {
    for (const size of ['S', 'M']) {
      out.push({ sku: `G18000${size}-BK-${d.key}-FBA`, asin: `B0DS${d.key}${size}`, color: 'Black', size })
    }
  }
  return out
}

const mk = (o: Partial<AnalyzedKeyword> & { keyword: string }): AnalyzedKeyword => ({
  coverageGapScore: 55, actionType: 'UPGRADE', actionText: '', rationale: '', urgency: 'medium',
  estimatedImpact: '', searchVolume: 2000, keywordSales: 0, competingProducts: 1000,
  asinImpressionShare: 0, asinClickShare: 0, asinPurchaseShare: 0,
  inTitle: false, inBullets: false, inDescription: false, inBackend: false,
  dataSource: 'jungle_scout', titleDensity: null, organicRank: null,
  ...o,
})

/**
 * THE LIVE 69-KEYWORD POOL, RECONSTRUCTED TO MATCH THE REAL SHAPE (not PR #664's 4-keyword
 * fiction). ~59 single-gender WOMEN'S phrases (rejected by the unisex truth net's
 * `audience-lean-lie` rule — the SAME rule that correctly vetoes "for Women" alone), ~8 on-theme
 * phrases that carry the WRONG GARMENT NOUN for a sweatshirt family ("shirts"/"tee" folds to the
 * 'tee' class — foreign to `classesForFamily('sweatshirt')` — vetoed by `wrong-garment-noun`,
 * including the real pool's own CORE #5 "funny work shirts", themeFit=3). DELIBERATELY ZERO
 * admissible generic-theme phrases ("gift" et al.) — this pool supplies NOTHING to the pad on
 * ANY of the six designs (confirmed by the RED run below), so a pass can only be explained by
 * FIX 1's constructed audience fact, never by pool material this fix does not touch. (A real
 * pool may well carry a "gift"-style residual too — this family's own broadcast title ends in
 * "Gift" — but this test does not need that vocabulary to prove Fix 1 lifts the four regressed
 * designs, and including it would have let the test pass without exercising the fix, exactly the
 * PR #664 mistake this file exists to not repeat.)
 */
function makePool(): AnalyzedKeyword[] {
  const womensBases = [
    'hustle sweatshirt for women', 'boss lady sweatshirt', 'womens motivational sweatshirt',
    'cute sweatshirt for women', 'crewneck sweatshirt for women', 'plus size sweatshirt for women',
    'womens pullover sweatshirt', 'ladies graphic sweatshirt', 'sweatshirt for women hustle',
    'womens boss sweatshirt', 'entrepreneur sweatshirt for women', 'womens crewneck pullover',
    'trendy sweatshirt for women', 'womens fall sweatshirt', 'sweatshirt for women mom',
    'girl boss sweatshirt', 'womens oversized sweatshirt', 'cozy sweatshirt for women',
    'sweatshirt for women gift', 'womens graphic pullover', 'ladies crewneck sweatshirt',
    'womens hustle culture sweatshirt', 'sweatshirt for women cute', 'womens quote sweatshirt',
    'sweatshirt for women fall', 'womens business sweatshirt', 'sweatshirt for women casual',
    'womens motivational pullover', 'sweatshirt for women trendy', 'ladies pullover sweatshirt',
    'sweatshirt for women warm', 'womens entrepreneur pullover', 'sweatshirt for women soft',
    'womens hustler sweatshirt', 'sweatshirt for women crewneck', 'ladies boss lady sweatshirt',
    'womens boss lady pullover', 'sweatshirt for women oversized', 'womens comfy sweatshirt',
    'sweatshirt for women comfy', 'womens graphic crewneck', 'sweatshirt for women graphic',
    'ladies motivational sweatshirt', 'womens quote pullover', 'sweatshirt for women quote',
    'womens hustle pullover', 'sweatshirt for women hustler', 'womens definition sweatshirt',
    'sweatshirt for women definition', 'ladies hustle sweatshirt', 'womens dont quit sweatshirt',
    'sweatshirt for women dont quit', 'womens mother sweatshirt', 'sweatshirt for women mother',
    'ladies entrepreneur sweatshirt', 'womens billionare sweatshirt', 'sweatshirt for women billionare',
    'womens coming soon sweatshirt', 'sweatshirt for women coming soon',
  ]
  const womens = womensBases.map((keyword) => mk({ keyword, searchVolume: 4000, coverageGapScore: 50, actionType: 'UPGRADE' }))

  // Wrong garment noun for a SWEATSHIRT family (folds to the 'tee' class) — CORE #5 is the real
  // pool's own actual top-ranked theme phrase, themeFit=3.
  const wrongNoun = [
    mk({ keyword: 'funny work shirts', searchVolume: 18000, coverageGapScore: 90, actionType: 'CRITICAL', themeFit: 3 }),
    mk({ keyword: 'motivational graphic tee', searchVolume: 9000, coverageGapScore: 70, actionType: 'UPGRADE', themeFit: 2 }),
    mk({ keyword: 'hustle tshirt', searchVolume: 7000, coverageGapScore: 65, actionType: 'UPGRADE', themeFit: 2 }),
    mk({ keyword: 'boss lady shirt', searchVolume: 6000, coverageGapScore: 60, actionType: 'UPGRADE', themeFit: 2 }),
    mk({ keyword: 'graphic tee for women', searchVolume: 5500, coverageGapScore: 58, actionType: 'UPGRADE', themeFit: 1 }),
    mk({ keyword: 'entrepreneur tee', searchVolume: 4500, coverageGapScore: 55, actionType: 'UPGRADE', themeFit: 2 }),
    mk({ keyword: "dont quit shirt", searchVolume: 4000, coverageGapScore: 52, actionType: 'UPGRADE', themeFit: 2 }),
    mk({ keyword: 'mother hustler tee', searchVolume: 3500, coverageGapScore: 50, actionType: 'UPGRADE', themeFit: 2 }),
  ]

  // NO ungendered, right-noun, generic theme phrase in this pool (measured live: 69 keywords,
  // women's-dominated + a wrong-noun theme residual — see file doc). This is deliberately harsher
  // than what a real 69-keyword pool might carry, so the test cannot pass by accident on pool
  // material Fix 1 never touches (caught empirically: an earlier draft of this fixture included
  // 'gift'/'gift idea' and passed even with Fix 1 reverted — pool-sourced fill, not this fix).
  const pool = [...womens, ...wrongNoun]
  return pool
}

function makeOpenAiStub(): PipelineInput['openai'] {
  const payload = {
    designTheme: 'Motivational Entrepreneur Quote',
    visualElements: ['bold text', 'quote graphic'],
    seedKeywords: ['motivational', 'entrepreneur', 'hustle'],
    name: '',
    bullets: [
      'BOLD STATEMENT - A motivational entrepreneur graphic that speaks to hustle culture and ambition.',
      'GREAT GIFT - A thoughtful gift for the go-getter in your life, birthdays or just because.',
      'TRUE TO SIZE - Classic unisex fit runs true to size for a comfortable everyday silhouette.',
      'EASY CARE - Machine washable, holds its shape and color through repeated washing cycles.',
      'EVERYDAY WEAR - A soft, durable graphic sweatshirt made for daily hustle.',
    ],
    description: '<p>A motivational entrepreneur graphic sweatshirt.</p><ul><li>Soft fleece</li><li>Classic fit</li></ul><p>Great gift.</p>',
    backend_drop: [],
    product_details_improvements: [],
  }
  // No `drop` field in the JSON payload => the relevance gate (stage 0a) drops nothing beyond its
  // own deterministic junk/trademark/off-niche backstops — every pool phrase above reaches
  // `candidates` and is judged ONLY by the truth net, exactly like the real gpt-4.1-mini gate does
  // on a conservative "keep audiences/gifts/occasions" response.
  const create = vi.fn(async (args: { response_format?: unknown }) => {
    const content = args?.response_format
      ? JSON.stringify(payload)
      : 'THE CEO Sweatshirt'
    return { choices: [{ message: { content }, finish_reason: 'stop' }] }
  })
  return { chat: { completions: { create } } } as unknown as PipelineInput['openai']
}

function makeInput(openai: PipelineInput['openai']): PipelineInput {
  const familyRepTitle = 'THE CEO Sweatshirt SHIRT'
  return {
    openai,
    brandName: 'THE CEO',
    category: 'Clothing',
    productType: 'SHIRT',
    analysis: makePool(),
    children: makeChildren(),
    parentAsin: 'B0DSCDZC6K',
    repTitle: familyRepTitle,
    canonicalTitle: familyRepTitle,
    priorTitle: familyRepTitle,
    priorBullets: [],
    variantDetails: '',
    keywordContext: '',
    hasAplus: false,
    hasBrandStory: false,
    auditModel: 'o4-mini',
    onProgress: () => {},
    audienceLean: 'unisex',
    designNameOverridesByKey: Object.fromEntries(DESIGNS.map((d) => [d.key, d.name])),
    // THE EXACT LIVE, MEASURED (2026-09-04) titles as this run's prior -- the realistic "regen
    // again after Fix 1 ships" scenario. `verdictForAssembledTitle` finds every one of these
    // truthful (no lies -- just short), so if the search below found NOTHING new the safety net
    // would keep them BYTE-IDENTICAL ('refused-kept-prior'); Fix 1 lifting them proves the search
    // actually found new true material, not merely that no regression-inducing fallback fired.
    priorPerChildTitles: [
      { sku: 'G18000S-BK-HD-FBA', asin: 'B0DSHDS', title: 'THE CEO Hustle Definiton Sweatshirt | Long Sleeve Pullover', designKey: 'HD', designName: 'Hustle Definiton' },
      { sku: 'G18000M-BK-HD-FBA', asin: 'B0DSHDM', title: 'THE CEO Hustle Definiton Sweatshirt | Long Sleeve Pullover', designKey: 'HD', designName: 'Hustle Definiton' },
      { sku: "G18000S-BK-DQ-FBA", asin: 'B0DSDQS', title: "THE CEO Don't Quit Sweatshirt | Long Sleeve Pullover Crewneck", designKey: 'DQ', designName: "Don't Quit" },
      { sku: "G18000M-BK-DQ-FBA", asin: 'B0DSDQM', title: "THE CEO Don't Quit Sweatshirt | Long Sleeve Pullover Crewneck", designKey: 'DQ', designName: "Don't Quit" },
      { sku: 'G18000S-BK-BB-FBA', asin: 'B0DSBBS', title: 'THE CEO Business B*tch Sweatshirt | Long Sleeve Pullover Crewneck', designKey: 'BB', designName: 'Business B*tch' },
      { sku: 'G18000M-BK-BB-FBA', asin: 'B0DSBBM', title: 'THE CEO Business B*tch Sweatshirt | Long Sleeve Pullover Crewneck', designKey: 'BB', designName: 'Business B*tch' },
      { sku: 'G18000S-BK-MH-FBA', asin: 'B0DSMHS', title: 'THE CEO Mother Hustler Sweatshirt | Long Sleeve Pullover Crewneck', designKey: 'MH', designName: 'Mother Hustler' },
      { sku: 'G18000M-BK-MH-FBA', asin: 'B0DSMHM', title: 'THE CEO Mother Hustler Sweatshirt | Long Sleeve Pullover Crewneck', designKey: 'MH', designName: 'Mother Hustler' },
    ],
  } as PipelineInput
}

describe('FIX 1 (inclusive-audience/theme vocab, PO 2026-09-04) + FIX 2 (ship floor) - B0DSCDZC6K live regression', () => {
  it('all six designs reach TITLE_SHIP_FLOOR() (68) -- the four regressed designs recover via Fix 1 true vocabulary', async () => {
    mockedLoadBlankSpecRows.mockResolvedValueOnce(makeCatalog())
    const openai = makeOpenAiStub()
    const logSpy = vi.spyOn(console, 'log')
    const result = await runListingPipeline(makeInput(openai))

    // PROVE THE BRANCH RAN: pull every TITLE_TRUTH_BAND decision line this run emitted -- the
    // terminal net's own greppable tag, not an inference from the final string.
    const truthBandLines: { scope: string; decision: string; to: number; changed: boolean }[] = []
    for (const call of logSpy.mock.calls) {
      const line = call[0]
      if (typeof line !== 'string' || !line.includes('"tag":"TITLE_TRUTH_BAND"')) continue
      try {
        const parsed = JSON.parse(line) as { tag?: string; scope?: string; decision?: string; to?: number; changed?: boolean }
        if (parsed.tag === 'TITLE_TRUTH_BAND') truthBandLines.push({ scope: parsed.scope ?? '', decision: parsed.decision ?? '', to: parsed.to ?? -1, changed: !!parsed.changed })
      } catch { /* not JSON */ }
    }
    logSpy.mockRestore()

    expect(result.per_child_titles, 'multi-design family must produce per_child_titles').toBeDefined()
    const titles = result.per_child_titles!
    expect(titles.length).toBeGreaterThan(0)

    const floor = TITLE_SHIP_FLOOR()
    expect(floor, 'brief-stated floor').toBe(68)

    const report: Record<string, { title: string; len: number; decision: string | null }> = {}
    for (const t of titles) {
      const key = t.designKey || t.designName || t.sku
      if (report[key]) continue // one row per design (2 SKUs each)
      const decisionLine = truthBandLines.find((l) => l.scope === key)
      report[key] = { title: t.title, len: t.title.length, decision: decisionLine?.decision ?? null }
    }
    console.log('B0DSCDZC6K_TITLE_REPORT', JSON.stringify(report, null, 2))

    // EVERY design must reach the floor.
    for (const [key, row] of Object.entries(report)) {
      expect(row.len, `${key}: "${row.title}" (${row.len} chars)`).toBeGreaterThanOrEqual(floor)
    }

    // PROVE THE BRANCH RAN, for the four regressed designs specifically: the terminal net must
    // have actually FOUND new true material this run ('refilled'), not merely kept a prior that
    // happened to already clear the floor (it does not -- the prior is 58/61/65/65, all under 68).
    for (const key of REGRESSED_KEYS) {
      const row = report[key]
      expect(row, `missing report row for ${key}`).toBeDefined()
      expect(row.decision, `${key} decision`).toBe('refilled')
    }

    // No material word reappeared (PR #664's ruling is untouched by this fix).
    const MATERIAL_WORD_RE = /\b(cotton|polyester|spandex|ring[\s-]?spun|fleece|blend|rayon|linen|nylon|elastane|viscose|jersey)\b/i
    for (const t of titles) expect(t.title, `${t.designKey}: "${t.title}"`).not.toMatch(MATERIAL_WORD_RE)

    // No SINGLE-gender claim ever ships on this unisex family (the veto this fix must not regress).
    const SINGLE_GENDER_RE = /\bfor\s+women\b|\bwomen['’]s\b|\bladies\b/i
    for (const t of titles) expect(t.title, `${t.designKey}: "${t.title}"`).not.toMatch(SINGLE_GENDER_RE)
  }, 60000)
})
