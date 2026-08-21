/**
 * themeRatingRun.test.ts — the run-vs-failure seam + the credit-free rerate path.
 *
 * Zero network. The rater is injected (a fake `Rater`), OpenAI is a fake client handed to
 * rateThemeFit via ctx.openai, and Supabase is a recording chainable fake. The load-bearing
 * assertions: an all-null rating is a FAILURE (no run id, one THEME_RATE_FAILED), a 40% rating is a
 * run, a key-mismatched keyword is still matched, and rerateFromCache ARMS its guard BEFORE the
 * rater is invoked and writes ONLY the rows it rated.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ThemeBand } from './selection-core'
import { themeRatingKey, UNRATED_THEME_RUN_ID } from './selection-core'
import { rateThemeFit, type ThemeRating } from './themeRater'
import {
  rateWithRetry,
  rerateFromCache,
  rerateFromCachePerDesign,
  themeRatingAccepted,
  themeRunEpoch,
  rerateGuardKey,
  rerateDesignGuardKey,
  THEME_RATE_MIN_SHARE,
  THEME_RATE_MAX_ATTEMPTS,
  THEME_RERATE_COOLDOWN_MS,
  type Rater,
  type ThemeRateVerdict,
  type PerDesignRerateDeps,
} from './themeRatingRun'
import type { FamilyDesignGroups } from '@/lib/fba/familyDesignGroups'
import type { DesignGroupIdentity, DesignGroupLike } from '@/lib/fba/designGroupIdentity'

const FLAG = 'KEYWORD_TARGET_SET'
let savedFlag: string | undefined
let warnSpy: ReturnType<typeof vi.spyOn>
let logSpy: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  savedFlag = process.env[FLAG]
  process.env[FLAG] = 'shadow'
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => {
  if (savedFlag === undefined) delete process.env[FLAG]
  else process.env[FLAG] = savedFlag
  warnSpy.mockRestore()
  logSpy.mockRestore()
})

const CARD = 'Bass fishing angler humor graphic tee for men'
const KW10 = ['bass fishing shirt', 'fishing shirts for men', 'angler tee', 'huk shirts for men', 'salt life shirts',
  'fishing gifts for dad', 'largemouth bass tshirt', 'funny fishing shirt', 'fisherman gift', 'lake life shirt']

const rating = (band: number, about = 'anglers'): ThemeRating => ({ band: band as ThemeBand, about })

/** A fake rater that rates the first `n` of whatever it is asked (keyed by themeRatingKey). */
const ratesFirst = (n: number): Rater => async (keywords) =>
  new Map(keywords.slice(0, n).map((k) => [themeRatingKey(k), rating(3)]))

const failedLines = () => warnSpy.mock.calls.map((c: unknown[]) => String(c[0])).filter((s: string) => s.includes('THEME_RATE_FAILED'))
const resultLines = () => logSpy.mock.calls.map((c: unknown[]) => String(c[0])).filter((s: string) => s.includes('THEME_RATE_RESULT'))

describe('themeRatingAccepted — the run-vs-failure predicate', () => {
  it('threshold is 30% and is inclusive', () => {
    expect(THEME_RATE_MIN_SHARE).toBe(0.3)
    expect(themeRatingAccepted(10, 3)).toBe(true)
    expect(themeRatingAccepted(10, 2)).toBe(false)
    expect(themeRatingAccepted(103, 31)).toBe(true)
    expect(themeRatingAccepted(103, 30)).toBe(false)
  })
  it('ONE rated keyword out of 103 is NOT a run (the pre-fix `ratings.size > 0` contract)', () => {
    expect(themeRatingAccepted(103, 1)).toBe(false)
  })
  it('zero asked / zero rated is never a run', () => {
    expect(themeRatingAccepted(0, 0)).toBe(false)
    expect(themeRatingAccepted(5, 0)).toBe(false)
  })
})

describe('themeRunEpoch — completion evidence lives inside a real run id', () => {
  it('parses kt_<epoch>_<rand> and rejects the kt_unrated sentinel', () => {
    expect(themeRunEpoch('kt_1755777600000_ab12cd')).toBe(1755777600000)
    expect(themeRunEpoch(UNRATED_THEME_RUN_ID)).toBe(0)
    expect(themeRunEpoch(null)).toBe(0)
    expect(themeRunEpoch('garbage')).toBe(0)
  })
})

