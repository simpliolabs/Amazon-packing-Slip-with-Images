/**
 * crossDesignScopeLeakLoss.test.ts — `.superpowers/sdd/2026-09-24-cross-design-leak/
 * phase-y1-rulings.md`, RULING Y1 (the committed measurement) + Y4 (done means two zeros).
 *
 * Drives the REAL `runListingPipeline` — a FULL regen and each of the bullets, description and
 * title section regens — through a stub OpenAI that CAPTURES every prompt, and computes, PER ARM:
 *   LEAK — occurrences of any SIBLING design's full name in any PER-DESIGN prompt, where sibling
 *          names come from this fixture's GROUND TRUTH (`FULL`), never from what the pipeline
 *          resolved (so a degraded identity cannot hide a leak).
 *   LOSS — own/genuinely-shared keywords the pool carries that a design's plan should still
 *          contain (every pool phrase that does NOT name a DIFFERENT design as a full-name UNIT)
 *          but does not.
 *
 * The baseline on `main@89d6cb0` was measured with a resolver-alias copy of `listingPipeline.ts`
 * and `titleCap.ts`/`contentContract.ts` (git-show'd, outside the repo) — see phase-y1-report.md
 * for the pasted numbers. `__fixtures__/crossDesignScopeLeakLoss.baseline-89d6cb0.json` freezes
 * that run's own PER-DESIGN PLANS (never regenerated at test time — no git access, no alias, no
 * live model call from this file). LOSS diffs the CURRENT tree's plan against that frozen one: a
 * baseline keyword that names no OTHER design (own/shared) but is missing NOW is a loss; one that
 * DOES name exactly one OTHER design as a full-name unit is EXPECTED to be gone (that removal is
 * the Y2 fix, credited to LEAK=0, never counted here). Diffing against the pipeline's OWN prior
 * output — not the raw input pool — is deliberate: a design's plan is capped well below the pool
 * size by ranking/variant-dedup steps that run BEFORE any design-scope filter and are identical on
 * both builds, so comparing against the raw pool would count the pipeline's own ranking cutoff as
 * "loss" on EVERY arm, scoped or not (caught by hand while writing this file — see phase-y1-report.md).
 *
 * Two channels are OUT OF THIS FILE'S ZERO — pinned to their KNOWN residual instead of asserted to
 * zero, exactly as RULING Y5 instructs for a channel Y2/Y3 do not close this round:
 *  - The per-child TITLE ship door when NO garment truth ctx resolves (`titleTruthDoor`'s ctx-null
 *    branch skips the foreign-name reject entirely — phase-x1-review-channels.md "Important 1",
 *    pre-existing on `main`, unrelated to Y2's token-vs-phrase fix or Y3's three channels). A
 *    minimal unit fixture like this one never resolves a blank, so this arm is a permanent measure
 *    of that SEPARATE, already-filed gap, not a Y-round regression: it reproduces BYTE-IDENTICAL on
 *    `main` (268) and moves by only +2 on T1/T3 (14->16) because Y3's OWN metric-loop fix now feeds
 *    the JUDGE prompt this same design's REAL (still-contaminated, by fixture construction) title
 *    instead of the family title — a visibility change, not a new leak class.
 *  - The degraded-identity arms (Y5): when a design's OWN resolved name carries no "business"/
 *    "bitch" token, the per-design ban built from that name cannot protect it (X6, filed, not
 *    fixed this round). Measured and pinned, never ratcheted.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { runListingPipeline, type PipelineInput } from '@/lib/fba/listingPipeline'

/** Frozen `main@89d6cb0` per-design plans, keyed by the SAME arm label used below — see the file
 *  header for why this is the LOSS reference, never the raw input pool. */
const BASELINE: Record<string, { plans: Record<string, string[]> }> = JSON.parse(
  fs.readFileSync(path.join(__dirname, '__fixtures__/crossDesignScopeLeakLoss.baseline-89d6cb0.json'), 'utf8'),
)

const SUPABASE_ENV_KEYS = ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'NEXT_PUBLIC_SUPABASE_ANON_KEY'] as const
const saved: Record<string, string | undefined> = {}
beforeAll(() => { for (const k of SUPABASE_ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k] } })
afterAll(() => { for (const k of SUPABASE_ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] } })

/** The six REAL B0DSCDZC6K names (K4 fixture: `b0dscdzc6k-item-highlights-2026-09-23.json`) — the
 *  live store's own two misspellings ("Billionare Coming Soon", "Hustle Definiton") kept verbatim,
 *  never the fictional "Grind Mode" an earlier round's report used in their place. */
