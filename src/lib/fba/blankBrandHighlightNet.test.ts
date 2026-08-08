import { describe, it, expect, vi } from 'vitest'
import { DEFAULT_BLANK_SPECS, matchBlankSpec, matchBlankSpecRow, ensureBlankBrandInHighlights, applyBlankBrandNetToDetails } from './blankSpecs'
import { buildDetailPatchValue, capItemHighlightRepeats } from './productDetailAttrs'

// Same guard as blankSpecs.test.ts: never let a unit test touch a real supabase client.
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: () => ({ select: () => ({ eq: () => ({ order: () => new Promise(() => { /* never settles */ }) }) }) }),
  }),
}))

const CC = DEFAULT_BLANK_SPECS[0]     // Comfort Colors — brand allowed in copy
const GILDAN = DEFAULT_BLANK_SPECS[1] // brandInCopy: false — NEVER in copy

const LOCKED_TITLE_NO_BRAND = 'THE CEO See You Later Alligator Shirt | Long Sleeve Shirt for Women'
const TITLE_WITH_BRAND = 'THE CEO See You Later Alligator Shirt | Long Sleeve Comfort Colors Shirt'

describe('matchBlankSpecRow — row-returning twin of matchBlankSpec', () => {
  it('returns the ROW (match regex + spec); matchBlankSpec delegates to it identically', () => {
    const row = matchBlankSpecRow(DEFAULT_BLANK_SPECS, 'Comfort Colors Shirt')
    expect(row?.spec.brand).toBe('Comfort Colors')
    expect(row?.match).toBeInstanceOf(RegExp)
    expect(matchBlankSpec(DEFAULT_BLANK_SPECS, 'Comfort Colors Shirt')).toBe(row?.spec)
    expect(matchBlankSpecRow(DEFAULT_BLANK_SPECS, 'Ceramic Mug')).toBeNull()
  })
})

describe('ensureBlankBrandInHighlights — the PO 2026-08-08 blank-brand waterfall net', () => {
  it('T4.1 inserts the brand FIRST when the locked title lacks it (B0FKKN8XKV shape)', () => {
    const hl = 'soft ring-spun cotton, relaxed crew neck fit'
    const out = ensureBlankBrandInHighlights(hl, [LOCKED_TITLE_NO_BRAND], CC)
    expect(out.startsWith('authentic Comfort Colors blank')).toBe(true)
    expect(out.length).toBeLessThanOrEqual(75)
    expect(out.split(',').length).toBeGreaterThanOrEqual(2)
  })

  it('T4.2 no-ops when EVERY title already carries the brand (waterfall satisfied)', () => {
    const hl = 'soft ring-spun cotton, relaxed crew neck fit'
    expect(ensureBlankBrandInHighlights(hl, [TITLE_WITH_BRAND], CC)).toBe(hl)
    // regex-level match too (spacing variant the plain includes() would miss)
    expect(ensureBlankBrandInHighlights(hl, ['ComfortColors Tee'], CC)).toBe(hl)
    // separator-blind (adversarial LOW): a hyphenated brand still counts as carried
    expect(ensureBlankBrandInHighlights(hl, ['Comfort-Colors Tee'], CC)).toBe(hl)
  })

  it('T4.2b multi-design: ANY shipped title lacking the brand triggers the insert (every(), not some())', () => {
    const hl = 'soft ring-spun cotton, relaxed crew neck fit'
    // broadcast title carries the brand but a per-child title does not → the ONE broadcast IH
    // must carry it (that child's PDP would otherwise show the brand nowhere)
    const out = ensureBlankBrandInHighlights(hl, [TITLE_WITH_BRAND, LOCKED_TITLE_NO_BRAND], CC)
    expect(out.startsWith('authentic Comfort Colors blank')).toBe(true)
    // all titles carry → satisfied
    expect(ensureBlankBrandInHighlights(hl, [TITLE_WITH_BRAND, 'Comfort-Colors Tee'], CC)).toBe(hl)
  })

  it('T4.3 NEVER Gildan — brandInCopy:false short-circuits (data-enforced, no second hardcode)', () => {
    const hl = 'soft ring-spun cotton, relaxed crew neck fit'
    expect(ensureBlankBrandInHighlights(hl, ['Gildan-less title'], GILDAN)).toBe(hl)
  })

  it('T4.4 idempotent — f(f(x)) = f(x), and an hl already carrying the brand is untouched', () => {
    const hl = 'soft ring-spun cotton, relaxed crew neck fit'
    const once = ensureBlankBrandInHighlights(hl, [LOCKED_TITLE_NO_BRAND], CC)
    expect(ensureBlankBrandInHighlights(once, [LOCKED_TITLE_NO_BRAND], CC)).toBe(once)
    // and the outer generation-path cap is a fixpoint over the netted string
    expect(capItemHighlightRepeats(once)).toBe(once)
  })

  it('T4.5 a full 75-char input is re-capped at a comma boundary; the brand survives because it is FIRST', () => {
    const hl = 'soft garment-dyed cotton feel, relaxed crew neck comfort, all-day easy wear' // 75 chars
    expect(hl.length).toBeLessThanOrEqual(76)
    const out = ensureBlankBrandInHighlights(hl, [LOCKED_TITLE_NO_BRAND], CC)
    expect(out.startsWith('authentic Comfort Colors blank')).toBe(true)
    expect(out.length).toBeLessThanOrEqual(75)
    expect(out.split(',').length).toBeGreaterThanOrEqual(2)
  })

  it('T4.6 word-fold collision: a later "comfort" phrase is evicted, the brand phrase is kept, no word >2x', () => {
    const hl = 'all-day comfort, crew neck comfort' // "comfort" x2 already at the cap
    const out = ensureBlankBrandInHighlights(hl, [LOCKED_TITLE_NO_BRAND], CC)
    expect(out.startsWith('authentic Comfort Colors blank')).toBe(true)
    // deterministic word census over the folded tokens: nothing >2
    const counts = new Map<string, number>()
    for (const w of out.toLowerCase().split(/[\s,/-]+/).filter(Boolean)) {
      counts.set(w, (counts.get(w) ?? 0) + 1)
    }
    for (const [, c] of counts) expect(c).toBeLessThanOrEqual(2)
    // the capped result is a fixpoint (the push boundary re-cap cannot change it)
    expect(capItemHighlightRepeats(out)).toBe(out)
  })

  it('T4.7 compliance floor: returns the ORIGINAL when insertion would leave <2 phrases', () => {
    const hl = 'soft breathable ring-spun cotton with a relaxed easygoing everyday feel' // 1 long phrase
    expect(ensureBlankBrandInHighlights(hl, [LOCKED_TITLE_NO_BRAND], CC)).toBe(hl)
  })

  it('no blank / no brand / empty hl -> unchanged', () => {
    expect(ensureBlankBrandInHighlights('a, b', [LOCKED_TITLE_NO_BRAND], null)).toBe('a, b')
    expect(ensureBlankBrandInHighlights('', [LOCKED_TITLE_NO_BRAND], CC)).toBe('')
  })
})

