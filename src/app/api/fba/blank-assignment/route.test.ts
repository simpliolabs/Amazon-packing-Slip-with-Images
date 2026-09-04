/**
 * GET /api/fba/blank-assignment — per-child `fallback` wiring (PO per-design garment UI,
 * 2026-09-03). route.ts's own GET handler was already computing family + per-child (per-SKU)
 * resolutions before this change; this suite covers ONLY what's new — each child resolution now
 * also carries `fallback: {styleCode, source, blankId}` (what that ONE sku would resolve to with
 * its own explicit child assignment excluded), computed via resolveChildFallback
 * (blankAssignmentImpact.ts, unit-tested there). This is what lets the per-design Garment control's
 * "Clear" action show the seller the fallback target BEFORE they confirm, instead of a bare delete
 * that can silently reintroduce a wrong garment.
 *
 * Fixture mirrors the real B0DSCDZC6K family: one child (Business B*tch, BB64000XL-BK-FBA) carries
 * an explicit (wrong) `scope='child'` assignment to '6014'; a sibling child (18000XL-BK-FBA) has no
 * assignment and resolves via its own SKU style code.
 *
 * CI TRAP (same as backfill-child-color/route.test.ts and parentLockScope.test.ts): build.yml's
 * "Test (blocking)" step sets NEXT_PUBLIC_SUPABASE_URL / ANON_KEY / SUPABASE_SERVICE_ROLE_KEY to a
 * syntactically-valid-but-fake `https://placeholder.supabase.co`, which turns this repo's lazy
 * Supabase clients into a REAL ~4s network attempt. `@/lib/supabase/server` is fully mocked below
 * so `createAdminClient`/`createClient` never construct a real client — no real network call is
 * possible for the GET path this suite exercises — and the env vars are nulled/restored anyway for
 * hygiene parity. `@/lib/fba/blankSpecs` is left UNMOCKED: `rowToSpec`/`extractStyleCode`/
 * `matchBlankSpecRow` (imported transitively via blankAssignmentImpact.ts) are pure, and its own
 * lazy Supabase client (`_supabase ??= createClient(...)`) only constructs inside a function this
 * GET handler never calls — mocking it wholesale would silently strip those pure exports instead.
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
// Minimal in-memory fake of the supabase-js query builder — just enough chain surface for THIS
// route's GET (.from/.select/.eq/.order/.limit/.in), keyed by table name since GET reads three
// different tables (blank_specs, listing_content, blank_assignments).
// ---------------------------------------------------------------------------------------------
type AnyRow = Record<string, unknown>

class FakeQuery {
  private filters: Array<(r: AnyRow) => boolean> = []
  private orderCol: string | null = null
  private limitVal: number | null = null

  constructor(private rows: AnyRow[]) {}

  select(_cols: string) { return this }
  eq(col: string, val: unknown) { this.filters.push((r) => r[col] === val); return this }
  in(col: string, vals: readonly unknown[]) { const set = new Set(vals); this.filters.push((r) => set.has(r[col])); return this }
  order(col: string) { this.orderCol = col; return this }
  limit(n: number) { this.limitVal = n; return this }

  private run() {
    let matched = this.rows.filter((r) => this.filters.every((f) => f(r)))
    if (this.orderCol) {
      const col = this.orderCol
      matched = [...matched].sort((a, b) => ((a[col] as number) < (b[col] as number) ? -1 : (a[col] as number) > (b[col] as number) ? 1 : 0))
    }
    if (this.limitVal != null) matched = matched.slice(0, this.limitVal)
    return { data: matched, error: null }
  }

  then<TResult1 = unknown, TResult2 = never>(
    onfulfilled?: ((value: ReturnType<FakeQuery['run']>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return Promise.resolve(this.run()).then(onfulfilled, onrejected)
  }
}

interface Tables { blank_specs: AnyRow[]; listing_content: AnyRow[]; blank_assignments: AnyRow[] }

function makeFakeAdmin(tables: Tables) {
  return { from: (table: keyof Tables) => new FakeQuery(tables[table] ?? []) }
}

let fakeAdmin: ReturnType<typeof makeFakeAdmin>

vi.mock('@/lib/supabase/server', () => ({
  createAdminClient: vi.fn(async () => fakeAdmin),
  createClient: vi.fn(async () => ({ auth: { getUser: vi.fn(async () => ({ data: { user: null } })) } })),
}))
vi.mock('@/lib/fba/claims', () => ({
  resolveUserName: vi.fn(async () => 'test-user'),
}))

const { GET } = await import('./route')

function req(qs: string) {
  return new NextRequest(`http://localhost/api/fba/blank-assignment${qs}`)
}

// Mirrors FIXTURE_ROWS in blankAssignmentImpact.test.ts (migrations 053/058's real 1717/64000/6014
// rows) PLUS the real 18000 Gildan sweatshirt row (migration 058) that B0DSCDZC6K's siblings
// actually resolve to — the whole point of the live defect is 6014/64000 (both Tee-family codes)
// vs the sweatshirt family's correct 18000.
const BLANK_SPECS_ROWS: AnyRow[] = [
  { id: 1, match_pattern: '\\bcomfort\\s*colors?\\b', brand: 'Comfort Colors', brand_in_copy: true, style_code: '1717', garment_family: 'tee', active: true },
  { id: 2, match_pattern: '\\bgildan\\b|\\b64000', brand: 'Gildan', brand_in_copy: false, style_code: '64000', garment_family: 'tee', active: true },
  { id: 3, match_pattern: '\\b6014', brand: 'Comfort Colors', brand_in_copy: true, style_code: '6014', garment_family: 'long_sleeve_tee', active: true },
  { id: 4, match_pattern: '\\b18000', brand: 'Gildan', brand_in_copy: false, style_code: '18000', garment_family: 'sweatshirt', active: true },
]

describe('GET /api/fba/blank-assignment — per-child fallback (B0DSCDZC6K)', () => {
  it('Business B*tch (wrong child assignment to 6014) resolves as child-assignment AND its fallback is the 64000 Tee code — the wrong answer clearing must warn about', async () => {
    fakeAdmin = makeFakeAdmin({
      blank_specs: BLANK_SPECS_ROWS,
      listing_content: [
        { parent_asin: 'B0DSCDZC6K', sku: 'BB64000XL-BK-FBA', title: 'THE CEO Business Btch Tee Shirt', asin: 'B0BUSINESS1' },
        { parent_asin: 'B0DSCDZC6K', sku: '18000XL-BK-FBA', title: 'A Gildan Sweatshirt', asin: 'B0SIBLING01' },
      ],
      blank_assignments: [
        { scope: 'child', key: 'BB64000XL-BK-FBA', style_code: '6014' },
      ],
    })

    const res = await GET(req('?parentAsin=B0DSCDZC6K'))
    expect(res.status).toBe(200)
    const body = await res.json()

    const businessBitch = body.children.find((c: { sku: string }) => c.sku === 'BB64000XL-BK-FBA')
    expect(businessBitch).toBeDefined()
    expect(businessBitch.styleCode).toBe('6014')
    expect(businessBitch.source).toBe('child-assignment') // prove the branch ran, not just "a value appears"
    expect(businessBitch.fallback).toEqual({ styleCode: '64000', source: 'sku-code', blankId: 2 })

    const sibling = body.children.find((c: { sku: string }) => c.sku === '18000XL-BK-FBA')
    expect(sibling).toBeDefined()
    expect(sibling.styleCode).toBe('18000')
    expect(sibling.source).toBe('sku-code') // visibly DIFFERENT source than Business B*tch's 'child-assignment'
    // No explicit assignment to clear — its own fallback equals its own (already unassigned) resolution.
    expect(sibling.fallback).toEqual({ styleCode: '18000', source: 'sku-code', blankId: 4 })
  })

  it('a child with no assignment at all gets a fallback identical to its primary resolution (nothing to clear)', async () => {
    fakeAdmin = makeFakeAdmin({
      blank_specs: BLANK_SPECS_ROWS,
      listing_content: [
        { parent_asin: 'B0PLAINFAM', sku: '17172XL-BLK', title: 'A Comfort Colors Tee', asin: 'B0PLAIN01' },
      ],
      blank_assignments: [],
    })

    const res = await GET(req('?parentAsin=B0PLAINFAM'))
    const body = await res.json()
    const child = body.children[0]
    expect(child.source).toBe('sku-code')
    expect(child.fallback).toEqual({ styleCode: child.styleCode, source: child.source, blankId: child.blankId })
  })
})