describe('rateWithRetry — all-null is a FAILURE, partial is a run, one bounded retry', () => {
  it('ALL-NULL: no run id, ratings null, exactly ONE THEME_RATE_FAILED, exactly TWO attempts', async () => {
    const rate = vi.fn(ratesFirst(0))
    const v = await rateWithRetry(KW10, CARD, { asin: 'B0DQ5YZH38' }, rate)
    expect(v.ratings).toBeNull()
    expect(v.themeRunId).toBeNull()
    expect(v.reason).toBe('below-threshold')
    expect(v.attempts).toBe(THEME_RATE_MAX_ATTEMPTS)
    expect(rate).toHaveBeenCalledTimes(2)
    expect(failedLines()).toHaveLength(1)
    const line = JSON.parse(failedLines()[0])
    expect(line).toMatchObject({ tag: 'THEME_RATE_FAILED', asin: 'B0DQ5YZH38', asked: 10, rated: 0, reason: 'below-threshold' })
  })

  it('PARTIAL 40%: accepted on the first attempt, run id minted, THEME_RATE_RESULT carries nullCount', async () => {
    const rate = vi.fn(ratesFirst(4))
    const v = await rateWithRetry(KW10, CARD, { asin: 'B0F6VTY79T' }, rate)
    expect(v.ratings?.size).toBe(4)
    expect(v.themeRunId).toMatch(/^kt_\d+_[a-z0-9]+$/)
    expect(v.reason).toBeNull()
    expect(v.attempts).toBe(1)
    expect(rate).toHaveBeenCalledTimes(1)
    expect(failedLines()).toHaveLength(0)
    expect(JSON.parse(resultLines()[0])).toMatchObject({ tag: 'THEME_RATE_RESULT', asin: 'B0F6VTY79T', asked: 10, rated: 4, nullCount: 6, attempts: 1 })
  })

  it('BELOW then ENOUGH: the retry asks ONLY the still-unrated keywords and the merged map is judged', async () => {
    const asked: string[][] = []
    const rate: Rater = async (keywords) => {
      asked.push([...keywords])
      return asked.length === 1
        ? new Map([[themeRatingKey('bass fishing shirt'), rating(3)], [themeRatingKey('angler tee'), rating(3)]]) // 2/10
        : new Map([[themeRatingKey(keywords[0]), rating(2)], [themeRatingKey(keywords[1]), rating(1)]])           // +2 ⇒ 4/10
    }
    const v = await rateWithRetry(KW10, CARD, { asin: 'X' }, rate)
    expect(asked).toHaveLength(2)
    expect(asked[1]).toHaveLength(8)
    expect(asked[1]).not.toContain('bass fishing shirt')
    expect(asked[1]).not.toContain('angler tee')
    expect(v.ratings?.size).toBe(4)
    expect(v.themeRunId).not.toBeNull()
    expect(v.attempts).toBe(2)
  })

  it('NO CARD: fails without calling the rater at all (nothing to retry against)', async () => {
    const rate = vi.fn(ratesFirst(10))
    const v = await rateWithRetry(KW10, null, { asin: 'X' }, rate)
    expect(rate).not.toHaveBeenCalled()
    expect(v).toMatchObject({ ratings: null, themeRunId: null, reason: 'no-card', attempts: 0 })
    expect(failedLines()).toHaveLength(1)
  })

  it('NO KEYWORDS: no call, no warn, no run', async () => {
    const rate = vi.fn(ratesFirst(10))
    const v = await rateWithRetry([], CARD, { asin: 'X' }, rate)
    expect(rate).not.toHaveBeenCalled()
    expect(v.reason).toBe('no-keywords')
    expect(failedLines()).toHaveLength(0)
  })

  it('KEY MISMATCH: a rating keyed on the normalized key is found for the SQP-cased / padded spelling', async () => {
    const v = await rateWithRetry(['Huk Shirts For Men ', 'salt  life shirts', 'bass fishing shirt'], CARD, { asin: 'X' }, ratesFirst(3))
    expect(v.ratings?.get(themeRatingKey('huk shirts for men'))?.band).toBe(3)
    expect(v.ratings?.get(themeRatingKey('Salt Life Shirts'))?.band).toBe(3)
    expect(v.ratings?.get('Huk Shirts For Men ')).toBeUndefined() // raw text is NOT a key
  })

  it('a rater reply carrying keys it was never asked is ignored (asked set is the contract)', async () => {
    const rate: Rater = async () => new Map([[themeRatingKey('unrelated phrase'), rating(3)], [themeRatingKey(KW10[0]), rating(3)]])
    const v = await rateWithRetry(KW10.slice(0, 3), CARD, { asin: 'X' }, rate)
    expect(v.ratings?.size).toBe(1)
    expect(v.ratings?.has(themeRatingKey('unrelated phrase'))).toBe(false)
  })
})

