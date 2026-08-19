/**
 * FABRIC TRUTH IS SPEC TRUTH (task #41 / GAP 2) — the shipped bytes can never contradict the
 * blank catalog, and phrase-scrub amputations can never ship dangling conjunctions.
 *
 * Pinned against the 2026-08-19 B0DSQPZY9S craft review (adversarially verified):
 *  HIGH 1: "midweight" ×3 shipped for a Gildan 64000 — LIGHTWEIGHT 4.5 oz per blank_specs.
 *  HIGH 2: "…the classic tee shape layers cleanly under flannels, or.</p>" — a scrub amputation.
 *  HIGH 3: backend claimed "customize photo … personalized" on a fixed-design listing.
 */
import { describe, it, expect } from 'vitest'
import { enforceFabricTruth, trueWeightClass, capabilityBanTokens, stripCapabilityClaims, DEFAULT_BLANK_SPECS } from './blankSpecs'

const GILDAN = DEFAULT_BLANK_SPECS[1].spec   // lightweight 4.5 oz, NO stretch field
const CC = DEFAULT_BLANK_SPECS[0].spec       // midweight 6.1 oz, Low Stretch

describe('weight-class truth', () => {
  it('rewrites the live HIGH: "midweight" → "lightweight" for the Gildan 64000', () => {
    const out = enforceFabricTruth('this midweight cotton shirt feels substantial', GILDAN)
    expect(out).toBe('this lightweight cotton shirt feels substantial')
  })

  it('rewrites every occurrence, matching the ×3 live defect', () => {
    const d = '<p>midweight cotton.</p><ul><li>fit in midweight cotton</li></ul><p>The midweight knit.</p>'
    const out = enforceFabricTruth(d, GILDAN)
    expect(out.match(/lightweight/g)).toHaveLength(3)
    expect(out).not.toMatch(/midweight/i)
  })

  it('is direction-agnostic: "lightweight" on a Comfort Colors becomes "midweight"', () => {
    expect(enforceFabricTruth('a lightweight garment-dyed tee', CC)).toBe('a midweight garment-dyed tee')
  })

  it('REMOVES the claim entirely when the blank is unconfirmed (no invented facts)', () => {
    const out = enforceFabricTruth('this heavyweight cotton shirt', null)
    expect(out).toBe('this cotton shirt')
  })

  it('handles hyphen/space variants (mid-weight, heavy weight)', () => {
    expect(enforceFabricTruth('a mid-weight tee and a heavy weight hoodie', GILDAN))
      .toBe('a lightweight tee and a lightweight hoodie')
  })

  it('is idempotent — a truthful text passes byte-identical', () => {
    const clean = 'this lightweight ring-spun cotton tee drapes easily'
    expect(enforceFabricTruth(clean, GILDAN)).toBe(clean)
    expect(enforceFabricTruth(enforceFabricTruth(clean, GILDAN), GILDAN)).toBe(clean)
  })
})

describe('stretch truth', () => {
  it('strips stretch claims for a Low Stretch blank (the morning GAP 2 flag)', () => {
    const out = enforceFabricTruth('soft fabric with stretchable comfort and 4-way stretch panels', CC)
    expect(out).not.toMatch(/stretch/i)
  })

  it('strips stretch claims when the spec is silent (Gildan has no stretch field)', () => {
    expect(enforceFabricTruth('a stretchy relaxed tee', GILDAN)).not.toMatch(/stretch/i)
  })
})

describe('dangling-conjunction tidy (the ", or." amputation)', () => {
  it('repairs the exact live artifact inside HTML', () => {
    const d = '<p>the classic tee shape layers cleanly under flannels, or.</p>'
    expect(enforceFabricTruth(d, GILDAN)).toBe('<p>the classic tee shape layers cleanly under flannels.</p>')
  })

  it('repairs a bare-text dangling conjunction mid-paragraph', () => {
    expect(enforceFabricTruth('pairs with jeans, and. The knit holds up.', GILDAN))
      .toBe('pairs with jeans. The knit holds up.')
  })
})

describe('backend capability truth', () => {
  it('bans nothing for a genuinely Amazon-Custom listing', () => {
    expect(capabilityBanTokens(true)).toEqual([])
    expect(stripCapabilityClaims('personalized custom gift tee', true)).toBe('personalized custom gift tee')
  })

  it('strips the exact live junk from a fixed-design backend string', () => {
    const live = 'women shirts dont quit motivational bold graphic design customize photo printed front back personalized y2k'
    const out = stripCapabilityClaims(live, false)
    expect(out).toBe('women shirts dont quit motivational bold graphic design printed front back y2k')
  })

  it('keeps legitimate tokens that merely contain a banned substring', () => {
    // "customer" is not "custom" — token-exact matching only.
    expect(stripCapabilityClaims('customer favorite tee', false)).toBe('customer favorite tee')
  })
})

describe('trueWeightClass', () => {
  it('reads all three classes and null for unknown', () => {
    expect(trueWeightClass(GILDAN)).toBe('lightweight')
    expect(trueWeightClass(CC)).toBe('midweight')
    expect(trueWeightClass({ weightNote: 'heavyweight 8 oz fleece' })).toBe('heavyweight')
    expect(trueWeightClass(null)).toBeNull()
  })
})