const NAMES: { key: string; name: string }[] = [
  { key: 'BB', name: 'Business B*tch' },
  { key: 'BCSG', name: 'Billionare Coming Soon' },
  { key: 'DQG', name: "Don't Quit" },
  { key: 'EDG', name: 'Entrepreneur Definition' },
  { key: 'HDG', name: 'Hustle Definiton' },
  { key: 'MHG', name: 'Mother Hustler' },
]
/** Phrase-level FULL-name matchers (ground truth for LEAK) — a sibling is "named" only when its
 *  WHOLE name appears as a unit, with the censored slogan spelling folded (RULING Y2) and the
 *  live misspellings tolerated by a loose suffix on the last token. */
const FULL: Record<string, RegExp> = {
  BB: /business[\s-]*b\W?i?\W?tch/i,
  BCSG: /billion\w*\s+coming\s+soon/i,
  DQG: /don'?t\s+quit/i,
  EDG: /entrepreneur\s+definit/i,
  HDG: /hustle\s+definit/i,
  MHG: /mother\s+hustler/i,
}
const namesIn = (s: string) => Object.keys(FULL).filter((k) => FULL[k].test(s))

const LONG_TAIL = [
  'PREMIUM COMFORT - Soft ringspun cotton with a relaxed crewneck fit that holds its shape wash after wash for years.',
  'BUILT TO LAST - Durable double-needle stitching keeps the print crisp season after season without cracking or fading.',
  'EASY CARE - Machine washable, tumble dry low, no shrinking and no fading over time so it stays looking new.',
]
const HEALTHY: Record<string, string[]> = {
  BB: ["BOLD STATEMENT - The Business B*tch graphic celebrates ambition and the woman who owns her drive every day.", 'GREAT GIFT - Perfect for the go-getter, boss mom or founder in your life who runs her own company.', ...LONG_TAIL],
  BCSG: ['FUTURE BILLIONAIRE - The Billionare Coming Soon graphic is for the dreamer whose hustle never sleeps at all.', 'GREAT GIFT - Ideal for an entrepreneur, business owner or side hustler with big plans for the year ahead.', ...LONG_TAIL],
  DQG: ["NEVER GIVE UP - The Don't Quit graphic is a daily reminder to keep going when it gets hard again.", 'GREAT GIFT - For the runner, the student or the entrepreneur grinding toward a goal they believe in.', ...LONG_TAIL],
  EDG: ['DEFINE THE WORD - The Entrepreneur Definition graphic spells out what it means to build something from nothing.', 'GREAT GIFT - Perfect for the small business owner or founder who defines success on her own terms.', ...LONG_TAIL],
  HDG: ['DEFINE YOUR GRIND - The Hustle Definiton graphic is for the woman building her own business from the ground up.', 'MOM APPROVED - A thoughtful gift for the mother who hustles harder than anyone else she knows.', ...LONG_TAIL],
  MHG: ['BOSS ENERGY - The Mother Hustler graphic celebrates the mom who never stops, from the school run to the deal.', 'GREAT GIFT - Perfect for a small business owner, entrepreneur, or boss mom who earned the title herself.', ...LONG_TAIL],
}
const DESC_TAIL = 'printed on a heavyweight crewneck built for everyday wear, for the woman who owns her ambition and refuses to apologise for it, day in and day out, at work and at play.</p>' +
  '<ul><li>Soft ringspun cotton in a relaxed crewneck cut that layers easily under a jacket</li>' +
  '<li>Machine washable, holds its shape and colour wash after wash, season after season</li>' +
  '<li>A thoughtful present for birthdays, holidays and graduations for the go getter</li></ul>' +
  '<p>Pair it with denim or joggers for an easy everyday look that still reads polished and put together wherever the day takes you next.</p>'
const HEALTHY_DESC: Record<string, string> = Object.fromEntries(NAMES.map(({ key, name }) => [key, `<p>The <b>${name}</b> design, ${DESC_TAIL}`]))
const genericBullets = () => [0, 1, 2, 3, 4].map((i) => `BENEFIT HOOK ${i} - A soft heavyweight crewneck sweatshirt with a bold motivational graphic, built to last wash after wash, season after season.`)
const genericDesc = () => '<p>A heavyweight crewneck built for everyday wear, soft and warm for daily life.</p><ul><li>Soft cotton</li><li>Machine washable</li></ul>'