describe('rateThemeFit — output is keyed by themeRatingKey and de-duplicated on it', () => {
  /** Fake OpenAI: every persona rates every indexed row band 3. Records the keyword block it saw. */
  const fakeOpenAI = (seenBlocks: string[]) => ({
    chat: {
      completions: {
        create: async (body: { messages: { role: string; content: string }[] }) => {
          const user = body.messages.find((m) => m.role === 'user')?.content ?? ''
          const rows = user.split('\n').filter((l) => /^\d+: /.test(l))
          seenBlocks.push(rows.join('\n'))
          return { choices: [{ message: { content: JSON.stringify({ ratings: rows.map((_, i) => ({ i, f: 3, a: 'anglers' })) }) } }] }
        },
      },
    },
  })

  it('"Huk Shirts For Men" and "huk shirts for men " are ONE question and ONE normalized key', async () => {
    const seen: string[] = []
    const out = await rateThemeFit(['Huk Shirts For Men', 'huk shirts for men ', 'Salt Life Shirts'], CARD, {
      asin: 'X',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      openai: fakeOpenAI(seen) as any,
    })
    expect(seen[0].split('\n')).toHaveLength(2)       // de-duplicated before the prompt
    expect(out.size).toBe(2)
    expect([...out.keys()].sort()).toEqual(['huk shirts for men', 'salt life shirts'])
    expect(out.get(themeRatingKey('SALT LIFE SHIRTS'))?.band).toBe(3)
  })
})

/* ── rerateFromCache against a recording fake Supabase ──────────────────────────────────────── */

type Call = { table: string; op: string; filters: [string, ...unknown[]][]; payload?: unknown }
type Handler = (c: Call) => { data?: unknown; error?: { message: string } | null }

/** Chainable, thenable fake. Every filter/modifier returns the builder; awaiting it runs `handle`. */
function fakeSupabase(handle: Handler, calls: Call[]) {
  const from = (table: string) => {
    const call: Call = { table, op: 'select', filters: [] }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b: any = {}
    const chain = (name: string) => (...args: unknown[]) => { call.filters.push([name, ...args]); return b }
    for (const m of ['eq', 'in', 'or', 'not', 'limit', 'order', 'maybeSingle', 'single']) b[m] = chain(m)
    b.select = (cols?: string) => { if (call.op === 'select') call.filters.push(['select', cols]); return b }
    b.update = (payload: unknown) => { call.op = 'update'; call.payload = payload; return b }
    b.upsert = (payload: unknown, opts?: unknown) => { call.op = 'upsert'; call.payload = payload; call.filters.push(['upsert-opts', opts]); return b }
    b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => {
      calls.push(call)
      try { return Promise.resolve({ data: null, error: null, ...handle(call) }).then(res, rej) } catch (e) { return Promise.reject(e).then(res, rej) }
    }
    return b
  }
  return { from }
}

const NOW = 1_755_800_000_000
const POOL: { keyword: string; theme_fit: number | null; theme_run_id: string | null }[] = [
  { keyword: 'bass fishing shirt', theme_fit: null, theme_run_id: UNRATED_THEME_RUN_ID },
  { keyword: 'Huk Shirts For Men', theme_fit: null, theme_run_id: UNRATED_THEME_RUN_ID },
  { keyword: 'fishing gifts for dad', theme_fit: null, theme_run_id: UNRATED_THEME_RUN_ID },
]

