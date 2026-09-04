import { describe, it, expect } from 'vitest'
import {
  SOURCE_LABEL, resolveDesignGarment, buildDesignAssignmentRequests, buildDesignClearRequests,
  type ChildGarmentResolution,
} from './garmentPerDesign'

/*
 * B0DSCDZC6K, live 2026-09-03 — the exact defect this module exists to close: "Business B*tch"
 * (SKU BB64000XL-BK-FBA) shipped a Tee title for a design the PO says IS a sweatshirt because a
 * `scope='child'` blank_assignments row (seeded by migration 062, style_code '6014' — a
 * long-sleeve tee code, itself also wrong, but that data fix is a separate PO SQL change and NOT
 * this suite's concern) silently overrode the family's correct SKU-derived '18000' (Gildan
 * sweatshirt). The PO had no way to SEE which precedence level decided a design's garment, or to
 * fix a wrong one without SQL. These fixtures mirror the real family: Business B*tch resolves via
 * an explicit child assignment; every sibling design resolves via its own SKU's style code.
 */
function childRes(over: Partial<ChildGarmentResolution> & { sku: string }): ChildGarmentResolution {
  return {
    sku: over.sku, asin: over.asin ?? null, styleCode: over.styleCode ?? null, source: over.source ?? null,
    blankId: over.blankId ?? null, fallback: over.fallback ?? { styleCode: null, source: null, blankId: null },
  }
}

const BUSINESS_BITCH = childRes({
  sku: 'BB64000XL-BK-FBA', styleCode: '6014', source: 'child-assignment', blankId: 3,
  fallback: { styleCode: '64000', source: 'sku-code', blankId: 2 }, // the wrong Tee code a bare clear would reintroduce
})
const SIBLING_SWEATSHIRT = childRes({
  sku: '18000XL-BK-FBA', styleCode: '18000', source: 'sku-code', blankId: 5,
  fallback: { styleCode: null, source: null, blankId: null },
})

describe('resolveDesignGarment — table-driven over the FOUR precedence outcomes (+ unresolved)', () => {
  // A future 5th precedence level added to blankAssignmentImpact.ts's ResolutionSource only needs
  // a new row here — resolveDesignGarment itself has no per-source branching to update.
  const CASES: { name: string; source: ChildGarmentResolution['source']; styleCode: string | null; expectLabel: string | null }[] = [
    { name: 'child assignment wins over everything else', source: 'child-assignment', styleCode: '6014', expectLabel: 'assignment' },
    { name: 'SKU style code (no explicit assignment)', source: 'sku-code', styleCode: '18000', expectLabel: 'from SKU code' },
    { name: 'family assignment (no SKU carried a code)', source: 'family-assignment', styleCode: '64000', expectLabel: 'family default' },
    { name: 'legacy match_pattern regex (last resort)', source: 'legacy', styleCode: '1717', expectLabel: 'guessed from title' },
    { name: 'nothing resolves', source: null, styleCode: null, expectLabel: null },
  ]

  for (const c of CASES) {
    it(`${c.name} — renders the correct style code AND the correct source badge text`, () => {
      const child = childRes({ sku: 'SKU-1', styleCode: c.styleCode, source: c.source })
      const resolved = resolveDesignGarment(['SKU-1'], [child])
      expect(resolved).not.toBeNull()
      expect(resolved!.styleCode).toBe(c.styleCode)
      expect(resolved!.source).toBe(c.source)
      // Prove the branch ran against the ACTUAL badge text the page/PerDesignCard render — not a
      // proxy — by reading the SAME exported SOURCE_LABEL map the components import.
      const badgeText = resolved!.source ? (SOURCE_LABEL[resolved!.source] ?? resolved!.source) : null
      expect(badgeText).toBe(c.expectLabel)
    })
  }
})

describe('resolveDesignGarment — B0DSCDZC6K specifically', () => {
  const allChildren = [BUSINESS_BITCH, SIBLING_SWEATSHIRT]

  it('Business B*tch (1 SKU) resolves to 6014 sourced as child-assignment — the exact state the PO could not see', () => {
    const resolved = resolveDesignGarment(['BB64000XL-BK-FBA'], allChildren)
    expect(resolved).not.toBeNull()
    expect(resolved!.styleCode).toBe('6014')
    expect(resolved!.source).toBe('child-assignment')
    expect(SOURCE_LABEL[resolved!.source as string]).toBe('assignment')
  })

  it('a sibling design (8-SKU family, sampled here by its first SKU) resolves to 18000 sourced as SKU code — visibly DIFFERENT badge from Business B*tch', () => {
    const resolved = resolveDesignGarment(['18000XL-BK-FBA'], allChildren)
    expect(resolved).not.toBeNull()
    expect(resolved!.styleCode).toBe('18000')
    expect(resolved!.source).toBe('sku-code')
    const badge = SOURCE_LABEL[resolved!.source as string]
    expect(badge).toBe('from SKU code')
    expect(badge).not.toBe(SOURCE_LABEL['child-assignment']) // "assignment" vs "from SKU code" — genuinely distinct text
  })

  it('clearing Business B*tch would fall back to 64000 (a TEE) sourced via sku-code — the wrong answer that motivated the assignment', () => {
    const resolved = resolveDesignGarment(['BB64000XL-BK-FBA'], allChildren)
    expect(resolved!.fallback.styleCode).toBe('64000')
    expect(resolved!.fallback.source).toBe('sku-code')
  })
})