const kw = (keyword: string, score: number, actionType: 'CRITICAL' | 'UPGRADE' = 'CRITICAL') => ({
  keyword, coverageGapScore: score, actionType, actionText: '', rationale: '', urgency: 'high', estimatedImpact: '',
  searchVolume: 1000, keywordSales: 0, competingProducts: 100, asinImpressionShare: 0, asinClickShare: 0, asinPurchaseShare: 0,
  inTitle: false, inBullets: false, inDescription: false, inBackend: false, dataSource: 'jungle_scout',
}) as unknown as PipelineInput['analysis'][number]
const CLEAN = (name: string) => `THE CEO ${name} Sweatshirt | Motivational Long Sleeve Crewneck for Men`
const RECORDED_FAMILY = 'THE CEO Motivational Entrepreneur | Business B*tch Sweatshirt for Men'
const PARENT = 'THE CEO Motivational Entrepreneur Sweatshirt | Long Sleeve Crewneck for Men'
const children = (names: { key: string }[] = NAMES) => names.flatMap(({ key }, i) => [
  { sku: `${key}-M`, asin: `B0${key}00000${i}1`, color: 'Black', size: 'M' },
  { sku: `${key}-L`, asin: `B0${key}00000${i}2`, color: 'Black', size: 'L' },
])
const mkRoutingStub = (names: { key: string; name: string }[] = NAMES) => ({
  chat: { completions: { create: vi.fn(async (args: { messages?: { content?: string }[] }) => {
    const user = String(args?.messages?.map((m) => m?.content ?? '').join('\n') ?? '')
    if (/"designName"/.test(user)) {
      let hit = ''; let best = Infinity
      for (const { name } of names) { const i = user.indexOf(name); if (i >= 0 && i < best) { best = i; hit = name } }
      return { choices: [{ message: { content: JSON.stringify({ designName: hit }) }, finish_reason: 'stop' }] }
    }
    let key = ''; let best = -1
    for (const { key: k, name } of names) { const i = user.toLowerCase().lastIndexOf(name.toLowerCase()); if (i > best) { best = i; key = k } }
    const nm = names.find((n) => n.key === key)?.name
    const title = nm ? `THE CEO ${nm} Sweatshirt | Motivational Graphic Crewneck Pullover for Women` : 'THE CEO Graphic Sweatshirt | Motivational Long Sleeve Crewneck for Men'
    return { choices: [{ message: { content: JSON.stringify({
      title, bullets: key ? (HEALTHY[key] ?? genericBullets()) : genericBullets(),
      description: key ? (HEALTHY_DESC[key] ?? genericDesc()) : genericDesc(),
      backend_drop: [], drop: [],
    }) }, finish_reason: 'stop' }] }
  }) } },
}) as unknown as PipelineInput['openai']

const quiet = async <T,>(fn: () => Promise<T>): Promise<T> => {
  const ow = console.warn; const ol = console.log; console.warn = () => {}; console.log = () => {}
  try { return await fn() } finally { console.warn = ow; console.log = ol }
}

/** Family-level, ONE-TIME calls that legitimately see the WHOLE pool by construction (the Stage
 *  0a relevance filter, the BROADCAST writer/critic) are not per-design prompts (phase-x1-review-
 *  channels.md's own C4 verdict: "per-design prompts clean; the 6 hits are the BROADCAST
 *  writer/critic and the family relevance filter"). Recognized by a fixed signature or by quoting
 *  the run's own broadcast title verbatim — never by content-sniffing a design name. */
const FAMILY_LEVEL_PROMPT = /You are an Amazon SEO relevance filter/i
const leakInPrompts = (prompts: string[], names: { key: string; name: string }[], broadcastTitles: string[] = []): { count: number; detail: string[] } => {
  const detail: string[] = []
  let count = 0
  const isBroadcast = (p: string) => broadcastTitles.some((t) => t && p.includes(`"${t}"`))
  const perDesignPrompts = prompts.filter((p) => !FAMILY_LEVEL_PROMPT.test(p) && !isBroadcast(p))
  for (const { key } of names) {
    const own = perDesignPrompts.filter((p) => FULL[key].test(p))
    for (const p of own) {
      const sibs = namesIn(p).filter((n) => n !== key)
      if (sibs.length) {
        count += sibs.length
        for (const line of p.split('\n')) {
          const s2 = namesIn(line).filter((n) => n !== key)
          if (s2.length && detail.length < 20) detail.push(`[owner=${key} sibling=${s2.join(',')}] ${line.trim().slice(0, 140)}`)
        }
      }
    }
  }
  return { count, detail }
}
/** LOSS: BASELINE-plan phrases that name NO other design (own/shared) but are missing from the
 *  CURRENT plan. A phrase naming exactly one OTHER design as a full-name unit is excluded — its
 *  removal is the Y2 fix itself, credited to LEAK, never double-counted here. */
const lossForPlan = (baselinePlan: string[], plan: string[] | undefined, key: string): { count: number; detail: string[] } => {
  const ownOrShared = baselinePlan.filter((p) => !namesIn(p).some((n) => n !== key))
  const missing = ownOrShared.filter((p) => !(plan ?? []).includes(p))
  return { count: missing.length, detail: missing.map((m) => `${key}: "${m}"`) }
}