/** Baseline handler: self-parented family B0DQ5YZH38, no guard stamp, the 3-row unrated pool. */
const baseHandler = (opts: { guardValue?: string | null; rows?: typeof POOL } = {}): Handler => (c) => {
  if (c.table === 'listing_content' && c.op === 'select') {
    const byAsin = c.filters.find((f) => f[0] === 'eq' && f[1] === 'asin')
    if (byAsin) return { data: { asin: 'B0DQ5YZH38', parent_asin: 'B0DQ5YZH38' } }
    return { data: [{ title: 'THE CEO Bass Fishing Shirt' }] }
  }
  if (c.table === 'keyword_analysis' && c.op === 'select') return { data: opts.rows ?? POOL }
  if (c.table === 'app_settings' && c.op === 'select') return { data: opts.guardValue ? { value: opts.guardValue } : null }
  if (c.table === 'listing_seo_scores') return { data: { product_title: 'THE CEO Bass Fishing Shirt', design_name_override: 'Bass Fishing', design_name_overrides: null, audience_lean: 'male' } }
  return { data: null }
}

const ratedVerdict = (keys: string[], band = 3): ThemeRateVerdict => ({
  ratings: new Map(keys.map((k) => [themeRatingKey(k), rating(band)])),
  themeRunId: `kt_${NOW}_abc123`,
  asked: 3, rated: keys.length, attempts: 1, reason: null,
})

