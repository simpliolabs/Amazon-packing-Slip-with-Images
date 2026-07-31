import { describe, it, expect } from 'vitest'
import { blankSpecFactTokens } from './listingPipeline'

describe('blankSpecFactTokens — Phase 6 facts-only backend pad source', () => {
  it('null spec contributes nothing (plan R3: an unlisted blank must never be padded with tee facts)', () => {
    expect(blankSpecFactTokens(null)).toEqual([])
  })
  it('the Comfort Colors spec yields search-shaped phrases with numbers/units stripped', () => {
    const out = blankSpecFactTokens({
      brand: 'Comfort Colors', fit: 'Relaxed', sleeve: 'Short Sleeve', neck: 'Crew Neck',
      weightNote: 'midweight 6.1 oz garment-dyed', material: '100% Ring-Spun Cotton', dye: 'Garment-Dyed',
      stretch: 'Low Stretch', fitToSize: 'Runs Slightly Small',
    })
    expect(out).toEqual([
      'relaxed fit',
      'short sleeve',
      'crew neck',
      'ring spun cotton',
      'garment dyed',
      'midweight garment dyed',
    ])
    // Every emitted word derives from a spec field — nothing invented, no digits, no units.
    for (const p of out) expect(p).toMatch(/^[a-z ]+$/)
  })
  it('a sparse spec emits only the fields it has', () => {
    expect(blankSpecFactTokens({ fit: 'Oversized' })).toEqual(['oversized fit'])
  })
  it('the Gildan 64000 spec (PO-confirmed 2026-07-31) yields its facts, units stripped', () => {
    const out = blankSpecFactTokens({
      brand: 'Gildan', fit: 'Classic', sleeve: 'Short Sleeve', neck: 'Crew Neck',
      weightNote: 'lightweight 4.5 oz ring-spun', material: 'Ring-Spun Cotton',
    })
    expect(out).toEqual(['classic fit', 'short sleeve', 'crew neck', 'ring spun cotton', 'lightweight ring spun'])
  })
})
