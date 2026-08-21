/**
 * SPEC-TOKEN HUMANIZER PIN (live B0GQ6PGR2N, 2026-08-20): the Item Highlights spec fallback shipped
 * "easy short_sleeve style" — a raw Amazon API MACHINE TOKEN in customer-facing copy. Enum detail
 * rows deliberately store the API token ("short_sleeve"; push requires it, the editor prettifies at
 * display only), so buildHighlightsFallback's val() seam must humanize every spec value it consumes:
 * underscores → spaces, Title Case, acronym caps preserved (ONE humanizer, shared with the composer's
 * caser — never a second casing implementation). These tests fail if the seam re-forks.
 */
import { describe, it, expect } from 'vitest'
import { buildHighlightsFallback, type PipelineProductDetailImprovement } from './listingPipeline'
import { humanizeSpecToken } from './itemHighlightComposer'

const row = (field_name: string, recommended_value: string): PipelineProductDetailImprovement =>
  ({ field_name, current_value: null, recommended_value, reason: 'test' })

describe('spec-derived machine tokens are humanized at the fallback seam', () => {
  it('humanizeSpecToken: underscores → spaces + Title Case, acronym caps kept, human labels untouched', () => {
    expect(humanizeSpecToken('short_sleeve')).toBe('Short Sleeve')
    expect(humanizeSpecToken('usb_c_cable')).toBe('USB C Cable')       // ACRONYM_CASE survives the split
    expect(humanizeSpecToken('Crew Neck')).toBe('Crew Neck')           // no underscore = pass-through
  })

  it('a fallback line built from a spec containing "short_sleeve" renders "Short Sleeve"', () => {
    const details = [
      row('Material', 'Cotton'),
      row('Fit Type', 'Relaxed'),
      row('Neck Style', 'Crew Neck'),
      row('Sleeve Type', 'short_sleeve'),   // the API enum token, exactly as the DB stores it
    ]
    const out = buildHighlightsFallback('THE CEO Gator Tee', 'Gator', details, 'THE CEO', true, false)
    expect(out).toContain('Short Sleeve')   // humanized AND cased for the customer-facing line
    expect(out).not.toMatch(/_/)            // no machine token ever ships
    expect(out.split(',').map((p) => p.trim()).filter(Boolean).length).toBeGreaterThanOrEqual(2)
  })
})