describe('rerateFromCache — credit-free, guard armed BEFORE the rater, writes ONLY rated rows', () => {
  it('happy path: arms the guard before rating, updates exactly the rated keywords, re-stamps on completion', async () => {
    const calls: Call[] = []
    const events: string[] = []
    const db = fakeSupabase((c) => { if (c.table === 'app_settings' && c.op === 'upsert') events.push('arm'); return baseHandler()(c) }, calls)
    const rateFamily = vi.fn(async (input) => {
      events.push('rate')
      expect(input.keywords).toEqual(POOL.map((r) => r.keyword))
      expect(input.asin).toBe('B0DQ5YZH38')
      expect(input.scoreRow?.design_name_override).toBe('Bass Fishing')
      return ratedVerdict(['bass fishing shirt', 'huk shirts for men'])
    })
    const res = await rerateFromCache('b0dq5yzh38', { supabase: db, rateFamily, now: () => NOW })

    expect(res).toMatchObject({ poolKey: 'B0DQ5YZH38', status: 'rated', asked: 3, rated: 2, runId: `kt_${NOW}_abc123` })
    // Guard ORDER: armed before the rater ran, re-stamped after.
    expect(events).toEqual(['arm', 'rate', 'arm'])
    const arms = calls.filter((c) => c.table === 'app_settings' && c.op === 'upsert')
    expect(arms).toHaveLength(2)
    expect(arms[0].payload).toMatchObject({ key: rerateGuardKey('B0DQ5YZH38'), value: new Date(NOW).toISOString() })
    // Writes: UPDATE on keyword_analysis, exact stored spellings, numeric fits, the new run id — and
    // the unrated row ('fishing gifts for dad') is never touched.
    const writes = calls.filter((c) => c.table === 'keyword_analysis' && c.op === 'update')
    expect(writes).toHaveLength(1)
    expect(writes[0].payload).toEqual({ theme_fit: 3, theme_about: 'anglers', theme_run_id: `kt_${NOW}_abc123` })
    const inList = writes[0].filters.find((f) => f[0] === 'in')![2] as string[]
    expect(inList.sort()).toEqual(['Huk Shirts For Men', 'bass fishing shirt'])
    expect(writes[0].filters).toContainEqual(['eq', 'asin', 'B0DQ5YZH38'])
    // Credit safety: no keyword_cache, no research table, nothing but the four tables above.
    expect(new Set(calls.map((c) => c.table))).toEqual(new Set(['listing_content', 'keyword_analysis', 'app_settings', 'listing_seo_scores']))
  })

  it('COOLDOWN by completion evidence: a real run id < 10 min old in the rows ⇒ 409-shaped refusal, rater never called, guard untouched', async () => {
    const calls: Call[] = []
    const rows = POOL.map((r, i) => (i === 0 ? { ...r, theme_fit: 3, theme_run_id: `kt_${NOW - 5 * 60_000}_zz9` } : r))
    const rateFamily = vi.fn()
    const res = await rerateFromCache('B0DQ5YZH38', { supabase: fakeSupabase(baseHandler({ rows }), calls), rateFamily, now: () => NOW })
    expect(res.status).toBe('cooldown')
    expect(res.retryAfterMs).toBe(THEME_RERATE_COOLDOWN_MS - 5 * 60_000)
    expect(rateFamily).not.toHaveBeenCalled()
    expect(calls.some((c) => c.op === 'upsert' || c.op === 'update')).toBe(false)
  })

  it('COOLDOWN by the armed stamp: a killed in-flight rerate 2 min ago still blocks the next click', async () => {
    const calls: Call[] = []
    const rateFamily = vi.fn()
    const db = fakeSupabase(baseHandler({ guardValue: new Date(NOW - 2 * 60_000).toISOString() }), calls)
    const res = await rerateFromCache('B0DQ5YZH38', { supabase: db, rateFamily, now: () => NOW })
    expect(res.status).toBe('cooldown')
    expect(rateFamily).not.toHaveBeenCalled()
  })

  it('a stamp older than the window releases the guard', async () => {
    const calls: Call[] = []
    const db = fakeSupabase(baseHandler({ guardValue: new Date(NOW - THEME_RERATE_COOLDOWN_MS - 1).toISOString() }), calls)
    const res = await rerateFromCache('B0DQ5YZH38', { supabase: db, rateFamily: async () => ratedVerdict(POOL.map((r) => r.keyword)), now: () => NOW })
    expect(res.status).toBe('rated')
  })

  it('FAILED rating: guard armed, NO keyword_analysis write, status failed with the reason', async () => {
    const calls: Call[] = []
    const db = fakeSupabase(baseHandler(), calls)
    const res = await rerateFromCache('B0DQ5YZH38', {
      supabase: db, now: () => NOW,
      rateFamily: async () => ({ ratings: null, themeRunId: null, asked: 3, rated: 0, attempts: 2, reason: 'below-threshold' }),
    })
    expect(res).toMatchObject({ status: 'failed', asked: 3, rated: 0, runId: null, reason: 'below-threshold' })
    expect(calls.filter((c) => c.table === 'keyword_analysis' && c.op === 'update')).toHaveLength(0)
    expect(calls.filter((c) => c.table === 'app_settings' && c.op === 'upsert')).toHaveLength(1) // armed, not re-stamped
  })

  it('EMPTY pool: nothing armed, nothing rated', async () => {
    const calls: Call[] = []
    const rateFamily = vi.fn()
    const res = await rerateFromCache('B0DQ5YZH38', { supabase: fakeSupabase(baseHandler({ rows: [] }), calls), rateFamily, now: () => NOW })
    expect(res.status).toBe('empty')
    expect(rateFamily).not.toHaveBeenCalled()
    expect(calls.some((c) => c.op === 'upsert')).toBe(false)
  })

  it('a failed ARM refuses to rate (never unguarded)', async () => {
    const calls: Call[] = []
    const rateFamily = vi.fn()
    const db = fakeSupabase((c) => (c.table === 'app_settings' && c.op === 'upsert' ? { error: { message: 'rls' } } : baseHandler()(c)), calls)
    await expect(rerateFromCache('B0DQ5YZH38', { supabase: db, rateFamily, now: () => NOW })).rejects.toThrow(/guard could not be armed/)
    expect(rateFamily).not.toHaveBeenCalled()
  })
})

/* ── rerateFromCachePerDesign — ONE card per DESIGN, theme_fit_by_design merged for rated rows only ── */

type RpcCall = { fn: string; args: Record<string, unknown> }
/** The recording fake + an `rpc` seam (migration 061's merge function). */
function fakeSupabaseRpc(handle: Handler, calls: Call[], rpcs: RpcCall[], rpcResult: { data?: unknown; error?: { message: string } | null } = { data: 2 }) {
  const base = fakeSupabase(handle, calls)
  return { ...base, rpc: async (fn: string, args: Record<string, unknown>) => { rpcs.push({ fn, args }); return { data: null, error: null, ...rpcResult } } }
}

