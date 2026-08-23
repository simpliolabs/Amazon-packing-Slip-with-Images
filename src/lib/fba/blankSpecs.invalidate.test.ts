import { describe, it, expect, vi, beforeEach } from 'vitest'
import { loadBlankSpecRows, loadBlankAssignments, invalidateBlankCaches } from './blankSpecs'

// CI TRAP (.github/workflows/build.yml): CI runs this suite with PLACEHOLDER Supabase env vars
// (https://placeholder.supabase.co) so `next build`/`pnpm run test` succeed without secrets. The
// module-top `supabase` client in blankSpecs.ts is a LAZY Proxy — the first property access
// constructs a real @supabase/supabase-js client against that placeholder host, which makes a REAL
// network call that hangs for ~4s before the withTimeout race gives up. That was the exact class of
// failure that made the historical DB-fail-open test flaky in CI. Fully mocking
// '@supabase/supabase-js' below already prevents any network I/O regardless of env, but per the
// established convention (and belt-and-suspenders against a future refactor that reads these env
// vars directly) the vars are also nulled out here so nothing in this file can even ATTEMPT egress.
process.env.NEXT_PUBLIC_SUPABASE_URL = ''
process.env.SUPABASE_SERVICE_ROLE_KEY = ''

let blankSpecsCalls = 0
let assignmentCalls = 0
let mockBlankRows: Record<string, unknown>[] = []
let mockAssignmentRows: Record<string, unknown>[] = []

// Pure in-memory stand-in for the two queries blankSpecs.ts issues — no network, no DB. Each query
// increments its own counter so a test can prove whether a load hit "the DB" again or was served
// from the module-level cache.
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: (table: string) => {
      if (table === 'blank_specs') {
        return { select: () => ({ eq: () => ({ order: () => { blankSpecsCalls++; return Promise.resolve({ data: mockBlankRows, error: null }) } }) }) }
      }
      if (table === 'blank_assignments') {
        return { select: () => ({ limit: () => { assignmentCalls++; return Promise.resolve({ data: mockAssignmentRows, error: null }) } }) }
      }
      throw new Error(`unexpected table in mock: ${table}`)
    },
  }),
}))

describe('invalidateBlankCaches — proves a bust forces a re-read (pure, no DB/network)', () => {
  beforeEach(() => {
    blankSpecsCalls = 0
    assignmentCalls = 0
    mockBlankRows = [{ match_pattern: '\\bfoo\\b', brand: 'Foo', active: true }]
    mockAssignmentRows = [{ scope: 'family', key: 'B0FOO', style_code: 'FOO1' }]
    // Clean slate between tests — otherwise a cache populated by test N would leak into test N+1.
    invalidateBlankCaches()
  })

  describe('blank_specs cache', () => {
    it('a second load within the TTL is served from cache, not a second DB read', async () => {
      const first = await loadBlankSpecRows()
      expect(blankSpecsCalls).toBe(1)
      expect(first[0]?.spec.brand).toBe('Foo')

      mockBlankRows = [{ match_pattern: '\\bbar\\b', brand: 'Bar', active: true }]
      const second = await loadBlankSpecRows()
      expect(blankSpecsCalls).toBe(1) // no new query fired
      expect(second[0]?.spec.brand).toBe('Foo') // stale cached value, proving it WAS cached
    })

    it('invalidateBlankCaches() forces the next load to re-read rather than serve the cache', async () => {
      const first = await loadBlankSpecRows()
      expect(blankSpecsCalls).toBe(1)
      expect(first[0]?.spec.brand).toBe('Foo')

      mockBlankRows = [{ match_pattern: '\\bbar\\b', brand: 'Bar', active: true }]
      invalidateBlankCaches()
      const second = await loadBlankSpecRows()
      expect(blankSpecsCalls).toBe(2) // a real second query fired
      expect(second[0]?.spec.brand).toBe('Bar') // fresh value — proves the re-read, not luck
    })
  })

  describe('blank_assignments cache', () => {
    it('a second load within the TTL is served from cache, not a second DB read', async () => {
      const first = await loadBlankAssignments()
      expect(assignmentCalls).toBe(1)
      expect(first.family.get('B0FOO')).toBe('FOO1')

      mockAssignmentRows = [{ scope: 'family', key: 'B0FOO', style_code: 'BAR2' }]
      const second = await loadBlankAssignments()
      expect(assignmentCalls).toBe(1)
      expect(second.family.get('B0FOO')).toBe('FOO1') // stale — proves it was cached
    })

    it('invalidateBlankCaches() forces the next load to re-read rather than serve the cache', async () => {
      const first = await loadBlankAssignments()
      expect(assignmentCalls).toBe(1)
      expect(first.family.get('B0FOO')).toBe('FOO1')

      mockAssignmentRows = [{ scope: 'family', key: 'B0FOO', style_code: 'BAR2' }]
      invalidateBlankCaches()
      const second = await loadBlankAssignments()
      expect(assignmentCalls).toBe(2)
      expect(second.family.get('B0FOO')).toBe('BAR2') // fresh — proves the re-read
    })
  })

  it('busts BOTH caches from one call — a bust triggered by only one write path still frees the other', async () => {
    await loadBlankSpecRows()
    await loadBlankAssignments()
    expect(blankSpecsCalls).toBe(1)
    expect(assignmentCalls).toBe(1)

    mockBlankRows = [{ match_pattern: '\\bbar\\b', brand: 'Bar', active: true }]
    mockAssignmentRows = [{ scope: 'family', key: 'B0FOO', style_code: 'BAR2' }]
    invalidateBlankCaches()

    const [specs, assignments] = await Promise.all([loadBlankSpecRows(), loadBlankAssignments()])
    expect(blankSpecsCalls).toBe(2)
    expect(assignmentCalls).toBe(2)
    expect(specs[0]?.spec.brand).toBe('Bar')
    expect(assignments.family.get('B0FOO')).toBe('BAR2')
  })
})