describe('T4.8 push boundary honors the net (buildDetailPatchValue preserves the brand-first phrase)', () => {
  it('capItemHighlightRepeats at the push boundary keeps EARLIER phrases — prepend = survival', () => {
    const stored = 'authentic Comfort Colors blank, soft cotton feel, relaxed crew neck comfort, all-day easy wear'
    const [entry] = buildDetailPatchValue({ spApiKey: 'title_differentiation', scope: 'broadcast' }, stored, 'ATVPDKIKX0DER')
    expect(String(entry.value).startsWith('authentic Comfort Colors blank')).toBe(true)
    expect(String(entry.value).length).toBeLessThanOrEqual(75)
  })
})

describe('T4.9 applyBlankBrandNetToDetails — the stored-IH re-net for title partials + the lock guard', () => {
  const details = [
    { field_name: 'Material', recommended_value: '100% Ring-Spun Cotton' },
    { field_name: 'Item Highlights', recommended_value: 'soft ring-spun cotton, relaxed crew neck fit' },
  ]

  it('inserts the brand into the IH row when the shipped title lacks it; other rows untouched', () => {
    const out = applyBlankBrandNetToDetails(details, [LOCKED_TITLE_NO_BRAND], CC)
    expect(out.changed).toBe(true)
    expect(String(out.details[1].recommended_value).startsWith('authentic Comfort Colors blank')).toBe(true)
    expect(String(out.details[1].recommended_value).length).toBeLessThanOrEqual(75)
    expect(out.details[0]).toBe(details[0]) // non-IH rows keep identity
    expect(details[1].recommended_value).toBe('soft ring-spun cotton, relaxed crew neck fit') // input not mutated
  })

  it('no-ops (changed:false, same reference) when the title carries the brand, the blank is null, or there is no IH row', () => {
    expect(applyBlankBrandNetToDetails(details, [TITLE_WITH_BRAND], CC)).toEqual({ details, changed: false })
    expect(applyBlankBrandNetToDetails(details, [LOCKED_TITLE_NO_BRAND], null).changed).toBe(false)
    expect(applyBlankBrandNetToDetails([details[0]], [LOCKED_TITLE_NO_BRAND], CC).changed).toBe(false)
    expect(applyBlankBrandNetToDetails(undefined, [LOCKED_TITLE_NO_BRAND], CC).changed).toBe(false)
  })

  it('NEVER Gildan — brand_in_copy=false short-circuits through the details path too', () => {
    expect(applyBlankBrandNetToDetails(details, ['Gildan-less title'], GILDAN).changed).toBe(false)
  })

  it('idempotent: re-running over its own output is a no-op', () => {
    const once = applyBlankBrandNetToDetails(details, [LOCKED_TITLE_NO_BRAND], CC)
    const twice = applyBlankBrandNetToDetails(once.details, [LOCKED_TITLE_NO_BRAND], CC)
    expect(twice.changed).toBe(false)
    expect(twice.details).toBe(once.details)
  })
})
