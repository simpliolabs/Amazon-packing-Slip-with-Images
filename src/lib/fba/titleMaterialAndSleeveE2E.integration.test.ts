/**
 * titleMaterialAndSleeveE2E.integration.test.ts — END-TO-END PROOF for TWO PO rulings (2026-09-03),
 * driving the REAL runListingPipeline() (never the isolated net), same discipline PR #663's own
 * attributeSpecGroundingE2E.integration.test.ts used to catch a bare-net claim that did not hold in
 * the full pipeline.
 *
 * FIX 1 — "We do not Put material in Title!" (PO ruling 2026-09-03, REVOKING PR #658's Option B).
 *   `recommended_title` / `per_child_titles[].title` must never contain a fabric/material word
 *   (cotton, polyester, ring-spun, spandex, …) — the fact bank PR #658 wired into the title pad
 *   (listingPipeline.ts's `titleBandCtx.spec.material`, titleBand.ts's `candidateSegments`) is
 *   removed. The floor must still be reachable WITHOUT material: this file asserts every title is
 *   still >= TITLE_SHIP_FLOOR(), proving the removal did not recreate the #630/#631 "subtractive net,
 *   no additive producer" collapse.
 *
 * FIX 2 — a LONG-SLEEVE garment must never be called a Tshirt/T-Shirt/Tee. `garmentNoun.ts`'s
 *   LONG_SLEEVE_TEE_BASE used to spread SHIRT_BASE.aliases WHOLESALE (`[...SHIRT_BASE.aliases]`),
 *   handing the title pad's `garmentFactSegments` (listingPipeline.ts) the short-sleeve-implying
 *   words 'tshirt'/'t-shirt'/'tee'/'graphic tee' as candidate segments for a family whose union
 *   includes `long_sleeve_tee` — exactly the live B0DSCDZC6K "Business B*tch" defect
 *   ("...Long Sleeve Cotton Polyester Tshirt"). Cured structurally: the alias list itself now
 *   excludes short-sleeve words, so any future consumer of `.aliases` is correct by construction.
 *
 * THE FIXTURE reproduces B0DSCDZC6K's actual shape (truthBandHarness.ts's own CATALOG/DESIGNS,
 * migrations 053/058): six designs (BB, BCS, DQ, ED, HD, MH), a Gildan 18000 sweatshirt blank
 * dominant family-wide, and — on the Business B*tch (BB) design alone — a MINORITY of children on
 * the Comfort Colors 6014 long-sleeve-tee blank (the PO's real 2026-08-22 ruling on the mislabeled
 * `BB64000XL-BK-FBA` SKU, reproduced here via the ordinary SKU-first style-code path — a `6014`-coded
 * SKU — rather than the DB-backed `blank_assignments` override table, which this hermetic test has
 * no database for). This is what makes BB's OWN per-design garment union
 * (`familyGarmentUnion`/`perDesignTruthCtx`) include BOTH 'sweatshirt' AND 'long_sleeve_tee' — the
 * exact live precondition for the alias-bleed defect. BB's children carry their OWN `.title` (no
 * "sweat"/"hoodie"/"pullover"/"fleece" word) so `hayGarmentClass` resolves 'tee' at BB's own
 * per-design scope while the FAMILY-WIDE hay (which says "Sweatshirt") still resolves 'sweat' —
 * exactly reproducing the asymmetry the live defect depends on (`blankRowConflictsWithHay`,
 * `resolveFamilyBlank`/`familyGarmentUnion` in blankSpecs.ts).
 *
 * Also covers B0DP5H8QBT (the kids-tee single-design specimen, migration 058's 64000B row,
 * SHORT sleeve) — proving the material ban holds there too, and that Fix 2 does not touch a
 * genuinely short-sleeve family's title (the "inverse direction" check the brief asked for).
 *
 * "PROVE THE BRANCH RAN": every case reads the BLANK_RESOLVE / DESIGN_GARMENT_TRUTH /
 * BLANK_GARMENT_UNION console.log lines (blankSpecs.ts / listingPipeline.ts's own decision
 * records) and asserts on them directly — never merely on a word's absence from the final string.
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
import { TITLE_SHIP_FLOOR, TITLE_BAND_LO, TITLE_BAND_HI } from './titleBand'
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

// Byte-identical to migration 058's real rows (058_blank_specs_style_codes.sql) / truthBandHarness's
// own CATALOG — never a hand-retyped duplicate of the DB fact.
function makeCatalog(): BlankSpecRow[] {
  return [
    { match: /\bcomfort\s*colors?\b/i, styleCode: '1717', garmentFamily: 'tee',
      spec: { brand: 'Comfort Colors', fit: 'Relaxed', sleeve: 'Short Sleeve', neck: 'Crew Neck', weightNote: 'midweight 6.1 oz garment-dyed', material: '100% Ring-Spun Cotton', dye: 'Garment-Dyed' } },
    { match: /\bgildan\b|\b64000/i, styleCode: '64000', garmentFamily: 'tee',
      spec: { brand: 'Gildan', brandInCopy: false, fit: 'Classic', sleeve: 'Short Sleeve', neck: 'Crew Neck', weightNote: 'lightweight 4.5 oz ring-spun', material: 'Ring-Spun Cotton' } },
    { match: /\b6014/i, styleCode: '6014', garmentFamily: 'long_sleeve_tee',
      spec: { brand: 'Comfort Colors', fit: 'Relaxed', sleeve: 'Long Sleeve', neck: 'Crew Neck', weightNote: 'midweight 6.1 oz garment-dyed', material: '100% Ring-Spun Cotton', dye: 'Garment-Dyed' } },
    { match: /\b1800(?:0)?(?=\D|$)|\b18000/i, styleCode: '18000', garmentFamily: 'sweatshirt',
      spec: { brand: 'Gildan', brandInCopy: false, fit: 'Classic', sleeve: 'Long Sleeve', neck: 'Crew Neck', weightNote: 'heavyweight 8.0 oz fleece', material: '50% Cotton / 50% Polyester' } },
    { match: /\b64000b/i, styleCode: '64000B', garmentFamily: 'kids_tee',
      spec: { brand: 'Gildan', brandInCopy: false, fit: 'Classic', sleeve: 'Short Sleeve', neck: 'Crew Neck', weightNote: 'lightweight 4.5 oz ring-spun', material: 'Ring-Spun Cotton' } },
  ]
}

/** Six designs, spelled as the seller spells them — byte-identical roster to truthBandHarness.ts's
 *  DESIGNS. Design keys parse via listingPipeline.ts's designKeyForSku (style-code SKU convention:
 *  the DESIGN lives in the suffix after the colour, e.g. G18000S-BK-BCS-FBA -> "BCS"). */
