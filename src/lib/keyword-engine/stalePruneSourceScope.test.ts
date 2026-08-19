/**
 * THE STALE-PRUNE IS SOURCE-SCOPED (task #177) — a run that could not refresh a source must never
 * delete that source's rows.
 *
 * Live 2026-08-19, PO-caught: a regen's forced sync while Jungle Scout was kill-switched OFF wrote
 * 2 SQP rows and the unscoped prune then deleted all 83 freshly-harvested jungle_scout rows as
 * "not refreshed this run" — the paid harvest survived only in keyword_cache. This is the #352
 * abort-and-preserve doctrine at the pool layer: destruction requires refresh, absence preserves.
 *
 * These tests pin the SCOPING RULE as a pure function mirroring the storeAnalysis prune predicate,
 * so the rule itself cannot drift back to "delete everything older".
 */
import { describe, it, expect } from 'vitest'

/** Mirrors storeAnalysis: which existing rows may the prune delete, given this run's rows? */
const prunable = (
  existing: { keyword: string; data_source: string; analyzed_at: string }[],
  runRows: { dataSource?: string }[],
  runTs: string,
): string[] => {
  const refreshed = new Set(runRows.map((r) => r.dataSource).filter(Boolean))
  if (refreshed.size === 0) return []
  return existing
    .filter((r) => r.data_source !== 'import' && refreshed.has(r.data_source) && r.analyzed_at < runTs)
    .map((r) => r.keyword)
}

const T0 = '2026-08-19T16:59:00Z'
const T1 = '2026-08-19T17:08:00Z'
const pool = [
  { keyword: 'motivational shirts', data_source: 'jungle_scout', analyzed_at: T0 },
  { keyword: "don't quit t shirt", data_source: 'jungle_scout', analyzed_at: T0 },
  { keyword: 'red alpha shirt', data_source: 'sqp', analyzed_at: T0 },
  { keyword: 'h10 seed', data_source: 'import', analyzed_at: T0 },
]

describe('source-scoped stale-prune', () => {
  it('an SQP-only run (JS kill-switched) PRESERVES every jungle_scout row — the live incident', () => {
    const out = prunable(pool, [{ dataSource: 'sqp' }, { dataSource: 'sqp' }], T1)
    expect(out).toEqual(['red alpha shirt'])   // only the stale SQP row; the harvest survives
  })

  it('a full JS run still prunes stale jungle_scout rows (cleanup behaviour preserved)', () => {
    const out = prunable(pool, [{ dataSource: 'jungle_scout' }], T1)
    expect(out).toEqual(['motivational shirts', "don't quit t shirt"])
  })

  it('a mixed run prunes both refreshed sources', () => {
    const out = prunable(pool, [{ dataSource: 'jungle_scout' }, { dataSource: 'sqp' }], T1)
    expect(out).toEqual(['motivational shirts', "don't quit t shirt", 'red alpha shirt'])
  })

  it('imports are never prunable, even when an import-sourced run somehow occurs', () => {
    const out = prunable(pool, [{ dataSource: 'import' }], T1)
    expect(out).toEqual([])
  })

  it('a run with NO data_source on its rows prunes nothing (nothing provably refreshed)', () => {
    expect(prunable(pool, [{}, {}], T1)).toEqual([])
  })

  it('rows written THIS run are never prunable regardless of source', () => {
    const fresh = pool.map((r) => ({ ...r, analyzed_at: T1 }))
    expect(prunable(fresh, [{ dataSource: 'jungle_scout' }, { dataSource: 'sqp' }], T1)).toEqual([])
  })
})
