/**
 * crossDesignPerDesignScopeStrict.test.ts — `.superpowers/sdd/2026-09-24-cross-design-leak/
 * phase-x1-rulings.md`, RULINGS X1-X3.
 *
 * THE CLASS (round S's first ruling, restated by X2): a FAMILY-scoped exemption may not license a
 * sibling design's name at a PER-DESIGN composition site. The per-child TITLE ship door already
 * obeys it (`perChildDesignScope`, `{ familyTitleText: '', poolKeywords: [], strictNames: true }`,
 * `listingPipeline.ts`) because "an exemption sourced from the family TITLE would be circular — the
 * title is the thing on trial." Before this fix, TWO other per-design callers still sourced their
 * exemption from the family title (the top CHILD's own title/canonicalTitle) or from raw pool
 * frequency: the Item Highlight composer (X1) and the bullets/description/backend keyword-plan
 * scoper (X2, `foreignToksFor`) — plus the title CANDIDATE filter, which had `strictNames: true`
 * but still read the contaminated family title. Live shape (B0DSCDZC6K): "Business B*tch" is BB's
 * own, legitimate design name, but when BB is the family's top-selling child, its name sits in
 * `canonicalTitle`/the live title, and a family-title-sourced exemption re-licenses BB's own name
 * into every SIBLING's keyword plan / Item Highlight line — the exact circularity the ship door's
 * comment names, from a different source.
 *
 * Every probe below runs the REAL production functions (`runListingPipeline`,
 * `buildItemHighlightsPerDesign`) with no production code mocked — only the OpenAI client is
 * stubbed, and only to route each design's bullets/description response by name.
 */
import { describe, it, expect, vi } from 'vitest'
import { runListingPipeline, buildItemHighlightsPerDesign, type PipelineInput } from '@/lib/fba/listingPipeline'
import { DEFAULT_BLANK_SPECS } from '@/lib/fba/blankSpecs'
import type { AnalyzedKeyword } from '@/lib/keyword-engine'

const NAMES = [
  { key: 'BB', name: 'Business B*tch' },
  { key: 'HDG', name: 'Hustle Definiton' },
  { key: 'MHG', name: 'Mother Hustler' },
  { key: 'BCSG', name: 'Billionare Coming Soon' },
  { key: 'DQG', name: "Don't Quit" },
  { key: 'GMG', name: 'Grind Mode' },
] as const

/* ══ X1 — the Item Highlight composer, at its three call sites' shared internal contract ══════ */

describe('X1 — buildItemHighlightsPerDesign ignores a contaminated familyTitleText', () => {
  const kw = (keyword: string, fit: 0 | 1 | 2 | 3 = 3): AnalyzedKeyword => ({
    keyword, searchVolume: 1000, themeFit: 3,
    themeFitByDesign: Object.fromEntries(NAMES.map((n) => [n.key, { fit, about: 'gym' }])),
  } as unknown as AnalyzedKeyword)
  const GROUPS = NAMES.map((n) => ({
    key: n.key, designName: n.name, skus: [{ sku: `${n.key}-1`, asin: `B0${n.key}00001` }],
    titles: [`THE CEO ${n.name} Shirt for Men Tee`],
  }))
  const SHARED = [kw('graphic tees for men'), kw('funny tshirts men'), kw('novelty shirts for guys')]
  const OWN = NAMES.map((n) => kw(`${n.name.toLowerCase()} motivation wear`))
  const POOL = [...OWN, ...SHARED]
  /** The recorded LIVE family title — BB is the top child, so its own name IS the family title. */
  const CONTAMINATED = 'THE CEO Motivational Entrepreneur | Business B*tch Sweatshirt for Men'

  const run = (familyTitleText: string) =>
    buildItemHighlightsPerDesign({ groups: GROUPS, pool: POOL, apparelProduct: true, blankBrand: DEFAULT_BLANK_SPECS[1], familyTitleText })

  it('a contaminated familyTitleText (the live shape) leaks BB into every sibling line — RED without the fix', () => {
    // This is what `buildItemHighlightsPerDesign` would do if it read `input.familyTitleText`
    // verbatim (the pre-X1 behavior) — proven by calling it with the SAME contaminated value the
    // live callers used to pass, confirming the fix is in the composer, not just its callers.
    const withoutFix = run(CONTAMINATED)
    // The fix makes this call byte-identical to the clean-argument call below regardless of what
    // is passed in — so this arm is really pinning "no matter what a caller sends, the result is
    // the CLEAN one", i.e. the leak is closed AT THE COMPOSER, not merely at each caller.
    const clean = run('')
    expect(withoutFix).toEqual(clean)
  })

  it('no non-owner design line names "business" in either arm — the composer itself never re-arms the leak', () => {
    for (const ftt of [CONTAMINATED, '']) {
      const r = run(ftt)
      const leaking = r.perDesign.filter((d) => d.designKey !== 'BB' && /business/i.test(d.value)).map((d) => d.designKey)
      expect(leaking, `familyTitleText="${ftt}" leaked into: ${leaking.join(',')}`).toEqual([])
    }
  })

  it("BB's own line still carries its own name — the fix drops a SIBLING's leak, not a design's own vocabulary", () => {
    const r = run('')
    const bb = r.perDesign.find((d) => d.designKey === 'BB')
    expect(bb?.value ?? '').toMatch(/business/i)
  })
})