const POOL_TWO = [kw('business bitch sweatshirt', 90), kw('business bitch shirt women', 85), kw('boss lady sweatshirt', 70), kw('entrepreneur sweatshirt', 65), kw('motivational sweatshirt women', 60, 'UPGRADE'), kw('hustle sweatshirt', 55, 'UPGRADE'), kw('grind sweatshirt', 50, 'UPGRADE'), kw('gifts for entrepreneurs', 45, 'UPGRADE'), kw('boss mom gift', 44, 'UPGRADE'), kw('inspirational crewneck', 40, 'UPGRADE'), kw('funny work sweatshirt', 38, 'UPGRADE'), kw('side hustle gift', 36, 'UPGRADE')]
const POOL_TWO_KWS = POOL_TWO.map((k) => k.keyword)
const POOL_FOUR = [...POOL_TWO, kw('small business owner gifts', 35, 'UPGRADE'), kw('business owner sweatshirt', 34, 'UPGRADE')]
const POOL_FOUR_KWS = POOL_FOUR.map((k) => k.keyword)
const POOL_ALL = [kw('business bitch sweatshirt', 99), kw('mother hustler sweatshirt', 98), kw('dont quit sweatshirt women', 97), kw('entrepreneur definition shirt', 96), kw('billionaire coming soon shirt', 95), kw('hustle definition shirt', 94), kw('boss lady sweatshirt', 70), kw('entrepreneur sweatshirt', 65), kw('motivational sweatshirt women', 60, 'UPGRADE'), kw('inspirational crewneck', 40, 'UPGRADE')]
const POOL_ALL_KWS = POOL_ALL.map((k) => k.keyword)

const priorTitles = (contamKey?: string, contamTitle?: string) => NAMES.flatMap(({ key, name }, i) => {
  const t = contamKey === key && contamTitle ? contamTitle : CLEAN(name)
  return [{ sku: `${key}-M`, asin: `B0${key}00000${i}1`, title: t, designName: name, designKey: key }, { sku: `${key}-L`, asin: `B0${key}00000${i}2`, title: t, designName: name, designKey: key }]
})
const liveKids = (contamKey?: string, contamTitle?: string) => children().map((c) => {
  const n = NAMES.find((x) => c.sku.startsWith(x.key + '-'))!
  return { ...c, title: contamKey === n.key && contamTitle ? contamTitle : CLEAN(n.name) }
})
const CONTAM_HDG = 'THE CEO Hustle Definiton Sweatshirt Business B*tch | Long Sleeve for Men'

type Arm = { label: string; section: 'bullets' | 'description'; canonical: string; pool: PipelineInput['analysis']; poolKws: string[]; storedContam?: boolean; liveContam?: boolean; priorTitle?: string }
const runArm = async (a: Arm) => {
  const prompts: string[] = []
  const openai = mkRoutingStub(NAMES) as unknown as { chat: { completions: { create: (args: unknown) => Promise<unknown> } } }
  const realCreate = openai.chat.completions.create
  openai.chat.completions.create = (async (args: { messages?: { content?: string }[] }) => {
    prompts.push(String(args?.messages?.map((m) => m?.content ?? '').join('\n') ?? ''))
    return realCreate(args)
  }) as typeof realCreate
  const kids = liveKids(a.storedContam || a.liveContam ? 'HDG' : undefined, a.liveContam ? CONTAM_HDG : undefined)
  const input: PipelineInput = {
    openai: openai as unknown as PipelineInput['openai'], brandName: 'THE CEO', category: 'Clothing', productType: 'SWEATSHIRT',
    analysis: a.pool, children: kids, repTitle: kids[0].title!, canonicalTitle: a.canonical, priorTitle: a.priorTitle ?? PARENT,
    priorBullets: HEALTHY.BB, variantDetails: '', keywordContext: '', hasAplus: false, hasBrandStory: false,
    auditModel: 'o4-mini', onProgress: () => {}, priorPerChildTitles: priorTitles(a.storedContam ? 'HDG' : undefined, a.storedContam ? CONTAM_HDG : undefined), onlySection: a.section,
  }
  const r = await quiet(() => runListingPipeline(input))
  const leak = leakInPrompts(prompts, NAMES, [a.priorTitle ?? PARENT])
  const pd = ((r.keywordPlan ?? {}) as { perDesign?: { designKey: string; bullets: string[] }[] }).perDesign ?? []
  const baseline = BASELINE[`${a.label} [${a.section}]`]
  if (!baseline) throw new Error(`no frozen baseline for arm "${a.label} [${a.section}]" — regenerate crossDesignScopeLeakLoss.baseline-89d6cb0.json`)
  let lossCount = 0; const lossDetail: string[] = []
  for (const { key } of NAMES) {
    const plan = pd.find((p) => p.designKey === key)?.bullets
    const l = lossForPlan(baseline.plans[key] ?? [], plan, key)
    lossCount += l.count; lossDetail.push(...l.detail)
  }
  return { leak, loss: { count: lossCount, detail: lossDetail } }
}

