import { describe, it, expect, vi } from 'vitest'
import {
  applyStickyDetails,
  collectAcceptedDetailPushes,
  foldDetailKey,
  type AcceptedPushRow,
} from './stickyDetails'
import { collarStyleForNeck } from './productDetailAttrs'

// STICKY DETAILS (PO 2026-08-08): an accepted `details:<sp_api_key>` push is a standing
// approval — a regen re-proposes over it ONLY from blank_specs provenance (value_source='spec').
// This file pins the pure rules so the ONE seam in ai-recommendations cannot drift.

const row = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  field_name: 'Collar Style',
  sp_api_key: 'collar_style',
  current_value: null,
  recommended_value: 'Collarless',
  reason: 'audit guess',
  ...over,
})

const accepted = (entries: [string, string][]): Map<string, string> => new Map(entries)

describe('foldDetailKey — sp_api_key and display field_name fold to the same key', () => {
  it.each([
    ['Fabric Type', 'fabrictype'],
    ['fabric_type', 'fabrictype'],
    ['fabric-type', 'fabrictype'],
    ['  Collar Style ', 'collarstyle'],
    [undefined, ''],
    [null, ''],
  ] as [unknown, string][])('%j → %j', (input, expected) => {
    expect(foldDetailKey(input)).toBe(expected)
  })
})

describe('collarStyleForNeck — the #161 PO mapping (crew neckline → "Round Collar", never a guess)', () => {
  it.each([
    ['Crew Neck', 'Round Collar'],
    ['crew', 'Round Collar'],
    ['CREW NECK', 'Round Collar'],
    ['Crewneck', 'Round Collar'],
    ['V-Neck', null],
    ['Mock Neck', null],
    ['', null],
    [null, null],
    [undefined, null],
  ] as [string | null | undefined, string | null][])('%j → %j', (neck, expected) => {
    expect(collarStyleForNeck(neck)).toBe(expected)
  })
})

describe('collectAcceptedDetailPushes — latest accepted, non-rolled-back value per details:<key>', () => {
  const r = (over: Partial<AcceptedPushRow>): AcceptedPushRow => ({ status: 'accepted', ...over })
  it.each([
    // [name, rows (pushed_at DESC), expected entries]
    ['keeps first (latest) row per key', [
      r({ field: 'details:collar_style', new_value: 'Round Collar' }),
      r({ field: 'details:collar_style', new_value: 'Collarless' }),
    ], [['collarstyle', 'Round Collar']]],
    ['ignores non-details fields (core pushes log unprefixed)', [
      r({ field: 'title', new_value: 'Some Title' }),
      r({ field: 'heal:feeds-title', new_value: 'x' }),
    ], []],
    ['skips rolled-back rows even when status stayed accepted (verify-push parity)', [
      r({ field: 'details:department', new_value: 'Womens', rolled_back_at: '2026-08-01T00:00:00Z' }),
      r({ field: 'details:department', new_value: 'Unisex' }),
    ], [['department', 'Unisex']]],
    ['skips non-accepted and empty values', [
      r({ field: 'details:fit_type', new_value: 'Relaxed', status: 'failed' }),
      r({ field: 'details:fit_type', new_value: '   ' }),
    ], []],
    ['folds the sp_api_key segment', [
      r({ field: 'details:apparel_fabric_stretch', new_value: 'Low Stretch' }),
    ], [['apparelfabricstretch', 'Low Stretch']]],
  ] as [string, AcceptedPushRow[], [string, string][]][])('%s', (_name, rows, expected) => {
    expect([...collectAcceptedDetailPushes(rows).entries()]).toEqual(expected)
  })
})