const DESIGNS: { key: string; name: string }[] = [
  { key: 'BB', name: 'Business B*tch' },
  { key: 'BCS', name: 'Billionare Coming Soon' },
  { key: 'DQ', name: "Don't Quit" },
  { key: 'ED', name: 'Entrepreneur Definition' },
  { key: 'HD', name: 'Hustle Definiton' },
  { key: 'MH', name: 'Mother Hustler' },
]

/** BB carries its own non-"sweat" title text on every child (no sweat/hoodie/pullover/fleece word),
 *  so hayGarmentClass resolves 'tee' at BB's OWN per-design scope (buildGroupTruthCtx's groupHay
 *  reads `groupChildren[0].title`) even though the FAMILY-WIDE hay says "Sweatshirt" — the exact
 *  asymmetry that lets BB's minority 6014 blank survive resolveFamilyBlank/familyGarmentUnion's
 *  conflict-drop at BB's own scope while still being (correctly) dropped from the FAMILY-WIDE spec
 *  intersection (blankSpecs.ts's `blankRowConflictsWithHay`). This is what the real PO-stated
 *  `blank_assignments` override achieves in production; this hermetic test has no database for that
 *  table, so it reaches the identical downstream state via the ordinary SKU-first style-code path. */
const BB_CHILD_TITLE = 'THE CEO Business B*tch Graphic Print Design'