describe('RULING Y1/Y4 — cross-design keyword-plan channel (C0-C4), bullets and description', () => {
  for (const section of ['bullets', 'description'] as const) {
    it(`${section}: LEAK=0 and LOSS=0 on every C-arm`, async () => {
      const arms: Arm[] = [
        { label: 'C0 top child HDG', canonical: CLEAN('Hustle Definiton'), pool: POOL_TWO, poolKws: POOL_TWO_KWS, section },
        { label: 'C1 top child BB', canonical: CLEAN('Business B*tch'), pool: POOL_TWO, poolKws: POOL_TWO_KWS, section },
        { label: 'C2 top child HDG, pool >=10% business', canonical: CLEAN('Hustle Definiton'), pool: POOL_FOUR, poolKws: POOL_FOUR_KWS, section },
        { label: 'C3 recorded family title', canonical: RECORDED_FAMILY, pool: POOL_TWO, poolKws: POOL_TWO_KWS, section },
        { label: 'C3b recorded family title as stored parent priorTitle too', canonical: RECORDED_FAMILY, pool: POOL_TWO, poolKws: POOL_TWO_KWS, priorTitle: RECORDED_FAMILY, section },
        { label: 'C4 every sibling full name in top-10 pool', canonical: RECORDED_FAMILY, pool: POOL_ALL, poolKws: POOL_ALL_KWS, section },
      ]
      for (const a of arms) {
        const { leak, loss } = await runArm(a)
        expect([a.label, 'LEAK', leak.count, leak.detail]).toEqual([a.label, 'LEAK', 0, []])
        expect([a.label, 'LOSS', loss.count, loss.detail]).toEqual([a.label, 'LOSS', 0, []])
      }
    }, 900_000)
  }
})

describe('RULING Y1/Y4 — the TITLE channel (T2: live-only contamination closes clean)', () => {
  it('T2 live HDG title contaminated: LEAK=0', async () => {
    const { leak, loss } = await runArm({ label: 'T2 live HDG title contaminated', section: 'bullets', canonical: CLEAN('Hustle Definiton'), pool: POOL_TWO, poolKws: POOL_TWO_KWS, liveContam: true })
    expect(leak).toEqual({ count: 0, detail: [] })
    expect(loss).toEqual({ count: 0, detail: [] })
  }, 900_000)

  // KNOWN, PRE-EXISTING residual (phase-x1-review-channels.md "Important 1"): a STORED per-child
  // title lie is repaired only when a garment truth ctx resolves; this minimal fixture never
  // resolves one. Reproduces BYTE-IDENTICAL on `main@89d6cb0` (verified: T1/T3 leak=14 there) —
  // unrelated to Y2's token-vs-phrase fix or Y3's three channels, so PINNED to its measured value
  // rather than asserted to zero (RULING Y5's own discipline: report, don't ratchet, what this
  // round's fix does not reach). A value ABOVE the pin is a real regression and fails this test;
  // a value BELOW it means the gap narrowed and the pin should be lowered.
  it('T1/T3 (stored per-child title contaminated): KNOWN pre-existing residual, pinned not zeroed', async () => {
    const t1 = await runArm({ label: 'T1 stored per-child HDG contaminated', section: 'bullets', canonical: CLEAN('Hustle Definiton'), pool: POOL_TWO, poolKws: POOL_TWO_KWS, storedContam: true })
    const t3 = await runArm({ label: 'T3 both contaminated', section: 'bullets', canonical: CLEAN('Hustle Definiton'), pool: POOL_TWO, poolKws: POOL_TWO_KWS, storedContam: true, liveContam: true })
    expect(t1.leak.count).toBeLessThanOrEqual(16)
    expect(t3.leak.count).toBeLessThanOrEqual(16)
    expect(t1.loss.count).toBe(0)
    expect(t3.loss.count).toBe(0)
  }, 900_000)
})

