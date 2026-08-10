/**
 * syntheticRowProvenance.test.ts — a SYNTHETIC keyword row must never claim MEASURED market data.
 *
 * THE DEFECT (found 2026-08-09, PO ruled "A: YES"). Two sites mint keyword rows for terms Jungle
 * Scout never measured, and both stated a measurement anyway:
 *
 *   1. syncKeywordIntelligence's `addSynonyms` cloned the highest-volume harvested SIBLING onto the
 *      synonym token — `{ ...best, keyword: synonym }`, commented "inherit its volume/data profile".
 *      These rows PERSIST to keyword_analysis explicitly so they "surface as ranking OPPORTUNITIES in
 *      the RANK panel", so the seller was shown `football` carrying `soccer jersey`'s MEASURED
 *      opportunity score.
 *   2. `attributeAsKeyword` stamped `dataSource: 'jungle_scout'` on a row whose every market field is
 *      a zero we wrote ourselves.
 *
 * Both contradict the standing rule that the opportunity number must be the provider's own
 * (SELLER_PROFILE §5). The cure is a split, not a deletion: PLACEMENT fields (coverageGapScore,
 * searchVolume, actionType) may be inherited — that is our own ranking heuristic, and it is what
 * keeps the synonym reaching the backend bytes — while the three NATIVE columns (migration 055) are
 * nulled so `carriesMarketOpportunity` reads false and the UI falls through to the `~N` composite it
 * already renders as explicitly-not-market-data.
 *
 * WHY A SOURCE-TEXT TEST. Both sites are closures inside long private functions with no seam to call.
 * The invariant is also exactly the kind tsc cannot see — `{...best}` is perfectly well-typed while
 * being a lie about provenance. Same reasoning as designSignalWiring.test.ts, which pins the
 * singular/plural select that tsc likewise could not catch. A structural assertion that BITES is
 * worth more here than a unit test that cannot reach the code.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(__dirname, '..', '..', '..')
const read = (p: string) => readFileSync(join(root, p), 'utf8')

const NATIVE_COLUMNS = ['jsEaseOfRanking', 'jsRelevancyScore', 'marketOpportunity'] as const

describe('synthetic keyword rows never claim measured market data', () => {
  it('syncKeywordIntelligence: the persisted synonym clone nulls all three native metrics', () => {
    const src = read('src/lib/sync/syncKeywordIntelligence.ts')
    const i = src.indexOf('adds.push({')
    expect(i, 'the synonym clone site moved — re-point this test before assuming it passes').toBeGreaterThan(-1)
    const block = src.slice(i, i + 400)
    for (const col of NATIVE_COLUMNS) expect(block, `${col} must be nulled on the clone`).toContain(`${col}: null`)
  })

  it('listingPipeline: the in-pipeline synonym clone nulls all three native metrics', () => {
    const src = read('src/lib/fba/listingPipeline.ts')
    const i = src.indexOf('{ ...bestSibling, keyword: synonym')
    expect(i, 'the bestSibling clone site moved — re-point this test').toBeGreaterThan(-1)
    const block = src.slice(i, i + 300)
    for (const col of NATIVE_COLUMNS) expect(block, `${col} must be nulled on the clone`).toContain(`${col}: null`)
  })

  it('NEITHER clone site does a bare spread — a bare spread is how the metrics leaked in the first place', () => {
    expect(read('src/lib/sync/syncKeywordIntelligence.ts')).not.toContain('adds.push({ ...best, keyword: synonym })')
    expect(read('src/lib/fba/listingPipeline.ts')).not.toContain('{ ...bestSibling, keyword: synonym }')
  })

  it('attributeAsKeyword does not claim jungle_scout provenance on a row it synthesised', () => {
    const src = read('src/lib/fba/listingPipeline.ts')
    const i = src.indexOf('function attributeAsKeyword')
    expect(i).toBeGreaterThan(-1)
    const body = src.slice(i, src.indexOf('}', src.indexOf('as AnalyzedKeyword', i)))
    expect(body).toContain("dataSource: 'inherited'")
    expect(body).not.toContain("dataSource: 'jungle_scout'")
  })
})