describe('resolveDesignGarment — representative-SKU convention (mirrors perDesignEntries: first SKU of the group)', () => {
  it('picks the FIRST design SKU that has a resolution, in designSkus order', () => {
    const second = childRes({ sku: 'SKU-2', styleCode: '18000', source: 'sku-code' })
    const first = childRes({ sku: 'SKU-1', styleCode: '6014', source: 'child-assignment' })
    const resolved = resolveDesignGarment(['SKU-1', 'SKU-2'], [second, first])
    expect(resolved!.sku).toBe('SKU-1')
    expect(resolved!.styleCode).toBe('6014')
  })

  it('skips a design SKU absent from childResolutions and uses the next one', () => {
    const second = childRes({ sku: 'SKU-2', styleCode: '18000', source: 'sku-code' })
    const resolved = resolveDesignGarment(['SKU-MISSING', 'SKU-2'], [second])
    expect(resolved!.sku).toBe('SKU-2')
  })

  it('returns null for a design with no SKUs', () => {
    expect(resolveDesignGarment([], [SIBLING_SWEATSHIRT])).toBeNull()
  })

  it('returns null when none of the design SKUs have a resolution yet (garment data still loading)', () => {
    expect(resolveDesignGarment(['SKU-NOT-LOADED'], [SIBLING_SWEATSHIRT])).toBeNull()
  })
})

describe('buildDesignAssignmentRequests — writes scope=child for EVERY SKU in the design (decision: fan out, not per-SKU rows)', () => {
  it('Business B*tch (1 SKU) produces exactly ONE request', () => {
    const reqs = buildDesignAssignmentRequests(['BB64000XL-BK-FBA'], '18000')
    expect(reqs).toEqual([{ scope: 'child', key: 'BB64000XL-BK-FBA', style_code: '18000' }])
  })

  it('an 8-SKU sibling design produces 8 requests, one per SKU, all carrying the SAME style_code', () => {
    const skus = Array.from({ length: 8 }, (_, i) => `18000${i}XL-BK-FBA`)
    const reqs = buildDesignAssignmentRequests(skus, '18000')
    expect(reqs).toHaveLength(8)
    expect(reqs.every((r) => r.scope === 'child' && r.style_code === '18000')).toBe(true)
    expect(reqs.map((r) => r.key)).toEqual(skus)
  })

  it('trims the style code and drops blank/whitespace SKUs defensively', () => {
    const reqs = buildDesignAssignmentRequests(['SKU-1', '', '  ', 'SKU-2'], ' 6014 ')
    expect(reqs).toEqual([
      { scope: 'child', key: 'SKU-1', style_code: '6014' },
      { scope: 'child', key: 'SKU-2', style_code: '6014' },
    ])
  })

  it('an empty style code produces no requests at all (never a PUT with a blank style_code)', () => {
    expect(buildDesignAssignmentRequests(['SKU-1'], '')).toEqual([])
    expect(buildDesignAssignmentRequests(['SKU-1'], '   ')).toEqual([])
  })
})

describe('buildDesignClearRequests — DELETE fan-out mirrors the assignment fan-out', () => {
  it('one DELETE body per SKU, scope=child, no style_code field', () => {
    const reqs = buildDesignClearRequests(['SKU-1', 'SKU-2'])
    expect(reqs).toEqual([
      { scope: 'child', key: 'SKU-1' },
      { scope: 'child', key: 'SKU-2' },
    ])
  })

  it('Business B*tch (1 SKU) produces exactly one DELETE', () => {
    expect(buildDesignClearRequests(['BB64000XL-BK-FBA'])).toEqual([{ scope: 'child', key: 'BB64000XL-BK-FBA' }])
  })
})

describe('SOURCE_LABEL — the ONE map every garment badge (family row, per-SKU row, per-design row) renders from', () => {
  it('has a distinct, non-empty label for every ResolutionSource value', () => {
    const sources = ['child-assignment', 'sku-code', 'family-assignment', 'legacy']
    const labels = sources.map((s) => SOURCE_LABEL[s])
    expect(labels.every((l) => typeof l === 'string' && l.length > 0)).toBe(true)
    expect(new Set(labels).size).toBe(sources.length) // no two precedence levels share a badge string
  })
})