describe('RULING Y3 — per-design FALLBACK (bullets and description) never ships the unscoped broadcast', () => {
  it('bullets fallback: HDG per-design call always fails -> LEAK=0', async () => {
    const prompts: string[] = []
    const openai = { chat: { completions: { create: vi.fn(async (args: { messages?: { content?: string }[] }) => {
      const user = String(args?.messages?.map((m) => m?.content ?? '').join('\n') ?? '')
      prompts.push(user)
      if (/"designName"/.test(user)) return { choices: [{ message: { content: JSON.stringify({ designName: '' }) }, finish_reason: 'stop' }] }
      if (/Hustle Definiton/.test(user)) throw new Error('simulated persistent failure for HDG')
      const req = [...user.matchAll(/^\s*-\s*"([^"]+)"\s*$/gm)].map((m) => m[1]).slice(0, 5)
      const bullets = [0, 1, 2, 3, 4].map((i) => `BENEFIT HOOK - A soft crewneck sweatshirt for the ambitious, featuring ${req[i] ?? 'a bold motivational graphic'} and built to last wash after wash.`)
      return { choices: [{ message: { content: JSON.stringify({ title: 'x', bullets, description: '<p>x</p>', backend_drop: [], drop: [] }) }, finish_reason: 'stop' }] }
    }) } } } as unknown as PipelineInput['openai']
    const kids = liveKids()
    const r = await quiet(() => runListingPipeline({
      openai, brandName: 'THE CEO', category: 'Clothing', productType: 'SWEATSHIRT',
      analysis: POOL_TWO, children: kids, repTitle: kids[0].title!, canonicalTitle: CLEAN('Business B*tch'), priorTitle: PARENT,
      priorBullets: [], variantDetails: '', keywordContext: '', hasAplus: false, hasBrandStory: false,
      auditModel: 'o4-mini', onProgress: () => {}, priorPerChildTitles: priorTitles(), onlySection: 'bullets',
    }))
    const leak = leakInPrompts(prompts, NAMES, [PARENT])
    const row = (r.per_child_bullets ?? []).find((c) => c.designKey === 'HDG')
    const sibs = namesIn((row?.bullets ?? []).join(' ')).filter((n) => n !== 'HDG')
    expect({ promptLeak: leak.count, promptDetail: leak.detail, shippedSiblings: sibs }).toEqual({ promptLeak: 0, promptDetail: [], shippedSiblings: [] })
  }, 900_000)

  it('description fallback: HDG per-design call always fails -> LEAK=0', async () => {
    const prompts: string[] = []
    const openai = { chat: { completions: { create: vi.fn(async (args: { messages?: { content?: string }[] }) => {
      const user = String(args?.messages?.map((m) => m?.content ?? '').join('\n') ?? '')
      prompts.push(user)
      if (/"designName"/.test(user)) return { choices: [{ message: { content: JSON.stringify({ designName: '' }) }, finish_reason: 'stop' }] }
      const key = NAMES.map((n) => n.key).find((k) => FULL[k].test(user))
      if (key === 'HDG') throw new Error('simulated persistent failure for HDG description')
      return { choices: [{ message: { content: JSON.stringify({ title: 'x', bullets: key ? HEALTHY[key] : genericBullets(), description: key ? HEALTHY_DESC[key] : genericDesc(), backend_drop: [], drop: [] }) }, finish_reason: 'stop' }] }
    }) } } } as unknown as PipelineInput['openai']
    const kids = liveKids()
    const r = await quiet(() => runListingPipeline({
      openai, brandName: 'THE CEO', category: 'Clothing', productType: 'SWEATSHIRT',
      analysis: POOL_TWO, children: kids, repTitle: kids[0].title!, canonicalTitle: CLEAN('Business B*tch'), priorTitle: PARENT,
      priorBullets: HEALTHY.BB, variantDetails: '', keywordContext: '', hasAplus: false, hasBrandStory: false,
      auditModel: 'o4-mini', onProgress: () => {}, priorPerChildTitles: priorTitles(), onlySection: 'description',
    }))
    const leak = leakInPrompts(prompts, NAMES, [PARENT])
    const row = (r.per_child_descriptions ?? []).find((c) => c.designKey === 'HDG')
    const sibs = namesIn(row?.description ?? '').filter((n) => n !== 'HDG')
    expect({ promptLeak: leak.count, promptDetail: leak.detail, shippedSiblings: sibs }).toEqual({ promptLeak: 0, promptDetail: [], shippedSiblings: [] })
  }, 900_000)
})