/* ══ X2 + X3 — the bullets/description/backend keyword-plan scoper, through the REAL pipeline ══ */

const LONG_TAIL = [
  'PREMIUM COMFORT - Soft ringspun cotton with a relaxed crewneck fit that holds its shape wash after wash.',
  'BUILT TO LAST - Durable double-needle stitching keeps the print crisp season after season without fading.',
  'EASY CARE - Machine washable, tumble dry low, no shrinking and no fading over repeated wash cycles.',
]
const HEALTHY: Record<string, string[]> = Object.fromEntries(
  NAMES.map(({ key, name }) => [key, [
    `BOLD STATEMENT - The ${name} graphic says exactly what this crewneck is about every single day.`,
    `GREAT GIFT - A thoughtful present for the person who lives the ${name} mindset every day.`,
    ...LONG_TAIL,
  ]]),
)
const HEALTHY_DESC: Record<string, string> = Object.fromEntries(
  NAMES.map(({ key, name }) => [key, `<p>The <b>${name}</b> design, printed on a heavyweight crewneck.</p><ul><li>Soft ringspun cotton</li></ul>`]),
)
const SUPABASE_ENV_KEYS = ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'NEXT_PUBLIC_SUPABASE_ANON_KEY'] as const

const kwRow = (keyword: string, score: number, vol: number) => ({
  keyword, coverageGapScore: score, actionType: 'CRITICAL', actionText: '', rationale: '', urgency: 'high', estimatedImpact: '',
  searchVolume: vol, keywordSales: 0, competingProducts: 100, asinImpressionShare: 0, asinClickShare: 0, asinPurchaseShare: 0,
  inTitle: false, inBullets: false, inDescription: false, inBackend: false, dataSource: 'jungle_scout',
}) as unknown as PipelineInput['analysis'][number]

// GENUINELY SHARED niche garment vocabulary (X3's floor) — none of it any design's own NAME token.
const SHARED_KWS = [
  kwRow('graphic sweatshirt for men', 95, 5000),
  kwRow('crewneck sweatshirt gift', 80, 4000),
  kwRow('graphic crewneck sweatshirt', 75, 3500),
]
// Each design's OWN distinguishing phrase, plus a word ("gift") its own CLEAN title does not
// contain — so the title-coverage dedup in `scopeKwsToGroup` (unrelated to X2/X3) cannot zero it
// out, and BB's censored title token ("B*tch") vs an uncensored keyword ("bitch") cannot create an
// asymmetric confound between BB and its siblings.
const OWN_PHRASE: Record<string, string> = {
  BB: 'business bitch gift', HDG: 'hustle definiton gift', MHG: 'mother hustler gift',
  BCSG: 'billionare coming soon gift', DQG: "don't quit gift", GMG: 'grind mode gift',
}
const OWN_KWS = NAMES.map((n) => kwRow(OWN_PHRASE[n.key], 70, 1200))
/** BB's SECOND slogan phrase — the exact live contamination shape (pool.probe C1-C3). */
const BB_SLOGAN_2 = kwRow('business bitch shirt women', 85, 3000)
// Exactly 3 + 6 + 1 = 10 rows, so none is cut by `topOpportunityKwsForBullets`'s own top-10 cap
// (an unrelated selection limit, not part of this fix).
const POOL = [...SHARED_KWS, ...OWN_KWS, BB_SLOGAN_2]

const CLEAN_TITLE = (name: string) => `THE CEO ${name} Sweatshirt | Motivational Long Sleeve Crewneck for Men`
const cleanPriorTitles = NAMES.flatMap(({ key, name }, i) => [
  { sku: `${key}-M`, asin: `B0${key}00000${i}1`, title: CLEAN_TITLE(name), designName: name, designKey: key },
  { sku: `${key}-L`, asin: `B0${key}00000${i}2`, title: CLEAN_TITLE(name), designName: name, designKey: key },
])
const liveChildren: PipelineInput['children'] = NAMES.flatMap(({ key, name }, i) => [
  { sku: `${key}-M`, asin: `B0${key}00000${i}1`, color: 'Black', size: 'M', title: CLEAN_TITLE(name) },
  { sku: `${key}-L`, asin: `B0${key}00000${i}2`, color: 'Black', size: 'L', title: CLEAN_TITLE(name) },
])