function makeChildren(): PipelineChild[] {
  const out: PipelineChild[] = []
  // Five designs: 2 SKUs each on style 18000 (Gildan sweatshirt) — the family's dominant blank.
  for (const d of DESIGNS.slice(1)) {
    for (const size of ['S', 'M']) {
      out.push({ sku: `G18000${size}-BK-${d.key}-FBA`, asin: `B0DS${d.key}${size}`, color: 'Black', size })
    }
  }
  // BB (Business B*tch): 3 SKUs on 18000 (still the design's OWN dominant blank, 3-vs-2) + 2 SKUs
  // on 6014 (long_sleeve_tee) — the PO's real minority ruling reproduced via SKU-first style code.
  for (const size of ['S', 'M', 'L']) {
    out.push({ sku: `G18000${size}-BK-BB-FBA`, asin: `B0DSBB${size}`, color: 'Black', size, title: BB_CHILD_TITLE })
  }
  for (const size of ['S', 'M']) {
    out.push({ sku: `G6014${size}-BK-BB-FBA`, asin: `B0DSBB6014${size}`, color: 'Black', size, title: BB_CHILD_TITLE })
  }
  return out
}

// A B0DP5H8QBT-shaped single-design kids specimen — byte-identical convention to
// attributeSpecGroundingE2E.integration.test.ts's makeChildren/makeKidsBlankRow.
function makeKidsChildren(): PipelineChild[] {
  return [
    { sku: 'DONTQUIT64000B-XS-BLK', asin: 'B0DQXSBLK01', color: 'Black', size: 'XS' },
    { sku: 'DONTQUIT64000B-S-BLK', asin: 'B0DQSBLK002', color: 'Black', size: 'S' },
    { sku: 'DONTQUIT64000B-M-BLK', asin: 'B0DQMBLK003', color: 'Black', size: 'M' },
    { sku: 'DONTQUIT64000B-L-BLK', asin: 'B0DQLBLK004', color: 'Black', size: 'L' },
  ]
}

const mk = (o: Partial<AnalyzedKeyword> & { keyword: string }): AnalyzedKeyword => ({
  coverageGapScore: 50, actionType: 'UPGRADE', actionText: '', rationale: '', urgency: 'medium',
  estimatedImpact: '', searchVolume: 1000, keywordSales: 0, competingProducts: 1000,
  asinImpressionShare: 0, asinClickShare: 0, asinPurchaseShare: 0,
  inTitle: false, inBullets: false, inDescription: false, inBackend: false,
  dataSource: 'jungle_scout', titleDensity: null, organicRank: null,
  ...o,
})

function makePool(): AnalyzedKeyword[] {
  return [
    mk({ keyword: 'motivational entrepreneur sweatshirt', searchVolume: 60_000, coverageGapScore: 90, actionType: 'CRITICAL' }),
    mk({ keyword: 'graphic sweatshirts for men', searchVolume: 40_000, coverageGapScore: 80, actionType: 'CRITICAL' }),
    mk({ keyword: 'hustle mindset gift', searchVolume: 8_000, coverageGapScore: 60, actionType: 'UPGRADE' }),
    mk({ keyword: 'boss lady sweatshirt', searchVolume: 5_000, coverageGapScore: 55, actionType: 'UPGRADE' }),
  ]
}

/** THE CALL-SHAPE SPLIT (found by running this file against pre-fix code): the title council
 *  (titleCouncilAsk, listingPipeline.ts:3428) NEVER sets `response_format` and treats
 *  `completion.choices[0].message.content` AS THE RAW TITLE STRING, verbatim — no JSON envelope.
 *  Every OTHER JSON-mode caller on this path (bullets council, editorial audit, vision identity
 *  scan) DOES set `response_format: {type:'json_object'}`. A single kitchen-sink JSON blob
 *  returned unconditionally (the naive approach) makes the title council pick the literal
 *  stringified JSON as its "title", which fails validation and starves the per-design band net of
 *  a real produced candidate — masking the very mechanism this file exists to prove. So the stub
 *  branches on `args.response_format`: JSON mode gets the kitchen-sink payload, plain-text mode
 *  (the title council) gets a plain title string. The deterministic title-band door
 *  (settleTitle/candidateSegments) — not this raw LLM text — is what actually decides the shipped
 *  bytes; this raw text only needs to be a legitimate, non-empty, brand-led candidate.
 */
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
  const create = vi.fn(async (args: { response_format?: unknown }) => {
    const content = args?.response_format
      ? JSON.stringify(payload)
      : 'THE CEO Motivational Entrepreneur Graphic Sweatshirt for Everyone'
    return { choices: [{ message: { content }, finish_reason: 'stop' }] }
  })
  return { chat: { completions: { create } } } as unknown as PipelineInput['openai']
}

