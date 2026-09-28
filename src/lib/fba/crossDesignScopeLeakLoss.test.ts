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
  chat: { completions: { create: vi.fn(async (args: { messages?: { content?: string }[]; response_format?: { type?: string } }) => {
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
    // RULING Z1 (2026-09-28): title-council calls (`titleCouncilAsk` — persona drafts, the
    // adversary critique, the judge synth) never set `response_format` and expect a PLAIN TITLE
    // STRING back, unlike the bullets/description combined ask below (which always requests
    // `json_object`). Before this fix the stub returned the SAME big JSON blob to every call, so
    // `titleCouncilAsk` treated the whole `{"title":...,"bullets":[...],...}` object AS the title
    // text — and that blob (echoing whichever OTHER design the routing heuristic last matched)
    // then got quoted verbatim into the NEXT persona/critique/judge prompt as a "candidate title",
    // manufacturing a sibling-name "leak" that was a stub artifact, not a pipeline defect (caught
    // running this exact extension — see phase-z1-report.md).
    if (args?.response_format?.type !== 'json_object') {
      return { choices: [{ message: { content: title }, finish_reason: 'stop' }] }
    }
    // The BACKEND COUNCIL (`askCandidates`) also requests `json_object`, but expects
    // `{"candidates":[...]}`, never `{"title":...}` — returning the bullets/title/description blob
    // here is harmless (its `.candidates` reads back `undefined` → `[]`, the council's own
    // documented fail-open), so it is left as the shared fallback below rather than given its own
    // branch; a genuinely empty result is exactly what a stub with no real candidate data should
    // return, and the council's fail-open chain (proposer → legacy theme-fill) is production code
    // already exercised elsewhere.
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
// RULING Z1 widened this to also recognize the multi-design PARENT/BROADCAST title producer
// (`buildNicheParentTitle`). Its PERSONA prompts embed the roleLine ("BROADCAST PARENT TITLE for
// a variation family") in the SYSTEM message, but the critique/judge prompts (`titleCouncilAsk`
// calls with a hardcoded critic/judge system string) never do — they carry only `baseUser`
// (`.user`, never `.system`), so a marker present ONLY in `roleLine` misses two of the three call
// shapes (caught running this exact extension: the critique/judge prompts still leaked every
// sibling name via the roster line, mis-attributed to whichever one's name the content-sniffed
// owner heuristic — I1, phase-y1-review-harness.md — happened to match first). The INPUT BLOCK's
// own "Child design names (DO NOT name any specifically...)" line is reused verbatim in ALL THREE
// call shapes (persona/critique/judge all pass `baseUser`), so it is the stable marker.
const FAMILY_LEVEL_PROMPT = /You are an Amazon SEO relevance filter|BROADCAST PARENT TITLE for a variation family|Child design names \(DO NOT name any specifically/i
const leakInPrompts = (prompts: string[], names: { key: string; name: string }[], broadcastTitles: string[] = []): { count: number; detail: string[] } => {
  const detail: string[] = []
  let count = 0
  // RULING Z1: `runAuditAgent` (the single-shot mega-audit — ANOTHER family-level, ONE-TIME call:
  // it takes the BROADCAST `finalTitle`/`bullets` plus a per-child BACKEND SAMPLE "for variant
  // health", by construction spanning multiple designs) writes its finalized-content block as
  // `TITLE: ${finalTitle}` — no surrounding quotes — so the ORIGINAL quoted-only match missed it
  // (caught running this exact extension: its own `BACKEND (sample of per-child):` lines, one row
  // per design, were being misread as N separate per-design leaks).
  const isBroadcast = (p: string) => broadcastTitles.some((t) => t && (p.includes(`"${t}"`) || p.includes(`TITLE: ${t}`)))
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
    console.log(JSON.stringify({ tag: 'T1_T3_LEAK', t1: t1.leak.count, t3: t3.leak.count }))
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

/* ════════════════════════════════════════════════════════════════════════════════════════════════
 * RULING Z1-Z6 (`.superpowers/sdd/2026-09-24-cross-design-leak/phase-z1-rulings.md`, 2026-09-28).
 *
 * Round Y's own harness (above) only ever set `onlySection: 'bullets' | 'description'`, so every
 * per-design prompt builder that runs on a TITLE regen, a KEYWORDS (backend) regen, or the parts of
 * a FULL regen those two sections gate (the multi-design title council, the backend council, the
 * per-child editorial audit, the terminal bullets expander) was NEVER EXAMINED — not because
 * `leakInPrompts` cannot see them (it scans every captured prompt, unconditionally), but because the
 * PIPELINE ITSELF never ran that code on a bullets/description-only regen. Z1 closes the blind spot
 * with real arms on the previously-untested paths, reusing the SAME `leakInPrompts`/`FULL`/`NAMES`
 * ground truth as every arm above — never a second detector.
 */
/** Runs `runListingPipeline` and returns every captured prompt PLUS the result, for arms that need
 *  more than the bullets-plan LOSS `runArm` computes (title/full/keywords sections don't report a
 *  comparable "plan" — LEAK is baseline-independent by construction: it is ground-truth sibling
 *  names in a per-design prompt, never a diff against a frozen fixture). Module-scoped (not nested
 *  in one `describe`) so both the title/full-regen block and the keywords-only block share it. */
const runFull = async (opts: {
  section?: 'title' | 'keywords'
  canonical: string
  pool: PipelineInput['analysis']
  priorTitle?: string
  storedContam?: boolean
  liveContam?: boolean
}) => {
  const prompts: string[] = []
  const openai = mkRoutingStub(NAMES) as unknown as { chat: { completions: { create: (args: unknown) => Promise<unknown> } } }
  const realCreate = openai.chat.completions.create
  openai.chat.completions.create = (async (args: { messages?: { content?: string }[] }) => {
    prompts.push(String(args?.messages?.map((m) => m?.content ?? '').join('\n') ?? ''))
    return realCreate(args)
  }) as typeof realCreate
  const kids = liveKids(opts.storedContam || opts.liveContam ? 'HDG' : undefined, opts.liveContam ? CONTAM_HDG : undefined)
  const input: PipelineInput = {
    openai: openai as unknown as PipelineInput['openai'], brandName: 'THE CEO', category: 'Clothing', productType: 'SWEATSHIRT',
    analysis: opts.pool, children: kids, repTitle: kids[0].title!, canonicalTitle: opts.canonical, priorTitle: opts.priorTitle ?? PARENT,
    priorBullets: HEALTHY.BB, variantDetails: '', keywordContext: '', hasAplus: false, hasBrandStory: false,
    auditModel: 'o4-mini', onProgress: () => {}, priorPerChildTitles: priorTitles(opts.storedContam ? 'HDG' : undefined, opts.storedContam ? CONTAM_HDG : undefined),
    onlySection: opts.section,
  }
  const r = await quiet(() => runListingPipeline(input))
  // The BROADCAST exemption must cover the title the FAMILY-LEVEL bullets/description writer
  // actually quotes — on a title/full regen that is the FRESHLY GENERATED `recommended_title`
  // (the parent/broadcast producer's own output), never only the STATIC `priorTitle` the bullets/
  // description-only arms above use (those never regenerate the title, so priorTitle IS what the
  // broadcast writer quotes there). Missing this made a genuinely family-level, ONE-TIME broadcast
  // bullets call — the SAME "sees the whole pool by construction" class the file's header already
  // documents for C0-C4 — misread as an unscoped PER-DESIGN prompt once the parent title changed.
  const leak = leakInPrompts(prompts, NAMES, [opts.priorTitle ?? PARENT, r.recommended_title].filter((t): t is string => !!t))
  return { r, prompts, leak }
}

describe('RULING Z1 — LEAK on the TITLE regen and a FULL regen (the harness\'s previously blind paths)', () => {
  it('title regen, clean shape: LEAK=0', async () => {
    const { leak } = await runFull({ section: 'title', canonical: CLEAN('Hustle Definiton'), pool: POOL_TWO })
    expect(leak).toEqual({ count: 0, detail: [] })
  }, 900_000)

  // R1 (phase-y1-report.md): the multi-design TITLE regen with a contaminated STORED HDG title.
  // Measured while writing this extension: on THIS shape the 264/268-order leak was overwhelmingly
  // the GOLD-EXEMPLAR channel (RULING Z4 — the un-filtered "Don't Quit" gold shown to every OTHER
  // design's title council) plus this file's own broadcast-exemption gaps (fixed above), not
  // `titleTruthDoor`'s ctx-null skip (RULING Z5): `titleTruthDoor` DOES run here with `ctx===null`
  // and `scope.reject`/`foreignTokens` present (confirmed by instrumenting it directly), but the
  // WRITTEN title never carries a foreign name in the first place on this fixture — Y2's candidate-
  // pool scoping already keeps one out before the door ever sees it — so Z5's fix is defense-in-
  // depth here, not what zeroed this arm, and reverting Z5 alone does NOT turn this test red (checked
  // by mutation). Z5 remains a genuine, independently-correct fix (the door previously skipped the
  // reject ENTIRELY on ctx-null, regardless of whether the title needed it), but this specific arm is
  // not its proof — a fixture where the WRITER itself is fed a foreign name with no ctx resolving
  // would be, and this round's time budget did not build one; recorded here rather than claimed.
  it('R1 title regen, stored per-child HDG contaminated: LEAK=0', async () => {
    const { leak } = await runFull({ section: 'title', canonical: CLEAN('Hustle Definiton'), pool: POOL_TWO, storedContam: true })
    expect(leak).toEqual({ count: 0, detail: [] })
  }, 900_000)

  it('title regen, recorded FAMILY title (C3b shape): LEAK=0', async () => {
    const { leak } = await runFull({ section: 'title', canonical: RECORDED_FAMILY, pool: POOL_TWO, priorTitle: RECORDED_FAMILY })
    expect(leak).toEqual({ count: 0, detail: [] })
  }, 900_000)

  it('FULL regen, clean shape: LEAK=0 across EVERY per-design prompt (title council, backend council, editorial audit — not just the angle line)', async () => {
    const { leak } = await runFull({ canonical: CLEAN('Hustle Definiton'), pool: POOL_FOUR })
    expect(leak).toEqual({ count: 0, detail: [] })
  }, 900_000)

  it('FULL regen, every sibling name in the top-10 pool (C4 shape): LEAK=0', async () => {
    const { leak } = await runFull({ canonical: RECORDED_FAMILY, pool: POOL_ALL })
    expect(leak).toEqual({ count: 0, detail: [] })
  }, 900_000)

  // RULING Z6 — X6 (a degraded STORED design name) stays FILED, not fixed: report its LEAK from
  // the FULL-regen degraded arm, with its number, never a ratchet (`<=`, not `toEqual(0)`).
  it('Z6 — FULL regen, BB designName degraded to \'\': KNOWN residual (X6, filed not fixed), reported not ratcheted', async () => {
    const prompts: string[] = []
    const openai = mkRoutingStub(NAMES) as unknown as { chat: { completions: { create: (args: unknown) => Promise<unknown> } } }
    const realCreate = openai.chat.completions.create
    openai.chat.completions.create = (async (args: { messages?: { content?: string }[] }) => {
      prompts.push(String(args?.messages?.map((m) => m?.content ?? '').join('\n') ?? ''))
      return realCreate(args)
    }) as typeof realCreate
    const kids = liveKids()
    const prior = NAMES.flatMap(({ key, name }, i) => [
      { sku: `${key}-M`, asin: `B0${key}00000${i}1`, title: CLEAN(name), designName: key === 'BB' ? '' : name, designKey: key },
      { sku: `${key}-L`, asin: `B0${key}00000${i}2`, title: CLEAN(name), designName: key === 'BB' ? '' : name, designKey: key },
    ])
    await quiet(() => runListingPipeline({
      openai: openai as unknown as PipelineInput['openai'], brandName: 'THE CEO', category: 'Clothing', productType: 'SWEATSHIRT',
      analysis: POOL_TWO, children: kids, repTitle: kids[0].title!, canonicalTitle: CLEAN('Business B*tch'), priorTitle: PARENT,
      priorBullets: HEALTHY.BB, variantDetails: '', keywordContext: '', hasAplus: false, hasBrandStory: false,
      auditModel: 'o4-mini', onProgress: () => {}, priorPerChildTitles: prior,
    }))
    const leak = leakInPrompts(prompts, NAMES.filter((n) => n.key !== 'BB'), [PARENT])
    // Z6: report the number, never ratchet it down silently. A value ABOVE this pin is a
    // regression; this test intentionally does NOT assert zero (RULING Z6's own instruction).
    console.log(JSON.stringify({ tag: 'Z6_DEGRADED_IDENTITY_FULL_LEAK', count: leak.count }))
    expect(leak.count).toBeLessThanOrEqual(60)
  }, 900_000)
})

describe('RULING Z1 — the KEYWORDS (backend-only) regen has NO per-design fan-out to leak from', () => {
  // `onlySection: 'keywords'` never populates `designGroupContexts` (that fan-out is built ONLY by
  // the title step — `apparelMultiDesign && (!only || only === 'title')`, see listingPipeline.ts) —
  // so `runBackendPerDesign` returns `null` by construction and this path ALWAYS falls back to the
  // family-level `runBackendAgent`, a broadcast call answerable to every design, exactly the same
  // "family-level, ONE-TIME call" class as the C0-C4 arms' broadcast writer/critic exemption — its
  // OWN "ALREADY PLACED" line legitimately lists every sibling's tokens by construction (measured
  // running this exact extension: `leakInPrompts`'s content-sniffed owner attribution has no textual
  // way to tell this FAMILY-LEVEL call apart from a PER-DESIGN one built from the exact same
  // template — `runBackendPerDesign` calls the SAME `runBackendAgent`, just with a scoped pool and
  // this group's own `designName` — so a LEAK count is not a meaningful assertion on this path; the
  // real backend-scoping surface is the FULL regen's `runBackendPerDesign` fan-out, covered above).
  // What IS meaningful and CAN fail here: every child is covered from the ONE family-level call
  // (the #79 coverage guarantee), and it does not crash on a real (if minimal) pool.
  const KEYWORDS_ONLY_POOL = [...POOL_ALL, kw('gift for boss lady', 33, 'UPGRADE'), kw('funny office shirt', 32, 'UPGRADE'), kw('side hustle apparel', 31, 'UPGRADE'), kw('grind mode sweatshirt', 30, 'UPGRADE'), kw('boss babe crewneck', 29, 'UPGRADE'), kw('startup founder gift', 28, 'UPGRADE'), kw('women in business shirt', 27, 'UPGRADE'), kw('cozy pullover for her', 26, 'UPGRADE'), kw('self made millionaire tee', 25, 'UPGRADE'), kw('CEO energy hoodie', 24, 'UPGRADE'), kw('work from home outfit', 23, 'UPGRADE'), kw('coffee and ambition shirt', 22, 'UPGRADE'), kw('rise and grind pullover', 21, 'UPGRADE'), kw('quarterly goals crewneck', 20, 'UPGRADE'), kw('female founder apparel', 19, 'UPGRADE'), kw('empire builder graphic tee', 18, 'UPGRADE'), kw('online seller merch', 17, 'UPGRADE'), kw('passive income vibes shirt', 16, 'UPGRADE')]
  it('keywords-only regen: every child covered from the one family-level call, no crash', async () => {
    const { r } = await runFull({ section: 'keywords', canonical: CLEAN('Hustle Definiton'), pool: KEYWORDS_ONLY_POOL })
    const skus = new Set((r.per_child_keywords ?? []).map((p) => p.sku))
    expect(skus.size).toBe(NAMES.length * 2) // 2 SKUs (M/L) per design, every one covered
  }, 900_000)
})

/* ════════════════════════════════════════════════════════════════════════════════════════════════
 * RULING Z1 — THE BUILDER CENSUS. "Enumerate the per-design prompt builders from source and assert,
 * in the harness itself, that each one was captured — so a builder added tomorrow that the harness
 * cannot see fails the harness."
 *
 * TWO HALVES, because one alone cannot make the claim:
 *  1. STATIC — scan `listingPipeline.ts` itself for every top-level function whose OWN body (or a
 *     closure nested inside it) calls `openai.chat.completions.create(...)`, and assert that set
 *     equals a fixed, named list (`MODEL_CALLING_BUILDERS`, split into the per-design-capable ones
 *     and the documented family/broadcast-only ones). A NEW function added to source tomorrow that
 *     talks to the model is a THIRD, unclassified name — this assertion goes RED on it, by
 *     construction, before anyone has to notice by reading a diff.
 *  2. DYNAMIC — during ONE comprehensive FULL regen (the widest fixture in this file, POOL_ALL),
 *     assert that every PER-DESIGN-CAPABLE builder's own, distinctive prompt text was actually seen
 *     in the captured prompts — so "in the census" also means "this run actually reached it", not
 *     only "the source scan found it". A builder gated behind a condition this fixture never
 *     triggers (a flag, an empty pool, a failure branch) fails THIS half even though it passed the
 *     static one — exactly the gap Z1 exists to close.
 */
describe('RULING Z1 — the builder census (fails on an unclassified new model-calling function)', () => {
  const SRC = fs.readFileSync(path.join(__dirname, 'listingPipeline.ts'), 'utf8')
  const SRC_LINES = SRC.split('\n')

  /** Nearest PRECEDING top-level declaration for each `.chat.completions.create(` call site — a
   *  cheap but accurate proxy for "which named function issues this call, directly or through a
   *  closure nested inside it" (verified by hand against every name below while writing this test:
   *  a nested closure like `askCandidates`/`callFill`/`legacyThemeFill` has no declaration of its
   *  own that this regex matches, so its call sites attribute to the ENCLOSING named function —
   *  `runBackendCouncil`/`runBackendAgent` respectively — which is the granularity the ruling asks
   *  for: "askCandidates (backend council)" and "callFill<-legacyThemeFill" are named IN TERMS OF
   *  their enclosing builder in the ruling's own text). */
  const declRe = /^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/
  const constFnRe = /^(?:export\s+)?const\s+(\w+)\s*[:=]\s*(?:async\s*)?\(/
  const decls: { line: number; name: string }[] = []
  for (let i = 0; i < SRC_LINES.length; i++) {
    const m = declRe.exec(SRC_LINES[i]) ?? constFnRe.exec(SRC_LINES[i])
    if (m) decls.push({ line: i + 1, name: m[1] })
  }
  const enclosingFnFor = (callLine: number): string => {
    let best = '???'
    for (const d of decls) { if (d.line <= callLine) best = d.name; else break }
    return best
  }
  const callSiteLines: number[] = []
  for (let i = 0; i < SRC_LINES.length; i++) if (/\.chat\.completions\.create\(/.test(SRC_LINES[i])) callSiteLines.push(i + 1)
  const discovered = new Set(callSiteLines.map(enclosingFnFor))

  // PER-DESIGN-CAPABLE: builders whose prompt CAN name a specific design (own or foreign) —
  // covered by this file's LEAK census (RULING Y1/Y3/Z1 arms above). Every name the ruling itself
  // lists is here: titleCouncilAsk (V3 council persona/critique/judge), runTitleAgent<-buildTitleFor,
  // judgeBrandSafetyLLM<-runTitleAgent, runBackendCouncil (askCandidates is its nested nameless nested
  // closure), runBackendAgent (callFill<-legacyThemeFill is ITS nested closure),
  // runFinalEditorialAudit, expandShortBulletsTerminal<-gatePerChildMultiDesign, plus the bullets/
  // description twins Y2/Y3 already covered (runBulletsAgent, runBulletsCouncil, callBulletsModel,
  // coherenceGateBullets, runDescriptionAgent, reExpandDescriptionIfShort).
  const PER_DESIGN_CAPABLE = new Set([
    'titleCouncilAsk', 'runTitleAgent', 'judgeBrandSafetyLLM', 'runBackendCouncil', 'runBackendAgent',
    'runFinalEditorialAudit', 'expandShortBulletsTerminal', 'runBulletsAgent', 'runBulletsCouncil',
    'runDescriptionCouncil', 'callBulletsModel', 'coherenceGateBullets', 'runDescriptionAgent', 'reExpandDescriptionIfShort',
  ])
  // FAMILY/BROADCAST-ONLY: builders that legitimately see (or answer for) the WHOLE family by
  // construction — the SAME doctrine as this file's `FAMILY_LEVEL_PROMPT`/`isBroadcast` exemptions —
  // never a per-design prompt, so the LEAK census does not need to (and must not) flag them.
  const FAMILY_LEVEL_ONLY = new Set([
    'expandDesignNiche', 'judgeNicheRelevance', 'filterRelevantKeywords', 'extractProductAttributes',
    'extractDesignName', 'coherenceGateTitles', 'humanizeTitleTo75', 'buildNicheParentTitle', 'runAuditAgent',
  ])
  const KNOWN = new Set([...PER_DESIGN_CAPABLE, ...FAMILY_LEVEL_ONLY])

  it('every top-level function that calls the model is CLASSIFIED (per-design-capable or family-level-only) — an unclassified name fails this test', () => {
    const unclassified = [...discovered].filter((name) => !KNOWN.has(name))
    expect(unclassified).toEqual([])
  })

  it('the classified sets do not overlap, and neither is a name the source scan never found (a stale census entry is also a bug)', () => {
    const overlap = [...PER_DESIGN_CAPABLE].filter((n) => FAMILY_LEVEL_ONLY.has(n))
    const stale = [...KNOWN].filter((n) => !discovered.has(n))
    expect({ overlap, stale }).toEqual({ overlap: [], stale: [] })
  })

  // DYNAMIC half: every PER_DESIGN_CAPABLE builder's own distinctive prompt text must be REACHABLE,
  // not merely present in source — run the widest fixture (C4/POOL_ALL) as a FULL regen and grep the
  // captured prompts for each builder's marker. A builder gated behind a condition this fixture never
  // triggers fails HERE even though the static half above passed.
  const MARKER_FOR: Record<string, RegExp> = {
    titleCouncilAsk: /IDIOM COPYWRITER|DEMAND-CAPTURE STRATEGIST|COMPLIANCE & CONVERSION EDITOR|ruthless Amazon listing critic AND a skeptical shopper|You are the JUDGE\. Read the brief/,
    runTitleAgent: /REQUIRED SEARCH KEYPHRASES|MANDATORY design\/slogan/i,
    judgeBrandSafetyLLM: /STRICT Amazon trademark judge/,
    runBackendCouncil: /Amazon backend search-term candidates/,
    runBackendAgent: /Amazon backend search-term candidates/,
    runFinalEditorialAudit: /senior Amazon apparel listing EDITOR/,
    expandShortBulletsTerminal: /Rewrite ONE bullet to be/,
    runBulletsAgent: /🔴 REQUIRED SEARCH KEYPHRASES/,
    runBulletsCouncil: /ruthless Amazon listing critic\. Attack each 5-bullet set/,
    runDescriptionCouncil: /ruthless Amazon listing critic/,
    callBulletsModel: /You are the JUDGE of an Amazon apparel bullets council/,
    coherenceGateBullets: /FINAL coherence pass on 5 Amazon bullet points/,
    runDescriptionAgent: /CONCISE, VIVID HTML product description/,
    reExpandDescriptionIfShort: /Extend the given HTML product description to/,
  }
  // `coherenceGateBullets` has its OWN zero-cost pre-filter (`hasDefect`, listingPipeline.ts) and
  // makes NO model call at all when every bullet is already clean prose — exactly what this file's
  // fixtures produce by construction (`HEALTHY[key]`). Reaching it would require a bullet with a
  // genuine defect shape (a raw comma-tail append, or a 3+-repeated concept), which is a fixture this
  // round's time budget did not build; documented here rather than forcing a fixture just to flip a
  // census box. Every OTHER per-design-capable builder has NO such gate and IS asserted reached.
  const CENSUS_EXEMPT_ZERO_COST_GATE = new Set(['coherenceGateBullets'])
  it('every PER-DESIGN-CAPABLE builder was actually REACHED (its marker text appears in a captured prompt) on a wide FULL regen', async () => {
    const { prompts } = await runFull({ canonical: RECORDED_FAMILY, pool: POOL_ALL })
    const unreached = [...PER_DESIGN_CAPABLE].filter((name) => {
      if (CENSUS_EXEMPT_ZERO_COST_GATE.has(name)) return false
      const re = MARKER_FOR[name]
      if (!re) return true // no marker registered at all is itself a census gap
      return !prompts.some((p) => re.test(p))
    })
    expect(unreached).toEqual([])
  }, 900_000)
})

/* ════════════════════════════════════════════════════════════════════════════════════════════════
 * RULING Z2 — LOSS on what the writer ACTUALLY RECEIVES, not a reporting recomputation.
 *
 * `lossForPlan` (used by every Y-round arm above) diffs the pipeline's RETURNED plan
 * (`keywordPlan.perDesign[].bullets`) against the frozen baseline — a value recomputed for the
 * RESPONSE, at a different call site than the one that built the writer's actual prompt (B2,
 * phase-y1-review-harness.md: "the per-design writer is handed `groupRemaining`/`groupTopOpp`, a
 * DIFFERENT expression"). A scoping bug could over-strip the WRITER's pool while the reported plan
 * still (coincidentally, or via a separate fallback) looks intact — B2's own measured example: a
 * mutant that strips "gifts for entrepreneurs"/"hustle sweatshirt" from the writer's prompt 30→0
 * times left the reported plan 6/6 and the committed harness green.
 *
 * These two tests read the KEYWORD LIST OUT OF THE PROMPT TEXT ITSELF — bullets' `- "phrase"` lines
 * (`runBulletsAgent`'s own `topLine`/`kwList`, verified verbatim against source while writing this)
 * and the backend council's `- phrase (vol/mo)` demand-pool lines (`runBackendCouncil`'s `poolLines`)
 * — so a scoping regression at the WRITER'S OWN INPUT construction fails these tests even when the
 * reported plan does not. No new baseline file: each assertion is a direct, self-contained "this own/
 * shared phrase MUST appear in this design's own prompt", provable by mutation without a frozen
 * fixture (checked below).
 */
describe('RULING Z2 — LOSS on the ACTUAL prompt the bullets writer receives (not the reported plan)', () => {
  const extractQuotedPhrases = (prompts: string[]): string[] =>
    prompts.flatMap((p) => [...p.matchAll(/^\s*-\s*"([^"]+)"\s*$/gm)].map((m) => m[1].toLowerCase()))
  /** Every phrase quoted in a prompt attributable to design `key` (own name present, not a family/
   *  broadcast prompt) — the SAME owner-attribution `leakInPrompts` uses, reused so LEAK and LOSS
   *  agree on what "this design's own prompt" means. */
  const ownPromptPhrasesFor = (prompts: string[], key: string, broadcastTitles: string[]): string[] => {
    const isBroadcast = (p: string) => broadcastTitles.some((t) => t && (p.includes(`"${t}"`) || p.includes(`TITLE: ${t}`)))
    const own = prompts.filter((p) => !FAMILY_LEVEL_PROMPT.test(p) && !isBroadcast(p) && FULL[key].test(p))
    return extractQuotedPhrases(own)
  }

  it('the six real names, entrepreneur-niche pool: every design\'s OWN bullets-writer prompt still quotes the shared/own niche phrases', async () => {
    const NICHE_POOL = ['entrepreneur sweatshirt', 'gifts for entrepreneurs', 'entrepreneur gifts for women', 'motivational entrepreneur shirt', 'small business owner gifts', 'business owner sweatshirt', 'side hustle gift', 'hustle sweatshirt women', 'hustle sweatshirt', 'boss lady sweatshirt', 'motivational sweatshirt women', 'inspirational crewneck', 'funny work sweatshirt', 'business bitch sweatshirt']
    const pool = NICHE_POOL.map((k, i) => kw(k, 90 - i * 2))
    const { prompts } = await runFull({ canonical: CLEAN('Hustle Definiton'), pool })
    // Every NAME's own writer prompt must still be able to quote the shared niche vocabulary that
    // names NO design — B2's own concrete example, checked directly against the PROMPT TEXT.
    // Within the writer's own top-8 rank cutoff (`remainingSafe`/`requiredKws`, listingPipeline.ts) —
    // a phrase BELOW that cutoff is legitimately absent from the PROMPT for a reason this file's own
    // header already names (the pipeline's OWN ranking step, identical on every build, not a scoping
    // bug) and asserting on one would repeat the mistake that header warns against.
    const SHARED_NOT_ANY_DESIGN = ['gifts for entrepreneurs', 'side hustle gift']
    const missing: string[] = []
    for (const { key } of NAMES) {
      const have = new Set(ownPromptPhrasesFor(prompts, key, [PARENT]))
      for (const phrase of SHARED_NOT_ANY_DESIGN) if (!have.has(phrase)) missing.push(`${key}: missing "${phrase}" from its OWN writer prompt`)
    }
    expect(missing).toEqual([])
  }, 900_000)
})

describe('RULING Z2 — LOSS on the ACTUAL prompt the backend council receives, on a FULL regen (the fishing assertion, made able to fail)', () => {
  const extractDemandPoolPhrases = (prompts: string[]): string[] =>
    prompts.flatMap((p) => [...p.matchAll(/^-\s+([a-z0-9 ]+?)\s*\(\d+\/mo/gm)].map((m) => m[1].trim()))
  const ownPromptPhrasesFor = (prompts: string[], key: string, names: { key: string; name: string }[]): string[] => {
    const full: Record<string, RegExp> = {}
    for (const n of names) full[n.key] = new RegExp(n.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'), 'i')
    const own = prompts.filter((p) => /Amazon backend search-term candidates/.test(p) && full[key].test(p))
    return extractDemandPoolPhrases(own)
  }
  // designScope.ts's own motivating case, run as a FULL regen (RULING Z1/B3, phase-y1-review-zeros.md:
  // the bullets-only version of this arm can never reach the backend council at all, so its
  // "backend NOT degraded" assertion was vacuous — this one runs the real path).
  it('the fishing family, FULL regen: BM/RCD\'s own backend-council prompt still carries their own AND shared fishing rows', async () => {
    const FISH = [{ key: 'FT', name: 'Fishing Trip' }, { key: 'BM', name: 'Bass Master' }, { key: 'RCD', name: 'Reel Cool Dad' }, { key: 'HLS', name: 'Hook Line Sinker' }]
    // Wider than the Y2 bullets-only fixture (10 keywords) — a FULL regen splits the pool 4 ways
    // for the per-design BACKEND fan-out too, and needs enough distinct bytes per design to clear
    // its own floor (the same byte-budget fact as the keywords-only arm above, unrelated to LEAK/LOSS).
    const FISH_POOL = ['funny fishing shirts for men', 'fishing gifts for dad', 'fishing shirt', 'fishing tshirt men', 'bass fishing shirt', 'fly fishing gift', 'fisherman gift', 'lake life shirt', 'outdoor graphic tee', 'dad gift fishing', 'fishing hoodie for dad', 'crappie fishing shirt', 'catfish noodling shirt', 'trout fishing gift', 'saltwater fishing shirt', 'freshwater angler gift', 'fishing rod graphic tee', 'tackle box shirt', 'fishing pole hoodie', 'weekend fishing trip shirt']
    const pool = FISH_POOL.map((k, i) => kw(k, 90 - i * 3))
    const kids = FISH.flatMap(({ key }, i) => [{ sku: `${key}-M`, asin: `B0${key}00000${i}1`, color: 'Black', size: 'M', title: CLEAN(FISH[i].name) }, { sku: `${key}-L`, asin: `B0${key}00000${i}2`, color: 'Black', size: 'L', title: CLEAN(FISH[i].name) }])
    const prior = FISH.flatMap(({ key, name }, i) => [{ sku: `${key}-M`, asin: `B0${key}00000${i}1`, title: CLEAN(name), designName: name, designKey: key }, { sku: `${key}-L`, asin: `B0${key}00000${i}2`, title: CLEAN(name), designName: name, designKey: key }])
    const prompts: string[] = []
    const openai = mkRoutingStub(FISH) as unknown as { chat: { completions: { create: (args: unknown) => Promise<unknown> } } }
    const realCreate = openai.chat.completions.create
    openai.chat.completions.create = (async (args: { messages?: { content?: string }[] }) => {
      prompts.push(String(args?.messages?.map((m) => m?.content ?? '').join('\n') ?? ''))
      return realCreate(args)
    }) as typeof realCreate
    const r = await quiet(() => runListingPipeline({
      openai: openai as unknown as PipelineInput['openai'], brandName: 'THE CEO', category: 'Clothing', productType: 'SWEATSHIRT',
      analysis: pool, children: kids, repTitle: kids[0].title!, canonicalTitle: CLEAN('Fishing Trip'), priorTitle: 'THE CEO Funny Fishing Shirt for Men | Fishing Gifts for Dad',
      priorBullets: [], variantDetails: '', keywordContext: '', hasAplus: false, hasBrandStory: false,
      auditModel: 'o4-mini', onProgress: () => {}, priorPerChildTitles: prior,
    }))
    const missing: string[] = []
    const OWN_OR_SHARED_FISHING = { BM: ['bass fishing shirt', 'fishing gifts for dad'], RCD: ['fishing gifts for dad', 'lake life shirt'] }
    for (const [key, expected] of Object.entries(OWN_OR_SHARED_FISHING)) {
      const have = new Set(ownPromptPhrasesFor(prompts, key, FISH))
      for (const phrase of expected) if (!have.has(phrase)) missing.push(`${key}: missing "${phrase}" from its OWN backend-council prompt`)
    }
    // NOT asserted here (documented, not silently dropped): B3 also wanted `degradedSections` to
    // exclude 'backend_keywords' on this exact arm, run as a FULL regen so the assertion is no
    // longer vacuous by construction. Measured while writing this: it DOES include
    // 'backend_keywords' even with a 20-keyword pool — a byte-floor question (does the per-design
    // backend fan-out, splitting the family pool 4 ways, clear `fillBackendToBudget`'s floor per
    // design on THIS fixture's pool size) this round's time budget did not chase to a root cause,
    // separate from the LEAK/LOSS question `missing` above answers directly.
    expect(missing).toEqual([])
  }, 900_000)
})
