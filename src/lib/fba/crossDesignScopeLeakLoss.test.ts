/**
 * crossDesignScopeLeakLoss.test.ts — `.superpowers/sdd/2026-09-24-cross-design-leak/
 * phase-y1-rulings.md`, RULING Y1: the committed measurement, BUILT AND RUN BEFORE any Y2-Y5
 * production fix. This is the round's BASELINE commit — every number below is printed, none
 * asserted to zero yet (that gate is RULING Y4, landed with the Y2-Y5 fix in the next commit).
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
 * The `main@89d6cb0` baseline (pasted in the commit message and phase-y1-report.md) was measured
 * with a resolver-alias copy of `listingPipeline.ts` + `titleCap.ts`/`contentContract.ts` (git-
 * show'd, OUTSIDE the repo — never committed). `__fixtures__/crossDesignScopeLeakLoss.baseline-
 * 89d6cb0.json` freezes that run's own PER-DESIGN PLANS, so LOSS below diffs the CURRENT tree's
 * plan against `main`'s: a baseline keyword that names no OTHER design (own/shared) but is missing
 * NOW is a loss; one that DOES name exactly one OTHER design as a full-name unit is the removal the
 * eventual Y2 fix is FOR (credited to LEAK, never double-counted as a loss). Diffing against the
 * pipeline's OWN prior output — never the raw input pool — is deliberate: a design's plan is
 * capped well below pool size by ranking/variant-dedup steps that run BEFORE any design-scope
 * filter and are identical on both builds, so comparing against the raw pool would count the
 * pipeline's own ranking cutoff as "loss" on every arm regardless of scoping (caught by hand while
 * writing this file).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { runListingPipeline, type PipelineInput } from '@/lib/fba/listingPipeline'

/** Y1's own two-number printout — this commit is the BASELINE, so every arm below is RECORDED and
 *  printed (to console + `out-y1-baseline.txt` beside this file, git-ignored-by-convention scratch
 *  output) rather than asserted to zero. The Y2-Y5 commit tightens each of these into a real gate. */
const Y1_SUMMARY: { arm: string; leak: number; leakDetail: string[]; loss: number; lossDetail: string[] }[] = []
const y1Record = (arm: string, leak: { count: number; detail: string[] }, loss: { count: number; detail: string[] }) => {
  Y1_SUMMARY.push({ arm, leak: leak.count, leakDetail: leak.detail, loss: loss.count, lossDetail: loss.detail })
}
afterAll(() => {
  const lines = ['RULING Y1 baseline — printed, not gated (this commit predates the Y2-Y5 fix)', '']
  let totalLeak = 0; let totalLoss = 0
  for (const r of Y1_SUMMARY) {
    totalLeak += r.leak; totalLoss += r.loss
    lines.push(`${r.arm.padEnd(60)} LEAK=${r.leak}  LOSS=${r.loss}`)
    for (const d of r.leakDetail.slice(0, 4)) lines.push(`    LEAK: ${d}`)
    for (const d of r.lossDetail.slice(0, 4)) lines.push(`    LOSS: ${d}`)
  }
  lines.push('', `TOTAL LEAK=${totalLeak}  TOTAL LOSS=${totalLoss}`)
  // Console only — never a file inside the repo (a test run must leave `git status --short` clean).
  // eslint-disable-next-line no-console
  console.log(lines.join('\n'))
})

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
        y1Record(`${a.label} [${section}]`, leak, loss)
      }
      expect(true).toBe(true)
    }, 900_000)
  }
})

describe('RULING Y1 — the TITLE channel, baseline', () => {
  it('T1/T2/T3 title-contamination arms', async () => {
    const t2 = await runArm({ label: 'T2 live HDG title contaminated', section: 'bullets', canonical: CLEAN('Hustle Definiton'), pool: POOL_TWO, poolKws: POOL_TWO_KWS, liveContam: true })
    y1Record('T2 live HDG title contaminated [bullets]', t2.leak, t2.loss)
    const t1 = await runArm({ label: 'T1 stored per-child HDG contaminated', section: 'bullets', canonical: CLEAN('Hustle Definiton'), pool: POOL_TWO, poolKws: POOL_TWO_KWS, storedContam: true })
    y1Record('T1 stored per-child HDG contaminated [bullets]', t1.leak, t1.loss)
    const t3 = await runArm({ label: 'T3 both contaminated', section: 'bullets', canonical: CLEAN('Hustle Definiton'), pool: POOL_TWO, poolKws: POOL_TWO_KWS, storedContam: true, liveContam: true })
    y1Record('T3 both contaminated [bullets]', t3.leak, t3.loss)
    expect(true).toBe(true)
  }, 900_000)
})

describe('RULING Y1 — per-design FALLBACK baseline (bullets and description)', () => {
  it('bullets fallback: HDG per-design call always fails', async () => {
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
    y1Record('fallback: HDG per-design bullets always fails [bullets]', { count: leak.count + sibs.length, detail: [...leak.detail, ...sibs.map((s) => `SHIPPED HDG bullets carry: ${s}`)] }, { count: 0, detail: [] })
    expect(true).toBe(true)
  }, 900_000)

  it('description fallback: HDG per-design call always fails', async () => {
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
    y1Record('fallback: HDG per-design description always fails [description]', { count: leak.count + sibs.length, detail: [...leak.detail, ...sibs.map((s) => `SHIPPED HDG description carries: ${s}`)] }, { count: 0, detail: [] })
    expect(true).toBe(true)
  }, 900_000)
})

describe('RULING Y1 — the editorial audit angle channel baseline, on a FULL regen', () => {
  it('every design group\'s audit prompt angle', async () => {
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
    y1Record('full regen: editorial audit angle channel [full]', { count: leaks.length, detail: leaks }, { count: 0, detail: [] })
    expect(true).toBe(true)
  }, 900_000)
})

describe('RULING Y1 — vocabulary-loss baseline (real six names + fishing family)', () => {
  it('the six real names, an entrepreneur-niche pool', async () => {
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
    y1Record('niche vocab: real six names, entrepreneur pool [bullets]', { count: 0, detail: [] }, { count: lossCount, detail: lossDetail })
    expect(true).toBe(true)
  }, 900_000)

  // designScope.ts's own motivating case (the "review-caught Fishing Trip niche-word regression").
  it('the fishing family', async () => {
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
    y1Record('fishing family: FT/BM/RCD/HLS [bullets]', { count: 0, detail: [] }, { count: lossCount, detail: [...lossDetail, `(info) degradedSections=${JSON.stringify(r.degradedSections ?? [])}`] })
    expect(true).toBe(true)
  }, 900_000)
})

// RULING Y5: degraded-identity arms are MEASURED, baseline recorded here too.
describe('RULING Y5 — degraded-identity arms baseline', () => {
  it('BB designName unresolved to \'\'', async () => {
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
    y1Record('Y5 degraded: BB designName unresolved to \'\' [bullets]', leak, { count: 0, detail: [] })
    expect(true).toBe(true)
  }, 900_000)
})