function makeOpenAiStubKids(defectTitle: string): PipelineInput['openai'] {
  const payload = {
    bullets: [
      'SOFT COMFORT - Made from ring-spun cotton, this youth tee feels soft against skin all day long.',
      'GREAT GIFT - A thoughtful motivational gift for birthdays, holidays, or just because they deserve it.',
      'TRUE TO SIZE - Classic fit runs true to size for a comfortable everyday silhouette for kids.',
      'EASY CARE - Machine washable, holds its shape and color through repeated washing cycles.',
      'PLAYFUL DESIGN - A fun motivational graphic print that stands out in any crowd, made for kids.',
    ],
    description: '<p>A motivational tee for kids.</p><ul><li>Soft ring-spun cotton</li><li>Classic fit</li></ul><p>Great gift.</p>',
    backend_drop: [],
    product_details_improvements: [],
  }
  const create = vi.fn(async (args: { response_format?: unknown }) => {
    const content = args?.response_format ? JSON.stringify(payload) : defectTitle
    return { choices: [{ message: { content }, finish_reason: 'stop' }] }
  })
  return { chat: { completions: { create } } } as unknown as PipelineInput['openai']
}

function makeInput(openai: PipelineInput['openai']): PipelineInput {
  const familyRepTitle = 'THE CEO Graphic Sweatshirt Gildan Heavy Blend Crewneck Sweatshirt SHIRT'
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
  }
}

function makeKidsInput(openai: PipelineInput['openai'], defectTitle: string): PipelineInput {
  return {
    openai,
    brandName: 'THE CEO',
    category: 'Clothing',
    productType: 'SHIRT',
    analysis: [
      mk({ keyword: 'motivational shirts for kids', searchVolume: 12_000, coverageGapScore: 85, actionType: 'CRITICAL' }),
      mk({ keyword: "don't quit shirt", searchVolume: 4_000, coverageGapScore: 70, actionType: 'UPGRADE' }),
    ],
    children: makeKidsChildren(),
    parentAsin: 'B0DP5H8QBT',
    repTitle: defectTitle,
    canonicalTitle: defectTitle,
    priorTitle: defectTitle,
    priorBullets: [],
    variantDetails: '',
    keywordContext: '',
    hasAplus: false,
    hasBrandStory: false,
    auditModel: 'o4-mini',
    onProgress: () => {},
    audienceLean: 'unisex',
  }
}

/** blankSpecs.ts's own BLANK_GARMENT_UNION decision record — proves BB's per-design union actually
 *  computed {sweatshirt, long_sleeve_tee}, not merely that the final title looks a certain way. */
function captureGarmentUnionLogs(spy: ReturnType<typeof vi.spyOn>): { union: string[]; dominant: string }[] {
  const out: { union: string[]; dominant: string }[] = []
  for (const call of spy.mock.calls) {
    const line = call[0]
    if (typeof line !== 'string' || !line.includes('BLANK_GARMENT_UNION')) continue
    try {
      const parsed = JSON.parse(line) as { tag?: string; union?: string[]; dominant?: string }
      if (parsed.tag === 'BLANK_GARMENT_UNION') out.push({ union: parsed.union ?? [], dominant: parsed.dominant ?? '' })
    } catch { /* not JSON */ }
  }
  return out
}

const MATERIAL_WORD_RE = /\b(cotton|polyester|spandex|ring[\s-]?spun|fleece|blend|rayon|linen|nylon|elastane|viscose|jersey)\b/i
const SHORT_SLEEVE_WORD_RE = /\b(t-?shirt|tshirt|tee)\b/i