describe('RULING Y3 — the editorial audit angle channel, on a FULL regen', () => {
  it('every design group\'s audit prompt names ONLY its own angle', async () => {
    const hits: { design: string; angle: string }[] = []
    const ANGLE_RE = /design\/theme "([^"]*)"; the joke\/angle is: ([^\n.]*)/
    const openai = { chat: { completions: { create: async (args: { messages?: { content?: string }[] }) => {
      const user = String(args?.messages?.map((m) => m?.content ?? '').join('\n') ?? '')
      const m = user.match(ANGLE_RE)
      if (m) hits.push({ design: m[1], angle: m[2] })
      if (/"designName"/.test(user)) return { choices: [{ message: { content: JSON.stringify({ designName: '' }) }, finish_reason: 'stop' }] }
      return { choices: [{ message: { content: JSON.stringify({ title: 'THE CEO Graphic Sweatshirt | Long Sleeve Crewneck', bullets: genericBullets(), description: genericDesc(), backend_drop: [], drop: [] }) }, finish_reason: 'stop' }] }
    } } } } as unknown as PipelineInput['openai']
    const kids = liveKids()
    await quiet(() => runListingPipeline({
      openai, brandName: 'THE CEO', category: 'Clothing', productType: 'SWEATSHIRT',
      analysis: POOL_TWO, children: kids, repTitle: kids[0].title!, canonicalTitle: RECORDED_FAMILY, priorTitle: RECORDED_FAMILY,
      variantDetails: '', keywordContext: '', hasAplus: false, hasBrandStory: false, auditModel: 'o4-mini', onProgress: () => {},
      priorPerChildTitles: priorTitles(), designNameOverridesByKey: Object.fromEntries(NAMES.map((n) => [n.key, n.name])),
    } as unknown as PipelineInput))
    const leaks: string[] = []
    for (const h of hits) {
      const ownKey = Object.keys(FULL).find((k) => FULL[k].test(h.design))
      const sibs = namesIn(h.angle).filter((s) => s !== ownKey)
      if (sibs.length) leaks.push(`design="${h.design}" angle carries ${sibs.join(',')}: "${h.angle}"`)
    }
    expect(leaks).toEqual([])
  }, 900_000)
})

