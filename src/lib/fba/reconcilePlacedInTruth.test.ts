/**
 * PLACED_IN IS TRUTH; PLANNED_IN IS PLAN — the two are never mixed again.
 *
 * GAP 1 of the 2026-08-19 B0DSQPZY9S craft review: the keyword_reconciliation report claimed
 * placements ("aritzia dupes" → backend) that existed in NO shipped field. Root cause was one
 * clause in reconcilePlacedInBackendFirst: `|| placed.length === 0 → push('backend_keywords')`
 * fabricated a backend placement for every keyword the bytes did not carry. The field had grown
 * TWO meanings — the report read it as truth, the rank work-list read it as routing — and the
 * fallback served the second meaning by lying to the first.
 *
 * The split: placed_in = surfaces whose bytes LITERALLY carry the keyword (computed, never
 * fabricated); planned_in = where an unplaced keyword goes on the next regen (backend-first,
 * overflow's sanctioned home). The work-list routes off the union, the report renders the truth.
 */
import { describe, it, expect } from 'vitest'
import { reconcilePlacedInBackendFirst, type PipelineKeywordReconciliation } from './listingPipeline'

const kr = (keyword: string): PipelineKeywordReconciliation => ({
  keyword,
  action_type: 'CRITICAL',
  search_volume: 1000,
  placed_in: [],
  exact_text: `claimed text containing ${keyword}`,
  why: 'test',
})

const perChild = (kws: string) => [{ sku: 'SKU-1', asin: 'B000000001', keywords: kws }]

describe('placed_in is TRUTH — never fabricated', () => {
  it('an uncovered keyword reports placed_in EMPTY plus a backend PLAN (the GAP 1 lie, killed)', () => {
    const [out] = reconcilePlacedInBackendFirst(
      [kr('aritzia dupes')],
      'THE CEO Dont Quit Tee Shirt | Comfort Colors Motivational Tshirt',
      ['Soft breathable cotton for every day.'],
      'A quality garment.',
      perChild('gym shirt workout tee motivation'),
    )
    expect(out.placed_in).toEqual([])                       // the report stops lying
    expect(out.planned_in).toEqual(['backend_keywords'])    // the work-list still routes it
  })

  it('a keyword the backend actually carries reports backend_keywords with NO plan', () => {
    const [out] = reconcilePlacedInBackendFirst(
      [kr('workout tee')],
      'THE CEO Dont Quit Tee Shirt',
      [],
      '',
      perChild('gym shirt workout tee motivation'),
    )
    expect(out.placed_in).toEqual(['backend_keywords'])
    expect(out.planned_in).toBeUndefined()
  })

  it('a title-covered keyword reports title (truth accumulates across surfaces)', () => {
    const [out] = reconcilePlacedInBackendFirst(
      [kr('motivational tshirt')],
      'THE CEO Dont Quit Tee Shirt | Comfort Colors Motivational Tshirt',
      ['Motivational tshirt for the gym.'],
      '',
      perChild(''),
    )
    expect(out.placed_in).toContain('title')
    expect(out.placed_in).toContain('bullet_1')
    expect(out.planned_in).toBeUndefined()
  })

  it('HEALS a historical row that carries the old fabricated claim (heal-on-read semantics)', () => {
    // A stored row from before the fix: placed_in claims backend, bytes carry nothing.
    const lied: PipelineKeywordReconciliation = { ...kr('oversized tshirts'), placed_in: ['backend_keywords'] }
    const [out] = reconcilePlacedInBackendFirst([lied], 'THE CEO Dont Quit Tee', [], '', perChild('gym shirt'))
    expect(out.placed_in).toEqual([])                       // the stale claim is overwritten by truth
    expect(out.planned_in).toEqual(['backend_keywords'])
  })

  it('counts the per-child multi-design bytes — the ones that actually PATCH Amazon (INVARIANT 5)', () => {
    const [out] = reconcilePlacedInBackendFirst(
      [kr('golf lover gift')],
      'THE CEO Multi Design Tee',
      ['Broadcast bullet without the phrase.'],
      '',
      perChild(''),
      [{ bullets: ['A golf lover gift they will wear.'] }],   // only the per-child bullet carries it
      [{ description: 'irrelevant' }],
    )
    expect(out.placed_in).toContain('bullet_1')
    expect(out.planned_in).toBeUndefined()
  })

  it('is idempotent — a healed row re-healed is byte-identical', () => {
    const rows = [kr('aritzia dupes'), kr('workout tee')]
    const pc = perChild('workout tee')
    const once = reconcilePlacedInBackendFirst(rows, 'THE CEO Tee', [], '', pc)
    const twice = reconcilePlacedInBackendFirst(once, 'THE CEO Tee', [], '', pc)
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once))
  })

  it('passes an empty-keyword row through unchanged (defensive, matches the old contract)', () => {
    const row = { ...kr(''), placed_in: ['title'] }
    const [out] = reconcilePlacedInBackendFirst([row], 'x', [], '', perChild(''))
    expect(out).toEqual(row)
  })
})
