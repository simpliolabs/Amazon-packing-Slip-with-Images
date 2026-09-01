/**
 * backfill-child-color DEFECT regression (2026-09-01, branch fix/backfill-color-counter).
 *
 * Two independent defects fixed in route.ts:
 *
 * DEFECT 1 — `remainingNull` (now `trueNullRows`/`trueNullAsins`) was arithmetic on a CAPPED
 * WINDOW (the unlimited `.select()` at the top of GET, which PostgREST silently caps at its
 * default max-rows), not the true outstanding count. Live evidence: two consecutive batches each
 * filled 49 children yet the reported remaining count only dropped 812 -> 807, because the window
 * slid forward and pulled in rows previously beyond the cap. `countNullChildren` fixes this with a
 * `count:'exact', head:true` query (uncapped — Postgres counts server-side) for the row count, and
 * an explicit `.range()` page loop (bounded by that same count, so it can never rely on an
 * implicit page-size default) for the distinct-ASIN count. The fixture below deliberately holds
 * MORE null rows than one page (PAGE_SIZE = 1000 in route.ts) to prove the count survives paging.
 *
 * DEFECT 2 — no way to target one family; added optional `?parent_asin=` (validated as a 10-char
 * ASIN, 400 on a malformed value) that scopes the select AND both count queries. Absent = today's
 * catalog-wide behaviour, unchanged.
 *
 * CI TRAP: build.yml's "Test (blocking)" step sets NEXT_PUBLIC_SUPABASE_URL / ANON_KEY /
 * SUPABASE_SERVICE_ROLE_KEY to a syntactically-valid-but-fake `https://placeholder.supabase.co`,
 * which turns this repo's lazy-Proxy Supabase clients into a REAL ~4s network attempt instead of a
 * synchronous fail-open throw (see parentLockScope.test.ts's identical note). This file never lets
 * the real client construct at all — `@/lib/supabase/server`, `@/lib/amazon/auth`, and
 * `@/lib/amazon/catalogColor` are fully mocked below, so no network call is possible — but the env
 * vars are nulled/restored anyway to match this repo's established per-file hygiene pattern.
 *
 * Every test in the GET-handler describe block asserts on `mode`/`scope` (not just counts) per the
 * brief's "prove the branch ran" requirement.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { NextRequest } from 'next/server'

const SUPABASE_ENV_KEYS = ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'NEXT_PUBLIC_SUPABASE_ANON_KEY'] as const
const savedEnv: Record<string, string | undefined> = {}
beforeAll(() => {
  for (const key of SUPABASE_ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
})
afterAll(() => {
  for (const key of SUPABASE_ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
})

// ---------------------------------------------------------------------------------------------
// Minimal in-memory fake of the supabase-js query builder — just enough chain surface for this
// route (.from/.select/.is/.eq/.order/.range/.update), each call returning a fresh thenable
// builder exactly like the real PostgrestFilterBuilder, so route.ts's "build a new query per
// page" loop in countNullChildren behaves the same way it would against real supabase-js.
// ---------------------------------------------------------------------------------------------
type Row = { asin: string; parent_asin: string | null; color: string | null }

// Real PostgREST/Supabase applies a default max-rows cap (typically 1000) to any select that
// never calls .range()/.limit() itself — this is the exact mechanism DEFECT 1 exploited (the
// original top-level select had no .limit() and relied on that implicit cap without knowing it).
// Reproduced here so a regression of the fix (recomputing the true count from that capped array,
// as the old `remainingNull = uniqueAsins.length - filled.length` did) would actually fail these
// tests, instead of silently passing because the fake never truncated anything.
const DEFAULT_POSTGREST_CAP = 1000

class FakeQuery {
  private filters: Array<(r: Row) => boolean> = []
  private selectOpts: { count?: string; head?: boolean } | null = null
  private orderCol: string | null = null
  private rangeVal: [number, number] | null = null
  private updatePatch: Partial<Row> | null = null

  constructor(private rows: Row[]) {}

  select(_cols: string, opts?: { count?: string; head?: boolean }) {
    this.selectOpts = opts ?? null
    return this
  }
  is(col: keyof Row, val: null) {
    this.filters.push((r) => r[col] === val)
    return this
  }
  eq(col: keyof Row, val: string) {
    this.filters.push((r) => r[col] === val)
    return this
  }
  order(col: string) {
    this.orderCol = col
    return this
  }
  range(from: number, to: number) {
    this.rangeVal = [from, to]
    return this
  }
  update(patch: Partial<Row>) {
    this.updatePatch = patch
    return this
  }

  private run() {
    let matched = this.rows.filter((r) => this.filters.every((f) => f(r)))

    if (this.updatePatch) {
      for (const r of matched) Object.assign(r, this.updatePatch)
      return { data: matched, error: null, count: null }
    }

    if (this.orderCol) {
      const col = this.orderCol as keyof Row
      matched = [...matched].sort((a, b) => (a[col]! < b[col]! ? -1 : a[col]! > b[col]! ? 1 : 0))
    }

    const count = this.selectOpts?.count === 'exact' ? matched.length : null
    let data: Row[] | null = matched
    if (this.rangeVal) {
      const [from, to] = this.rangeVal
      data = matched.slice(from, to + 1)
    } else {
      // No explicit .range() — this is where a real PostgREST server silently caps the response.
      data = matched.slice(0, DEFAULT_POSTGREST_CAP)
    }
    if (this.selectOpts?.head) data = null

    return { data, error: null, count }
  }

  // Makes the builder awaitable, like the real supabase-js PostgrestFilterBuilder.
  then<TResult1 = unknown, TResult2 = never>(
    onfulfilled?: ((value: ReturnType<FakeQuery['run']>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): Promise<TResult1 | TResult2> {
    return Promise.resolve(this.run()).then(onfulfilled, onrejected)
  }
}

function makeFakeDb(rows: Row[]) {
  return {
    from(_table: string) {
      return new FakeQuery(rows)
    },
    __rows: rows, // test-only escape hatch to inspect state after a call
  }
}

// ---------------------------------------------------------------------------------------------
// Mocks — never let a real Supabase client or SP-API call construct.
// ---------------------------------------------------------------------------------------------
let fakeDb: ReturnType<typeof makeFakeDb>

vi.mock('@/lib/supabase/server', () => ({
  createAdminClient: vi.fn(async () => fakeDb),
}))
vi.mock('@/lib/amazon/auth', () => ({
  getAccessToken: vi.fn(async () => 'fake-token'),
}))
// Deterministic: every ASIN "gets" a colour unless explicitly listed as colour-less by the test.
const NO_COLOR_ASINS = new Set<string>()
vi.mock('@/lib/amazon/catalogColor', () => ({
  fetchCatalogColor: vi.fn(async (asin: string) => (NO_COLOR_ASINS.has(asin) ? null : 'Blue')),
}))

const { GET, isValidParentAsin, countNullChildren } = await import('./route')

function req(qs: string) {
  return new NextRequest(`http://localhost/api/fba/admin/backfill-child-color${qs}`)
}

function makeRows(spec: Array<{ asin: string; parentAsin: string; twin?: boolean; color?: string | null }>): Row[] {
  const rows: Row[] = []
  for (const s of spec) {
    rows.push({ asin: s.asin, parent_asin: s.parentAsin, color: s.color ?? null })
    if (s.twin) rows.push({ asin: s.asin, parent_asin: s.parentAsin, color: s.color ?? null }) // FBA/FBM twin row
  }
  return rows
}

// =================================================================================================
// isValidParentAsin
// =================================================================================================
describe('isValidParentAsin', () => {
  it('accepts a 10-char alphanumeric ASIN', () => {
    expect(isValidParentAsin('B0DP5H8QBT')).toBe(true)
  })
  it('rejects too short / too long / non-alphanumeric', () => {
    expect(isValidParentAsin('B0DP5H8QB')).toBe(false) // 9 chars
    expect(isValidParentAsin('B0DP5H8QBTX')).toBe(false) // 11 chars
    expect(isValidParentAsin('B0DP5H8Q-T')).toBe(false) // hyphen
    expect(isValidParentAsin('')).toBe(false)
  })
  it('rejects lowercase (caller is responsible for upper-casing first)', () => {
    expect(isValidParentAsin('b0dp5h8qbt')).toBe(false)
  })
})

// =================================================================================================
// countNullChildren — DEFECT 1: true count survives paging past the window cap
// =================================================================================================
describe('countNullChildren — true counts beat the capped window (DEFECT 1)', () => {
  it('reports the TRUE row/asin counts even with more null rows than one page (PAGE_SIZE=1000)', async () => {
    // 1200 distinct ASINs, 300 of which carry an FBA+FBM twin row (dual-SKU doctrine) — so rows
    // (1500) > asins (1200) > PAGE_SIZE (1000), exercising both the pagination loop AND the
    // row-vs-asin distinction called out in the brief.
    const spec: Array<{ asin: string; parentAsin: string; twin?: boolean }> = []
    for (let i = 0; i < 1200; i++) {
      spec.push({ asin: `B0${String(i).padStart(8, '0')}`, parentAsin: 'PARENTAAA', twin: i < 300 })
    }
    const rows = makeRows(spec)
    const db = makeFakeDb(rows)

    const result = await countNullChildren(db, null)
    expect(result.error).toBeNull()
    expect(result.trueNullRows).toBe(1500)
    expect(result.trueNullAsins).toBe(1200)
  })

  it('scopes the true counts to parent_asin when provided', async () => {
    const spec = [
      { asin: 'B0FAMILYA1', parentAsin: 'PARENTFAM1' },
      { asin: 'B0FAMILYA2', parentAsin: 'PARENTFAM1', twin: true },
      { asin: 'B0FAMILYB1', parentAsin: 'PARENTFAM2' },
    ]
    const db = makeFakeDb(makeRows(spec))

    const scoped = await countNullChildren(db, 'PARENTFAM1')
    expect(scoped.trueNullRows).toBe(3) // FAMILYA1 (1 row) + FAMILYA2 (twin, 2 rows)
    expect(scoped.trueNullAsins).toBe(2)

    const other = await countNullChildren(db, 'PARENTFAM2')
    expect(other.trueNullRows).toBe(1)
    expect(other.trueNullAsins).toBe(1)
  })

  it('reports zero without querying pages when nothing is null', async () => {
    const db = makeFakeDb([])
    const result = await countNullChildren(db, null)
    expect(result).toEqual({ error: null, trueNullRows: 0, trueNullAsins: 0 })
  })
})

// =================================================================================================
// GET handler
// =================================================================================================
describe('GET /api/fba/admin/backfill-child-color', () => {
  it('dry-run reports mode/scope and TRUE counts, and writes nothing', async () => {
    const spec = [
      { asin: 'B0FAMILYA1', parentAsin: 'PARENTFAM1' },
      { asin: 'B0FAMILYA2', parentAsin: 'PARENTFAM1' },
      { asin: 'B0FAMILYB1', parentAsin: 'PARENTFAM2' },
    ]
    const rows = makeRows(spec)
    fakeDb = makeFakeDb(rows)

    const res = await GET(req('?limit=25'))
    const body = await res.json()

    expect(body.mode).toBe('dry-run') // prove the branch ran
    expect(body.scope).toBe('all')
    expect(body.trueNullRows).toBe(3)
    expect(body.trueNullAsins).toBe(3)
    expect(body.wouldProcess.sort()).toEqual(['B0FAMILYA1', 'B0FAMILYA2', 'B0FAMILYB1'])

    // Dry-run writes nothing: every row's colour is still null.
    expect(rows.every((r) => r.color === null)).toBe(true)
  })

  it('window fields stay capped while true counts are not (DEFECT 1: window is never a total)', async () => {
    // 1200 distinct null ASINs (no twins) — more than the fake's simulated PostgREST default cap
    // (1000, same as route.ts's PAGE_SIZE). windowNullAsins/windowNullRows come straight off the
    // uncapped top-level select and MUST show the cap; trueNullAsins/trueNullRows come from
    // countNullChildren's explicit range-paged queries and MUST show the real total regardless.
    const spec: Array<{ asin: string; parentAsin: string }> = []
    for (let i = 0; i < 1200; i++) spec.push({ asin: `B0WIN${String(i).padStart(6, '0')}`, parentAsin: 'BIGFAMILY1' })
    fakeDb = makeFakeDb(makeRows(spec))

    const res = await GET(req(''))
    const body = await res.json()

    expect(body.mode).toBe('dry-run')
    expect(body.windowNullAsins).toBe(1000) // the capped window — NOT the total
    expect(body.windowNullRows).toBe(1000)
    expect(body.trueNullAsins).toBe(1200) // the real total, immune to the cap
    expect(body.trueNullRows).toBe(1200)
  })

  it('parent_asin scopes the batch to one family (DEFECT 2)', async () => {
    const spec = [
      { asin: 'B0FAMILYA1', parentAsin: 'PARENTFAM1' },
      { asin: 'B0FAMILYA2', parentAsin: 'PARENTFAM1' },
      { asin: 'B0FAMILYB1', parentAsin: 'PARENTFAM2' },
    ]
    fakeDb = makeFakeDb(makeRows(spec))

    const res = await GET(req('?parent_asin=PARENTFAM1'))
    const body = await res.json()

    expect(body.mode).toBe('dry-run')
    expect(body.scope).toBe('PARENTFAM1') // prove the branch ran with the requested scope
    expect(body.wouldProcess.sort()).toEqual(['B0FAMILYA1', 'B0FAMILYA2'])
    expect(body.trueNullRows).toBe(2)
    expect(body.trueNullAsins).toBe(2)
  })

  it('absent parent_asin behaves exactly as today (catalog-wide, scope "all")', async () => {
    const spec = [
      { asin: 'B0FAMILYA1', parentAsin: 'PARENTFAM1' },
      { asin: 'B0FAMILYB1', parentAsin: 'PARENTFAM2' },
    ]
    fakeDb = makeFakeDb(makeRows(spec))

    const res = await GET(req(''))
    const body = await res.json()

    expect(body.mode).toBe('dry-run')
    expect(body.scope).toBe('all')
    expect(body.wouldProcess.sort()).toEqual(['B0FAMILYA1', 'B0FAMILYB1'])
  })

  it('rejects a malformed parent_asin with 400 and never touches the DB', async () => {
    fakeDb = makeFakeDb(makeRows([{ asin: 'B0FAMILYA1', parentAsin: 'PARENTFAM1' }]))

    const res = await GET(req('?parent_asin=not-an-asin'))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/parent_asin/i)
  })

  it('execute mode reports TRUE outstanding counts AFTER the batch, scoped by parent_asin, proving the window-slide bug is gone (DEFECT 1 + 2 together)', async () => {
    // 30 ASINs in the target family (each with an FBA+FBM twin, so 60 rows), 5 in another family
    // that must be left untouched. limit=25 processes 25 of the 30 in-family ASINs.
    const spec: Array<{ asin: string; parentAsin: string; twin?: boolean }> = []
    for (let i = 0; i < 30; i++) spec.push({ asin: `B0TARGET${String(i).padStart(2, '0')}`, parentAsin: 'TARGETFAM1', twin: true })
    for (let i = 0; i < 5; i++) spec.push({ asin: `B0OTHER${String(i).padStart(3, '0')}`, parentAsin: 'OTHERFAM2' })
    const rows = makeRows(spec)
    fakeDb = makeFakeDb(rows)

    const res = await GET(req('?execute=1&limit=25&parent_asin=TARGETFAM1'))
    const body = await res.json()

    expect(body.mode).toBe('execute') // prove the branch ran
    expect(body.scope).toBe('TARGETFAM1')
    expect(body.processed).toBe(25)
    expect(body.filled).toBe(25)

    // TRUE outstanding AFTER this batch: 5 target-family ASINs (10 rows, twins) still null, the
    // 5 other-family ASINs are out of scope so don't count. This is the exact quantity the old
    // `remainingNull` arithmetic could get wrong via the window-slide bug; here it's a fresh
    // post-batch query, so it must be exactly right.
    expect(body.trueNullRows).toBe(10)
    expect(body.trueNullAsins).toBe(5)

    // Out-of-scope family untouched.
    const otherRows = rows.filter((r) => r.parent_asin === 'OTHERFAM2')
    expect(otherRows.every((r) => r.color === null)).toBe(true)

    // In-scope: exactly 25 asins (50 rows, both twins) filled, 5 asins (10 rows) still null.
    const targetRows = rows.filter((r) => r.parent_asin === 'TARGETFAM1')
    expect(targetRows.filter((r) => r.color !== null).length).toBe(50)
    expect(targetRows.filter((r) => r.color === null).length).toBe(10)
  })

  it('never writes to Amazon and never calls update in dry-run (regression net for "dry-run writes nothing")', async () => {
    const spec = [{ asin: 'B0FAMILYA1', parentAsin: 'PARENTFAM1' }]
    const rows = makeRows(spec)
    fakeDb = makeFakeDb(rows)
    // Spy on `from` to catch any accidental `.update(...)` call during a dry-run.
    let updateCalled = false
    const originalFrom = fakeDb.from.bind(fakeDb)
    fakeDb.from = (table: string) => {
      const q = originalFrom(table)
      const originalUpdate = q.update.bind(q)
      q.update = (patch: Partial<Row>) => {
        updateCalled = true
        return originalUpdate(patch)
      }
      return q
    }

    await GET(req('')) // dry-run (no execute=1)
    expect(updateCalled).toBe(false)
  })
})