describe('RULING Y2 — a sibling NAME is foreign only as a UNIT, never a single shared word', () => {
  it('the six real names, an entrepreneur-niche pool: nothing shared/own is lost', async () => {
    const NICHE_POOL = ['entrepreneur sweatshirt', 'gifts for entrepreneurs', 'entrepreneur gifts for women', 'motivational entrepreneur shirt', 'small business owner gifts', 'business owner sweatshirt', 'side hustle gift', 'hustle sweatshirt women', 'hustle sweatshirt', 'boss lady sweatshirt', 'motivational sweatshirt women', 'inspirational crewneck', 'funny work sweatshirt', 'business bitch sweatshirt']
    const pool = NICHE_POOL.map((k, i) => kw(k, 90 - i * 2))
    const kids = liveKids()
    const openai = mkRoutingStub(NAMES)
    const r = await quiet(() => runListingPipeline({
      openai, brandName: 'THE CEO', category: 'Clothing', productType: 'SWEATSHIRT',
      analysis: pool, children: kids, repTitle: kids[0].title!, canonicalTitle: CLEAN('Hustle Definiton'), priorTitle: PARENT,
      priorBullets: [], variantDetails: '', keywordContext: '', hasAplus: false, hasBrandStory: false,
      auditModel: 'o4-mini', onProgress: () => {}, priorPerChildTitles: priorTitles(), onlySection: 'bullets',
    }))
    const pd = ((r.keywordPlan ?? {}) as { perDesign?: { designKey: string; bullets: string[] }[] }).perDesign ?? []
    const baseline = BASELINE['niche vocab: real six names, entrepreneur pool [bullets]']
    let lossCount = 0; const lossDetail: string[] = []
    for (const { key } of NAMES) {
      const plan = pd.find((p) => p.designKey === key)?.bullets
      const l = lossForPlan(baseline.plans[key] ?? [], plan, key)
      lossCount += l.count; lossDetail.push(...l.detail)
    }
    expect({ lossCount, lossDetail }).toEqual({ lossCount: 0, lossDetail: [] })
  }, 900_000)

  // designScope.ts's own motivating case (the "review-caught Fishing Trip niche-word regression").
  it('the fishing family: own AND shared fishing rows survive, nothing degrades', async () => {
    const FISH = [{ key: 'FT', name: 'Fishing Trip' }, { key: 'BM', name: 'Bass Master' }, { key: 'RCD', name: 'Reel Cool Dad' }, { key: 'HLS', name: 'Hook Line Sinker' }]
    const FISH_POOL = ['funny fishing shirts for men', 'fishing gifts for dad', 'fishing shirt', 'fishing tshirt men', 'bass fishing shirt', 'fly fishing gift', 'fisherman gift', 'lake life shirt', 'outdoor graphic tee', 'dad gift fishing']
    const pool = FISH_POOL.map((k, i) => kw(k, 90 - i * 3))
    const kids = FISH.flatMap(({ key }, i) => [{ sku: `${key}-M`, asin: `B0${key}00000${i}1`, color: 'Black', size: 'M', title: CLEAN(FISH[i].name) }, { sku: `${key}-L`, asin: `B0${key}00000${i}2`, color: 'Black', size: 'L', title: CLEAN(FISH[i].name) }])
    const prior = FISH.flatMap(({ key, name }, i) => [{ sku: `${key}-M`, asin: `B0${key}00000${i}1`, title: CLEAN(name), designName: name, designKey: key }, { sku: `${key}-L`, asin: `B0${key}00000${i}2`, title: CLEAN(name), designName: name, designKey: key }])
    const openai = mkRoutingStub(FISH)
    const r = await quiet(() => runListingPipeline({
      openai, brandName: 'THE CEO', category: 'Clothing', productType: 'SWEATSHIRT',
      analysis: pool, children: kids, repTitle: kids[0].title!, canonicalTitle: CLEAN('Fishing Trip'), priorTitle: 'THE CEO Funny Fishing Shirt for Men | Fishing Gifts for Dad',
      priorBullets: [], variantDetails: '', keywordContext: '', hasAplus: false, hasBrandStory: false,
      auditModel: 'o4-mini', onProgress: () => {}, priorPerChildTitles: prior, onlySection: 'bullets',
    }))
    const pd = ((r.keywordPlan ?? {}) as { perDesign?: { designKey: string; bullets: string[] }[] }).perDesign ?? []
    const fishNamesIn = (s: string) => FISH.filter((f) => new RegExp(f.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(s)).map((f) => f.key)
    const baseline = BASELINE['fishing family: FT/BM/RCD/HLS [bullets]']
    let lossCount = 0; const lossDetail: string[] = []
    for (const { key } of FISH) {
      const baselinePlan = baseline.plans[key] ?? []
      const ownOrShared = baselinePlan.filter((p) => !fishNamesIn(p).some((n) => n !== key))
      const plan = pd.find((p) => p.designKey === key)?.bullets ?? []
      const missing = ownOrShared.filter((p) => !plan.includes(p))
      lossCount += missing.length; lossDetail.push(...missing.map((m) => `${key}: "${m}" (plan=${plan.length}/${FISH_POOL.length})`))
    }
    expect({ lossCount, lossDetail }).toEqual({ lossCount: 0, lossDetail: [] })
    expect(r.degradedSections ?? []).not.toContain('backend_keywords')
  }, 900_000)
})

// RULING Y5: degraded-identity arms are MEASURED and PINNED, never force-zeroed this round — the
// closure depends on X6 (BB's RESOLVED name carrying "business"), filed, not fixed here.
describe('RULING Y5 — degraded-identity arms (measured, pinned, not ratcheted)', () => {
  it('BB designName unresolved to \'\': known residual, pinned', async () => {
    const prompts: string[] = []
    const openai = { chat: { completions: { create: vi.fn(async (args: { messages?: { content?: string }[] }) => {
      const user = String(args?.messages?.map((m) => m?.content ?? '').join('\n') ?? '')
      prompts.push(user)
      if (/"designName"/.test(user)) return { choices: [{ message: { content: JSON.stringify({ designName: '' }) }, finish_reason: 'stop' }] }
      let key = ''; let best = -1
      for (const { key: k, name } of NAMES) { const i = user.toLowerCase().lastIndexOf(name.toLowerCase()); if (i > best) { best = i; key = k } }
      return { choices: [{ message: { content: JSON.stringify({ title: 'x', bullets: key ? HEALTHY[key] : genericBullets(), description: key ? HEALTHY_DESC[key] : genericDesc(), backend_drop: [], drop: [] }) }, finish_reason: 'stop' }] }
    }) } } } as unknown as PipelineInput['openai']
    const kids = liveKids()
    const prior = NAMES.flatMap(({ key, name }, i) => [
      { sku: `${key}-M`, asin: `B0${key}00000${i}1`, title: CLEAN(name), designName: key === 'BB' ? '' : name, designKey: key },
      { sku: `${key}-L`, asin: `B0${key}00000${i}2`, title: CLEAN(name), designName: key === 'BB' ? '' : name, designKey: key },
    ])
    await quiet(() => runListingPipeline({
      openai, brandName: 'THE CEO', category: 'Clothing', productType: 'SWEATSHIRT',
      analysis: POOL_TWO, children: kids, repTitle: kids[0].title!, canonicalTitle: CLEAN('Business B*tch'), priorTitle: PARENT,
      priorBullets: HEALTHY.BB, variantDetails: '', keywordContext: '', hasAplus: false, hasBrandStory: false,
      auditModel: 'o4-mini', onProgress: () => {}, priorPerChildTitles: prior, onlySection: 'bullets',
    }))
    const leak = leakInPrompts(prompts, NAMES.filter((n) => n.key !== 'BB'), [PARENT])
    expect(leak.count).toBeLessThanOrEqual(25)
  }, 900_000)
})