const DESIGN_POOL: { keyword: string; theme_run_by_design: Record<string, string> | null }[] = [
  { keyword: 'motivational shirts women', theme_run_by_design: null },
  { keyword: 'Graphic Tees For Men', theme_run_by_design: null },
  { keyword: 'real king crown tee', theme_run_by_design: null },
]
const FAMILY: FamilyDesignGroups = {
  isMultiDesign: true,
  audienceLean: 'male',
  productTitle: 'THE CEO Motivational Shirts',
  groups: [
    { key: 'BM', skus: [{ sku: 'BM64000L-BK', asin: 'B0BM000001' }], sellerName: 'Beast Mode', resolvedName: 'Beast Mode', titles: ['THE CEO Beast Mode Shirt'] },
    { key: 'RK', skus: [{ sku: 'RK64000L-BK', asin: 'B0RK000001' }], sellerName: null, resolvedName: 'Real King', titles: ['THE CEO Real King Graffiti Shirt'] },
    { key: 'DQ', skus: [{ sku: 'DQ64000L-BK', asin: 'B0DQ000001' }], sellerName: null, resolvedName: "Don't Quit", titles: [] },
  ],
}
const identityFor = (withIdentity: string[]) => async (g: DesignGroupLike): Promise<DesignGroupIdentity> =>
  withIdentity.includes(g.key)
    ? { key: g.key, repAsin: g.skus[0].asin, imageUrl: null, identity: { designTheme: `${g.key} theme`, visualElements: [], seedKeywords: [] } as unknown as DesignGroupIdentity['identity'] }
    : { key: g.key, repAsin: null, imageUrl: null, identity: null }

const designHandler = (opts: { rows?: typeof DESIGN_POOL; guard?: Record<string, string> } = {}): Handler => (c) => {
  if (c.table === 'listing_content' && c.op === 'select') {
    const byAsin = c.filters.find((f) => f[0] === 'eq' && f[1] === 'asin')
    if (byAsin) return { data: { asin: 'B0DQ5YZH38', parent_asin: 'B0DQ5YZH38' } }
    return { data: [] }
  }
  if (c.table === 'keyword_analysis' && c.op === 'select') return { data: opts.rows ?? DESIGN_POOL }
  if (c.table === 'app_settings' && c.op === 'select') {
    const key = c.filters.find((f) => f[0] === 'eq' && f[1] === 'key')?.[2] as string
    const v = opts.guard?.[key]
    return { data: v ? { value: v } : null }
  }
  return { data: null }
}

type CardCtx = Parameters<NonNullable<PerDesignRerateDeps['buildCard']>>[0]

