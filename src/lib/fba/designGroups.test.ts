/**
 * detectDesignGroups — the ONE multi-design grouping (per_child_titles' design keys).
 *
 * PO 2026-08-21: B0F6VTY79T (RF / BTFFTW / FF before the 64000 style code) is "a multi-design family
 * the system had not classified". ROOT CAUSE: the resolver dropped every singleton key as "the parent
 * hub / outlier" — BTFFTW and FF each have ONE live SKU, so only RF survived and the family read
 * single-design. Under the STYLE-CODE convention the key IS the seller's explicit design code; it
 * never needs a sibling. The hub is excluded by identity (self-parented row / "-Parent" SKU), not by
 * count. Prefix-encoded families (Darlin' DAR-CCG) keep the ≥2 rule.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('openai', () => ({ default: class MockOpenAI { chat = { completions: { create: vi.fn() } } } }))

import { detectDesignGroups, designKeyForSku } from './listingPipeline'

const c = (sku: string, asin = `A${sku.replace(/[^A-Z0-9]/gi, '').slice(0, 9)}`) => ({ sku, asin })

describe('detectDesignGroups — B0F6VTY79T-style prefix grouping (RF / BTFFTW / FF + 64000 style code)', () => {
  it('resolves THREE design groups when two designs have a single SKU each (the un-classified family)', () => {
    const children = [
      c('RF64000S-WH'), c('RF64000M-WH'), c('RF64000L-WH'), c('RF64000XL-WH'),
      c('BTFFTW64000M-WH'),
      c('FF64000L-WH'),
    ]
    const r = detectDesignGroups(children, { parentAsin: 'B0F6VTY79T' })
    expect(r.isMultiDesign).toBe(true)
    expect(r.groups.map((g) => g.key)).toEqual(['RF', 'BTFFTW', 'FF'])
    expect(r.groups.find((g) => g.key === 'RF')!.skus).toHaveLength(4)
    expect(r.groups.find((g) => g.key === 'BTFFTW')!.skus).toHaveLength(1)
    expect(r.groups.find((g) => g.key === 'FF')!.skus).toHaveLength(1)
  })

  it('the June census shape (RF×4 + BTFFTW×1, no FF yet) is ALSO multi-design — the exact live miss', () => {
    const r = detectDesignGroups([c('BTFFTW64000M-WH'), c('RF64000L-WH'), c('RF64000M-WH'), c('RF64000S-WH'), c('RF64000XL-WH')])
    expect(r.isMultiDesign).toBe(true)
    expect(r.groups.map((g) => g.key).sort()).toEqual(['BTFFTW', 'RF'])
  })

  it('B0DQ96CGPL-style: five style-code designs with ONE SKU each is multi-design (BB/BD/BM/PY/TC)', () => {
    const r = detectDesignGroups([c('BB64000LXL-BK-FBA'), c('BD64000L-GY-FBA'), c('BM64000M-GY'), c('BM64000XL-GY-FBA'), c('PY64000M-RD'), c('TC64000L-BK')])
    expect(r.isMultiDesign).toBe(true)
    expect(r.groups.map((g) => g.key).sort()).toEqual(['BB', 'BD', 'BM', 'PY', 'TC'])
  })

  it('B0DQ5YZH38: the single-SKU BD design joins BM and RK (it used to vanish)', () => {
    const r = detectDesignGroups([c('BD64000L-RD-FBA'), c('BM64000L-BK'), c('BM64000M-BK-FBA'), c('BM64000S-BK'), c('RK64000L-BK'), c('RK64000M-BK')])
    expect(r.groups.map((g) => g.key)).toEqual(['BD', 'BM', 'RK'])
  })
})

describe('detectDesignGroups — what must NOT change', () => {
  it('B0F6QZ34B1 (FHOSH / FRAF / OF, all multi-SKU) still resolves three groups in first-seen order', () => {
    const r = detectDesignGroups([c('FHOSH64000L-BK'), c('FHOSH64000M-BK'), c('FRAF64000L-BK'), c('FRAF64000M-BK-FBM'), c('OF64000L-BK'), c('OF64000S-BK-FBM')])
    expect(r.isMultiDesign).toBe(true)
    expect(r.groups.map((g) => g.key)).toEqual(['FHOSH', 'FRAF', 'OF'])
  })

  it("Darlin' (prefix-encoded colour family DAR-CCG-<size>-<colour>) stays SINGLE-design", () => {
    const r = detectDesignGroups([c('DAR-CCG-S-BAY'), c('DAR-CCG-M-BAY'), c('DAR-CCG-2XL-BAY'), c('DAR-CCG-L-BLU')])
    expect(r.isMultiDesign).toBe(false)
    expect(r.groups.map((g) => g.key)).toEqual(['DAR-CCG'])
  })

  it('a prefix-encoded singleton outlier (no style code) is still NOT a design group', () => {
    const r = detectDesignGroups([c('DAR-CCG-S-BAY'), c('DAR-CCG-M-BAY'), c('DAR-CCX-M-BAY')])
    expect(r.isMultiDesign).toBe(false)
    expect(r.groups.map((g) => g.key)).toEqual(['DAR-CCG'])
  })

  it('a lone style-code SKU family (one design, one size) is single-design — a singleton needs a sibling design to be multi WITH', () => {
    const r = detectDesignGroups([c('6014M-EP-LS-SweetPotato')])
    expect(r.isMultiDesign).toBe(false)
  })

  it('the variation HUB never seeds a design group: self-parented row (asin === parentAsin) and "-Parent" SKUs are excluded by identity', () => {
    const r = detectDesignGroups(
      [c('64000L-BK-Host-Countries-TS'), c('64000M-BK-Host-Countries-TS'), { sku: 'Host-Countries-TS-Parent', asin: 'B0GVV3XL4T' }, { sku: '64000-Host-Countries-Parent', asin: 'B0GVV3XL4T' }],
      { parentAsin: 'B0GVV3XL4T' },
    )
    expect(r.isMultiDesign).toBe(false)
    expect(r.groups.map((g) => g.key)).toEqual(['HOST-COUNTRIES'])
  })

  it('a "-Parent" SKU is excluded even WITHOUT parentAsin (a style-code hub would otherwise become a singleton design)', () => {
    const r = detectDesignGroups([c('64000L-BK-Host-Countries-TS'), c('64000M-BK-Host-Countries-TS'), c('64000-Host-Countries-TS-Parent')])
    expect(r.isMultiDesign).toBe(false)
  })
})

describe('designKeyForSku — the style-code prefix is the design', () => {
  it.each([
    ['RF64000L-WH', 'RF'], ['BTFFTW64000M-WH', 'BTFFTW'], ['FF64000XL-WH', 'FF'],
    ['FHOSH64000L-BK', 'FHOSH'], ['OF640002XL-BK-FBM', 'OF'],
    ['640002XL-BK-Custom-Cup-TS', 'CUSTOM-CUP'], ['BC30012XL-SC-Custom-Cup-TS', 'CUSTOM-CUP'],
    ['DAR-CCG-2XL-BAY', 'DAR-CCG'],
    // LADIES marker glued to the size (live B0DQ96CGPL / B0DSBJ7GQD) — used to yield the COLOUR as the key.
    ['BB64000LXL-BK-FBA', 'BB'], ['RIAC64000L2XL-BK-FBA', 'RIAC'], ['RIAC64000LM-BK', 'RIAC'],
  ])('%s → %s', (sku, key) => {
    expect(designKeyForSku(sku)).toBe(key)
  })
})