const stubOpenAI = () => ({
  chat: { completions: { create: vi.fn(async (args: { messages?: { content?: string }[] }) => {
    const user = String(args?.messages?.map((m) => m?.content ?? '').join('\n') ?? '')
    if (/"designName"/.test(user)) return { choices: [{ message: { content: JSON.stringify({ designName: '' }) }, finish_reason: 'stop' }] }
    let key = ''; let best = -1
    for (const { key: k, name } of NAMES) { const i = user.toLowerCase().lastIndexOf(name.toLowerCase()); if (i > best) { best = i; key = k } }
    return { choices: [{ message: { content: JSON.stringify({
      title: 'x', bullets: key ? HEALTHY[key] : HEALTHY.GMG, description: key ? HEALTHY_DESC[key] : HEALTHY_DESC.GMG,
      backend_drop: [], drop: [],
    }) }, finish_reason: 'stop' }] }
  }) } },
}) as unknown as PipelineInput['openai']

/** TOP CHILD = BB (the live shape: the family's best seller IS the design whose name/slogan must
 *  never leak into a sibling). Both `canonicalTitle` (route.ts:971 in production) and the pool
 *  carry BB's slogan. */
async function runBulletsForFamily(): Promise<Record<string, string[]>> {
  const saved: Record<string, string | undefined> = {}
  for (const k of SUPABASE_ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k] }
  try {
    const input: PipelineInput = {
      openai: stubOpenAI(), brandName: 'THE CEO', category: 'Clothing', productType: 'SWEATSHIRT',
      analysis: POOL, children: liveChildren, repTitle: liveChildren[0].title!,
      canonicalTitle: CLEAN_TITLE('Business B*tch'), priorTitle: 'THE CEO Motivational Entrepreneur Sweatshirt | Long Sleeve Crewneck for Men',
      priorBullets: HEALTHY.BB, variantDetails: '', keywordContext: '', hasAplus: false, hasBrandStory: false,
      auditModel: 'o4-mini', onProgress: () => {}, priorPerChildTitles: cleanPriorTitles, onlySection: 'bullets',
    }
    const r = await runListingPipeline(input)
    const pd = (r.keywordPlan as { perDesign?: { designKey: string; bullets: string[] }[] }).perDesign ?? []
    return Object.fromEntries(NAMES.map((n) => [n.key, pd.find((p) => p.designKey === n.key)?.bullets ?? []]))
  } finally {
    for (const k of SUPABASE_ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
  }
}

describe('X2/X3 — bullets keyword-plan scoper: sibling names closed, own/shared vocabulary intact', () => {
  it('measured on the shipped tree (paste in phase-x1-report.md): every design keeps its own + shared words, only BB keeps its slogan', async () => {
    const plans = await runBulletsForFamily()
    for (const { key, name } of NAMES) {
      const plan = plans[key].map((p) => p.toLowerCase())
      // X3 FLOOR: this design's OWN keyword and every genuinely shared niche keyword survive.
      expect(plan, `${key} lost its own keyword`).toContain(OWN_PHRASE[key])
      for (const s of SHARED_KWS) expect(plan, `${key} lost the shared keyword "${s.keyword}"`).toContain((s.keyword as string).toLowerCase())
      // X2: BB's slogan phrase is present ONLY in BB's own plan.
      const carriesSlogan = plan.includes((BB_SLOGAN_2.keyword as string).toLowerCase())
      expect(carriesSlogan, `${key}'s plan ${key === 'BB' ? 'must' : 'must NOT'} carry BB's slogan`).toBe(key === 'BB')
      // No OTHER design's own phrase appears in this design's plan.
      for (const other of NAMES) {
        if (other.key === key) continue
        expect(plan, `${key}'s plan carries ${other.key}'s own phrase`).not.toContain(OWN_PHRASE[other.key])
      }
    }
  }, 60_000)

  it("THE PIN (mutation-provable): reverting familyTitleText/strictNames at :11334's call reproduces the leak", async () => {
    // A structural pin, not a byte-diff: the fix is that `foreignToksFor`'s options object is
    // `{ familyTitleText: '', poolKeywords: ..., strictNames: true }` — not the family's own
    // canonicalTitle/priorTitle, and not soft (strictNames absent/false). `phase-x1-report.md`
    // records this test failing (RED) against a copy with the pre-fix literal restored.
    const src = (await import('node:fs')).readFileSync(
      (await import('node:path')).join(process.cwd(), 'src', 'lib', 'fba', 'listingPipeline.ts'), 'utf8',
    )
    expect(src).toMatch(/const foreignToksFor = buildForeignDesignTokens\(\s*designGroupContexts\.map\(\(c\) => \(\{ key: c\.key, name: c\.designName \}\)\),\s*\{ familyTitleText: '', poolKeywords: analysis\.map\(\(k\) => k\.keyword\), strictNames: true \},/)
  })
})