describe('FIX 1 + FIX 2 — end-to-end through the REAL runListingPipeline (PO ruling 2026-09-03)', () => {
  it('B0DSCDZC6K (six designs, mixed 18000/6014 blank union): every per-child title is material-free, reaches the floor, and BB never asserts a short-sleeve noun', async () => {
    mockedLoadBlankSpecRows.mockResolvedValueOnce(makeCatalog())
    const openai = makeOpenAiStub()
    const logSpy = vi.spyOn(console, 'log')
    const result = await runListingPipeline(makeInput(openai))
    const unionLogs = captureGarmentUnionLogs(logSpy)
    logSpy.mockRestore()

    // PROVE THE BRANCH RAN: BB's own per-design garment union actually computed BOTH classes —
    // the live defect's precondition — not merely that the final string happens to look right.
    const bbUnion = unionLogs.find((u) => u.union.includes('long_sleeve_tee'))
    expect(bbUnion, JSON.stringify(unionLogs)).toBeDefined()
    expect(bbUnion!.union).toEqual(expect.arrayContaining(['sweatshirt', 'long_sleeve_tee']))

    expect(result.per_child_titles, 'multi-design family must produce per_child_titles').toBeDefined()
    const titles = result.per_child_titles!
    expect(titles.length).toBeGreaterThan(0)

    const floor = TITLE_SHIP_FLOOR()
    const report: Record<string, { title: string; len: number }> = {}
    for (const t of titles) {
      const key = t.designKey || t.designName || t.sku
      report[key] = { title: t.title, len: t.title.length }
    }
    console.log('TITLE_REPORT', JSON.stringify(report, null, 2))

    for (const t of titles) {
      // FIX 1: no material/fabric word, ever.
      expect(t.title, `${t.designKey}: "${t.title}"`).not.toMatch(MATERIAL_WORD_RE)
      // FLOOR: removing material must not collapse the title below the ship floor (the
      // #630/#631 subtractive-net-without-an-additive-producer class).
      expect(t.title.length, `${t.designKey}: "${t.title}" (${t.title.length} chars)`).toBeGreaterThanOrEqual(floor)
    }

    // FIX 2, the live case: BB's own title(s) — the design whose union includes long_sleeve_tee —
    // never assert a short-sleeve noun (tshirt/t-shirt/tee) alongside/instead of the long-sleeve
    // truth. Not merely "no tshirt anywhere": specifically on BB, the design this defect targeted.
    const bbTitles = titles.filter((t) => t.designKey === 'BB')
    expect(bbTitles.length).toBeGreaterThan(0)
    for (const t of bbTitles) {
      expect(t.title, `BB: "${t.title}"`).not.toMatch(SHORT_SLEEVE_WORD_RE)
    }
  }, 60_000)

  it('B0DP5H8QBT (kids specimen, short-sleeve 64000B): material-free, and Fix 2 does not touch a genuinely short-sleeve family (the inverse-direction check)', async () => {
    mockedLoadBlankSpecRows.mockResolvedValueOnce([makeCatalog().find((r) => r.styleCode === '64000B')!])
    const DEFECT = "THE CEO Don't Quit Motivational T-Shirt | Kids Ring-Spun Cotton Crew Neck"
    const openai = makeOpenAiStubKids(DEFECT)
    const result = await runListingPipeline(makeKidsInput(openai, DEFECT))

    const shipped = result.recommended_title
    console.log('KIDS_TITLE_REPORT', JSON.stringify({ before: DEFECT, beforeLen: DEFECT.length, after: shipped, afterLen: shipped.length }))

    const floor = TITLE_SHIP_FLOOR()
    expect(shipped.length).toBeGreaterThanOrEqual(floor)
    expect(shipped).not.toMatch(MATERIAL_WORD_RE)
    // The inverse-direction check: a genuinely short-sleeve family may still truthfully say
    // "Tee"/"Tshirt" — Fix 2 must not have banned short-sleeve words globally, only the
    // cross-family bleed onto a LONG-sleeve family.
    expect(shipped.toLowerCase()).not.toMatch(/\blong\s*sleeve\b/)
  }, 60_000)
})