describe('rerateFromCachePerDesign — per-design cards, per-(pool, design) guard, rated rows only, no-card skipped', () => {
  it('rates each identity-bearing design against ITS OWN card, merges only the rated rows, skips the no-identity design as no-card', async () => {
    const calls: Call[] = []; const rpcs: RpcCall[] = []; const cards: CardCtx[] = []
    const db = fakeSupabaseRpc(designHandler(), calls, rpcs)
    const rate: Rater = async (keywords, card) => {
      // BM's card rates everything 3 except the RK-named phrase; RK's card rates the women phrase 1.
      const m = new Map<string, ThemeRating>()
      for (const k of keywords) {
        const key = themeRatingKey(k)
        if (card?.startsWith('BM')) { if (key !== 'real king crown tee') m.set(key, rating(3, 'gym')) }
        else m.set(key, rating(key === 'motivational shirts women' ? 1 : 3, 'kings'))
      }
      return m
    }
    const res = await rerateFromCachePerDesign('b0dq5yzh38', {
      supabase: db, now: () => NOW, loadGroups: async () => FAMILY, readIdentity: identityFor(['BM', 'RK']),
      buildCard: async (ctx) => { cards.push(ctx); return `${ctx.asin?.split(':')[1]} card` }, rate,
    })
    expect(res.status).toBe('rated')
    expect(res.groups.map((g) => [g.designKey, g.status])).toEqual([['BM', 'rated'], ['RK', 'rated'], ['DQ', 'no-card']])
    // Cards: one per rated design, from the design's OWN signals, NEVER persisted to the family row.
    expect(cards).toHaveLength(2)
    expect(cards[0]).toMatchObject({ asin: 'B0DQ5YZH38:BM', parentAsin: null, designNameOverride: 'Beast Mode', visionDesignTheme: 'BM theme', supabase: null, audienceLean: 'male' })
    expect(cards[1]).toMatchObject({ asin: 'B0DQ5YZH38:RK', designNameOverride: null, resolvedDesignName: 'Real King', visionDesignTheme: 'RK theme', supabase: null })
    // Merges: ONE rpc per rated design, exact stored spellings, ONLY the rated rows.
    expect(rpcs).toHaveLength(2)
    expect(rpcs[0].fn).toBe('merge_theme_fit_by_design')
    expect(rpcs[0].args).toMatchObject({ p_asin: 'B0DQ5YZH38', p_design_key: 'BM' })
    expect(rpcs[0].args.p_ratings).toEqual({ 'motivational shirts women': { fit: 3, about: 'gym' }, 'Graphic Tees For Men': { fit: 3, about: 'gym' } })
    expect(rpcs[1].args.p_design_key).toBe('RK')
    expect((rpcs[1].args.p_ratings as Record<string, { fit: number }>)['motivational shirts women'].fit).toBe(1)
    expect(String(rpcs[0].args.p_run_id)).toMatch(/^kt_\d+_[a-z0-9]+$/)
    expect(rpcs[0].args.p_run_id).not.toBe(rpcs[1].args.p_run_id)
    // The family-level theme_fit is NEVER written (no keyword_analysis UPDATE at all).
    expect(calls.filter((c) => c.table === 'keyword_analysis' && c.op === 'update')).toHaveLength(0)
    // Guards: armed + completion-stamped per (pool, design); the no-card design is never armed.
    const arms = calls.filter((c) => c.table === 'app_settings' && c.op === 'upsert').map((c) => (c.payload as { key: string }).key)
    expect(arms).toEqual([rerateDesignGuardKey('B0DQ5YZH38', 'BM'), rerateDesignGuardKey('B0DQ5YZH38', 'BM'), rerateDesignGuardKey('B0DQ5YZH38', 'RK'), rerateDesignGuardKey('B0DQ5YZH38', 'RK')])
    expect(arms).not.toContain(rerateGuardKey('B0DQ5YZH38'))   // the FAMILY guard is untouched
    expect(res.groups[0]).toMatchObject({ asked: 3, rated: 2, written: 2 })
    expect(res.groups[2]).toMatchObject({ status: 'no-card', reason: 'no-card', rated: 0, runId: null })
    // Credit safety: nothing but these tables + the merge function.
    expect(new Set(calls.map((c) => c.table))).toEqual(new Set(['listing_content', 'keyword_analysis', 'app_settings']))
    const lines = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).filter((s: string) => s.includes('THEME_RERATE_DESIGN'))
    expect(JSON.parse(lines[0])).toMatchObject({ tag: 'THEME_RERATE_DESIGN', parent: 'B0DQ5YZH38', designKey: 'BM', asked: 3, rated: 2 })
  })

  it('the guard is per (pool, design): a design rated 5 min ago is refused while its siblings still rate', async () => {
    const calls: Call[] = []; const rpcs: RpcCall[] = []
    const rows = DESIGN_POOL.map((r, i) => (i === 0 ? { ...r, theme_run_by_design: { BM: `kt_${NOW - 5 * 60_000}_zz9` } } : r))
    const db = fakeSupabaseRpc(designHandler({ rows }), calls, rpcs)
    const rate = vi.fn(ratesFirst(3))
    const res = await rerateFromCachePerDesign('B0DQ5YZH38', {
      supabase: db, now: () => NOW, loadGroups: async () => FAMILY, readIdentity: identityFor(['BM', 'RK']), buildCard: async () => 'card', rate,
    })
    expect(res.groups.map((g) => [g.designKey, g.status])).toEqual([['BM', 'cooldown'], ['RK', 'rated'], ['DQ', 'no-card']])
    expect(res.groups[0].retryAfterMs).toBe(THEME_RERATE_COOLDOWN_MS - 5 * 60_000)
    expect(rate).toHaveBeenCalledTimes(1)
    expect(rpcs.map((r) => r.args.p_design_key)).toEqual(['RK'])
  })

  it('the ARMED stamp of one design blocks only that design', async () => {
    const calls: Call[] = []; const rpcs: RpcCall[] = []
    const db = fakeSupabaseRpc(designHandler({ guard: { [rerateDesignGuardKey('B0DQ5YZH38', 'RK')]: new Date(NOW - 60_000).toISOString() } }), calls, rpcs)
    const res = await rerateFromCachePerDesign('B0DQ5YZH38', {
      supabase: db, now: () => NOW, loadGroups: async () => FAMILY, readIdentity: identityFor(['BM', 'RK']), buildCard: async () => 'card', rate: ratesFirst(3),
    })
    expect(res.groups.map((g) => [g.designKey, g.status])).toEqual([['BM', 'rated'], ['RK', 'cooldown'], ['DQ', 'no-card']])
  })

  it('a design whose raters judge < 30% FAILS: armed, nothing merged, siblings unaffected', async () => {
    const calls: Call[] = []; const rpcs: RpcCall[] = []
    const db = fakeSupabaseRpc(designHandler(), calls, rpcs)
    const rate: Rater = async (keywords, card) => (card === 'RK card' ? new Map() : new Map(keywords.map((k) => [themeRatingKey(k), rating(2)])))
    const res = await rerateFromCachePerDesign('B0DQ5YZH38', {
      supabase: db, now: () => NOW, loadGroups: async () => FAMILY, readIdentity: identityFor(['BM', 'RK']), buildCard: async (ctx) => `${ctx.asin?.split(':')[1]} card`, rate,
    })
    expect(res.status).toBe('rated')
    expect(res.groups.map((g) => [g.designKey, g.status])).toEqual([['BM', 'rated'], ['RK', 'failed'], ['DQ', 'no-card']])
    expect(res.groups[1].reason).toBe('below-threshold')
    expect(rpcs.map((r) => r.args.p_design_key)).toEqual(['BM'])
  })

  it('NO design has an identity ⇒ none-rated, zero cards, zero rater calls, nothing armed', async () => {
    const calls: Call[] = []; const rpcs: RpcCall[] = []
    const buildCard = vi.fn(async () => 'card'); const rate = vi.fn(ratesFirst(3))
    const res = await rerateFromCachePerDesign('B0DQ5YZH38', {
      supabase: fakeSupabaseRpc(designHandler(), calls, rpcs), now: () => NOW, loadGroups: async () => FAMILY, readIdentity: identityFor([]), buildCard, rate,
    })
    expect(res.status).toBe('none-rated')
    expect(res.groups.every((g) => g.status === 'no-card')).toBe(true)
    expect(buildCard).not.toHaveBeenCalled(); expect(rate).not.toHaveBeenCalled()
    expect(calls.some((c) => c.op === 'upsert')).toBe(false); expect(rpcs).toHaveLength(0)
  })

  it('not a multi-design family ⇒ not-multi-design, nothing rated', async () => {
    const calls: Call[] = []; const rpcs: RpcCall[] = []
    const rate = vi.fn(ratesFirst(3))
    const res = await rerateFromCachePerDesign('B0DQ5YZH38', {
      supabase: fakeSupabaseRpc(designHandler(), calls, rpcs), now: () => NOW, loadGroups: async () => ({ ...FAMILY, isMultiDesign: false }), readIdentity: identityFor(['BM']), rate,
    })
    expect(res).toMatchObject({ status: 'not-multi-design', groups: [] })
    expect(rate).not.toHaveBeenCalled()
  })

  it('a merge failure (migration 061 missing) throws and names the migration', async () => {
    const calls: Call[] = []; const rpcs: RpcCall[] = []
    const db = fakeSupabaseRpc(designHandler(), calls, rpcs, { error: { message: 'function merge_theme_fit_by_design does not exist' } })
    await expect(rerateFromCachePerDesign('B0DQ5YZH38', {
      supabase: db, now: () => NOW, loadGroups: async () => FAMILY, readIdentity: identityFor(['BM']), buildCard: async () => 'card', rate: ratesFirst(3),
    })).rejects.toThrow(/migration 061/)
  })
})