describe('applyStickyDetails — accepted push beats LLM churn; only spec provenance re-proposes', () => {
  it('snaps an LLM re-proposal back to the accepted value (the Collarless→Round Collar cure)', () => {
    const log = vi.fn()
    const out = applyStickyDetails({
      fresh: [row({ normalized_from: 'collarless' })],
      prior: [],
      acceptedByKey: accepted([['collarstyle', 'Round Collar']]),
      log,
    })
    expect(out.changed).toBe(true)
    expect(out.details[0]).toMatchObject({
      recommended_value: 'Round Collar',
      current_value: 'Round Collar',
      enum_valid: true,
    })
    expect('normalized_from' in out.details[0]).toBe(false) // stale — described the rejected proposal
    expect(out.kept).toEqual([{ field: 'Collar Style', kept: 'Round Collar', rejectedProposal: 'Collarless', evidence: 'push-log' }])
    expect(log).toHaveBeenCalledWith({ tag: 'DETAIL_STICKY', field: 'Collar Style', kept: 'Round Collar', rejectedProposal: 'Collarless', evidence: 'push-log' })
  })

  it('lets a value_source=spec row re-propose (blank_specs disagreement is the ONE legit trigger) and carries live truth', () => {
    const log = vi.fn()
    const out = applyStickyDetails({
      fresh: [row({ field_name: 'Sleeve Type', sp_api_key: 'sleeve', recommended_value: 'Long Sleeve', value_source: 'spec' })],
      prior: [],
      acceptedByKey: accepted([['sleeve', 'Short Sleeve']]),
      log,
    })
    expect(out.details[0]).toMatchObject({ recommended_value: 'Long Sleeve', current_value: 'Short Sleeve' })
    expect(out.kept).toEqual([]) // nothing rejected — the spec value ships as a fresh Push
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ tag: 'DETAIL_STICKY', decision: 'spec-repropose', field: 'Sleeve Type', accepted: 'Short Sleeve', proposal: 'Long Sleeve' }))
  })

  describe('value_source=ruling — the crew-collar mapping re-proposes ONLY over an accepted "Collarless"', () => {
    it('accepted "Collarless" + ruling "Round Collar" → the ruling ships as a fresh Push (the permanent-stick class dies)', () => {
      const log = vi.fn()
      const out = applyStickyDetails({
        fresh: [row({ recommended_value: 'Round Collar', value_source: 'ruling' })],
        prior: [],
        acceptedByKey: accepted([['collarstyle', 'Collarless']]),
        log,
      })
      expect(out.details[0]).toMatchObject({ recommended_value: 'Round Collar', current_value: 'Collarless' })
      expect(out.kept).toEqual([]) // nothing rejected — the ruling value ships as a fresh Push
      expect(log).toHaveBeenCalledWith(expect.objectContaining({ tag: 'DETAIL_STICKY', decision: 'ruling-repropose', accepted: 'Collarless', proposal: 'Round Collar' }))
    })

    it('accepted value that is NOT "Collarless" still outranks a ruling row (LLM-derived neck never beats a real PO push)', () => {
      const out = applyStickyDetails({
        fresh: [row({ recommended_value: 'Round Collar', value_source: 'ruling' })],
        prior: [],
        acceptedByKey: accepted([['collarstyle', 'Henley']]),
        log: vi.fn(),
      })
      expect(out.details[0]).toMatchObject({ recommended_value: 'Henley', current_value: 'Henley', enum_valid: true })
      expect(out.kept).toHaveLength(1)
    })
  })

  it('audience-sourced rows DEFER to the accepted push (the Womens-vs-pushed-Unisex churn dies)', () => {
    const out = applyStickyDetails({
      fresh: [row({ field_name: 'Department', sp_api_key: 'department', recommended_value: 'Womens', value_source: 'audience' })],
      prior: [],
      acceptedByKey: accepted([['department', 'Unisex']]),
      log: vi.fn(),
    })
    expect(out.details[0]).toMatchObject({ recommended_value: 'Unisex', current_value: 'Unisex', enum_valid: true })
    expect(out.kept).toHaveLength(1)
  })

  it('agreement (fresh === accepted) stamps current_value so the "✓ On Amazon" chip renders — no kept log', () => {
    const log = vi.fn()
    const out = applyStickyDetails({
      fresh: [row({ recommended_value: 'Round Collar' })],
      prior: [],
      acceptedByKey: accepted([['collarstyle', 'Round Collar']]),
      log,
    })
    expect(out.details[0]).toMatchObject({ recommended_value: 'Round Collar', current_value: 'Round Collar' })
    expect(out.kept).toEqual([])
    expect(log).not.toHaveBeenCalled()
  })

  it('an EMPTY fresh proposal never erases an accepted value', () => {
    const out = applyStickyDetails({
      fresh: [row({ recommended_value: '' })],
      prior: [],
      acceptedByKey: accepted([['collarstyle', 'Round Collar']]),
      log: vi.fn(),
    })
    expect(out.details[0]).toMatchObject({ recommended_value: 'Round Collar', current_value: 'Round Collar' })
    expect(out.kept[0]).toMatchObject({ rejectedProposal: '' })
  })

  it('evidence lookup falls back to the folded field_name when sp_api_key is missing this run', () => {
    const out = applyStickyDetails({
      fresh: [row({ sp_api_key: undefined })],
      prior: [],
      acceptedByKey: accepted([['collarstyle', 'Round Collar']]),
      log: vi.fn(),
    })
    expect(out.details[0]).toMatchObject({ recommended_value: 'Round Collar' })
  })

  describe('fail-closed fallback: acceptedByKey=null → prior write-through equality mirror', () => {
    it('prior row with current === recommended is treated as accepted (evidence: prior-equality)', () => {
      const log = vi.fn()
      const out = applyStickyDetails({
        fresh: [row()],
        prior: [row({ current_value: 'Round Collar', recommended_value: 'Round Collar' })],
        acceptedByKey: null,
        log,
      })
      expect(out.details[0]).toMatchObject({ recommended_value: 'Round Collar', current_value: 'Round Collar' })
      expect(out.kept).toEqual([{ field: 'Collar Style', kept: 'Round Collar', rejectedProposal: 'Collarless', evidence: 'prior-equality' }])
    })

    it('prior row WITHOUT equality gives no stickiness — only the legacy current_value carry', () => {
      const out = applyStickyDetails({
        fresh: [row()],
        prior: [row({ current_value: 'Round Collar', recommended_value: 'Something Else' })],
        acceptedByKey: null,
        log: vi.fn(),
      })
      // fresh recommendation survives; live-truth cache still carries (the 2026-08-04 behavior)
      expect(out.details[0]).toMatchObject({ recommended_value: 'Collarless', current_value: 'Round Collar' })
      expect(out.kept).toEqual([])
    })
  })

  describe('no-evidence rows keep the retired carry-forward behavior byte-for-byte', () => {
    it.each([
      ['matches by sp_api_key', row({ sp_api_key: 'fit_type', field_name: 'Fit Type', recommended_value: 'Relaxed' }),
        row({ sp_api_key: 'fit_type', field_name: 'Fit', current_value: 'Classic', recommended_value: 'Slim' })],
      ['matches by folded field_name when the prior lacks sp_api_key', row({ sp_api_key: undefined, field_name: 'Fit Type', recommended_value: 'Relaxed' }),
        row({ sp_api_key: undefined, field_name: 'fit-type', current_value: 'Classic', recommended_value: 'Slim' })],
    ] as [string, Record<string, unknown>, Record<string, unknown>][])('%s', (_name, fresh, prior) => {
      const out = applyStickyDetails({ fresh: [fresh], prior: [prior], acceptedByKey: accepted([]), log: vi.fn() })
      expect(out.details[0]).toMatchObject({ recommended_value: 'Relaxed', current_value: 'Classic' })
    })

    it('a fresh row that already knows current_value is untouched', () => {
      const fresh = row({ current_value: 'Live Value' })
      const out = applyStickyDetails({ fresh: [fresh], prior: [row({ current_value: 'Older' })], acceptedByKey: accepted([]), log: vi.fn() })
      expect(out.details[0]).toBe(fresh)
      expect(out.changed).toBe(false)
    })
  })

  describe('ihReverted — the caller must re-run the blank-brand waterfall net (+ caps) only on a snap', () => {
    const ih = (over: Record<string, unknown> = {}) =>
      row({ field_name: 'Item Highlights', sp_api_key: 'title_differentiation', recommended_value: 'soft cotton, fresh churned copy', ...over })
    it.each([
      ['snap → true', ih(), accepted([['titledifferentiation', 'authentic Comfort Colors blank, garment-dyed comfort']]), true],
      ['agreement → false', ih({ recommended_value: 'authentic Comfort Colors blank, garment-dyed comfort' }),
        accepted([['titledifferentiation', 'authentic Comfort Colors blank, garment-dyed comfort']]), false],
      ['no evidence → false', ih(), accepted([]), false],
    ] as [string, Record<string, unknown>, Map<string, string>, boolean][])('%s', (_name, freshRow, acc, expected) => {
      const out = applyStickyDetails({ fresh: [freshRow], prior: [], acceptedByKey: acc, log: vi.fn() })
      expect(out.ihReverted).toBe(expected)
    })
  })

  it('non-array inputs are tolerated (changed=false, empty result)', () => {
    const out = applyStickyDetails({ fresh: null, prior: undefined, acceptedByKey: null, log: vi.fn() })
    expect(out).toMatchObject({ details: [], changed: false, ihReverted: false, kept: [] })
  })
})
