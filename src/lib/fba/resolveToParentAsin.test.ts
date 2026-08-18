/**
 * CHILD ASINs RESOLVE TO THEIR PARENT ON THE PUSH PATH (task #105).
 *
 * THE ASYMMETRY THAT CAUSED IT. The listing PAGE has resolved a pasted child ASIN to its parent and
 * redirected since #106. The PUSH path never did. So a child arriving at push-content was used
 * verbatim as `parent_asin`, family discovery asked for rows whose parent_asin equals a CHILD, found
 * none, and the push refused with "No SKUs found for this parent. Run a Sync first." — a message
 * blaming a missing sync for what is a resolution gap.
 *
 * The task text read "family discovery finds only 1 row (parent==child)", which described the
 * symptom and pointed at discovery. The defect is one layer earlier: in what discovery was ASKED.
 * The seller confirmed the case — B0GML74MJQ is a child of B0GML5V7KZ.
 *
 * These use a hand-rolled fake rather than a mocking library: the resolver's real hazards are
 * SHAPES (the FBA+FBM twin returning two rows, a null parent, an unknown ASIN), and a fake that
 * returns those shapes tests the thing that actually broke.
 */
import { describe, it, expect } from 'vitest'
import { resolveToParentAsin } from './resolveAsin'

type Row = { asin: string; parent_asin: string | null }

/** Minimal supabase stand-in over a fixed listing_content table. Mirrors only the call shapes the
 *  resolver uses: .from().select().eq().limit().maybeSingle() and the two fallbacks. */
const fakeDb = (rows: Row[], rollup: Record<string, string> = {}) => ({
  from(table: string) {
    const q = {
      _table: table, _col: '', _val: '',
      select() { return q },
      eq(col: string, val: string) { q._col = col; q._val = val; return q },
      not() { return q },
      limit() { return q },
      async maybeSingle() {
        if (q._table !== 'listing_content') return { data: null }
        return { data: rows.find((r) => r.asin === q._val) ?? null }
      },
      async single() {
        if (q._table === 'parent_asin_rollup') {
          const top = rollup[q._val]
          return { data: top ? { top_child_asin: top } : null }
        }
        return { data: rows.find((r) => r.parent_asin === q._val) ?? null }
      },
    }
    return q
  },
})

const FAMILY: Row[] = [
  { asin: 'B0GML74MJQ', parent_asin: 'B0GML5V7KZ' },   // the seller's confirmed child
  { asin: 'B0GML74MJQ', parent_asin: 'B0GML5V7KZ' },   // its FBM twin — same parent, two rows
  { asin: 'B0GML5V7KZ', parent_asin: 'B0GML5V7KZ' },   // the parent, self-parented
]

describe("a child ASIN resolves to its parent", () => {
  it("THE SELLER'S CASE: B0GML74MJQ -> B0GML5V7KZ", async () => {
    const r = await resolveToParentAsin('B0GML74MJQ', fakeDb(FAMILY))
    expect(r.parentAsin).toBe('B0GML5V7KZ')
    expect(r.resolvedFrom).toBe('B0GML74MJQ')
  })

  it('the FBA+FBM twin does not break it — two rows, one parent', async () => {
    // .single() would THROW on 2 rows and silently null-resolve; the shared resolver uses
    // .limit(1).maybeSingle() for exactly this. Pinned so a future "cleanup" cannot regress it.
    const r = await resolveToParentAsin('B0GML74MJQ', fakeDb(FAMILY))
    expect(r.parentAsin).toBe('B0GML5V7KZ')
  })
})

describe('everything that works today is byte-identical', () => {
  it('a PARENT resolves to itself and is NOT reported as redirected', async () => {
    const r = await resolveToParentAsin('B0GML5V7KZ', fakeDb(FAMILY))
    expect(r.parentAsin).toBe('B0GML5V7KZ')
    expect(r.resolvedFrom).toBeNull()   // self-parented is not a redirect
  })

  it('FAIL-OPEN: an unknown ASIN passes through unchanged', async () => {
    // Degrades to exactly the pre-fix behaviour — the caller gets what it asked for and the
    // existing "No SKUs found" path still fires for a genuinely unsynced listing.
    const r = await resolveToParentAsin('B0UNKNOWN01', fakeDb(FAMILY))
    expect(r.parentAsin).toBe('B0UNKNOWN01')
    expect(r.resolvedFrom).toBeNull()
  })

  it('FAIL-OPEN: a NULL parent (orphan row) passes through unchanged', async () => {
    const orphan: Row[] = [{ asin: 'B0ORPHAN001', parent_asin: null }]
    const r = await resolveToParentAsin('B0ORPHAN001', fakeDb(orphan))
    expect(r.parentAsin).toBe('B0ORPHAN001')
    expect(r.resolvedFrom).toBeNull()
  })
})
