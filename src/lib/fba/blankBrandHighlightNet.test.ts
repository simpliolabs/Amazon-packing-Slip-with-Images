import { describe, it, expect, vi } from 'vitest'
import { DEFAULT_BLANK_SPECS, matchBlankSpec, matchBlankSpecRow, ensureBlankBrandInHighlights, applyBlankBrandNetToDetails } from './blankSpecs'
import { buildDetailPatchValue, capItemHighlightRepeats } from './productDetailAttrs'
import { CONTENT_CONTRACT } from './contentContract'

/** The ONE budget under test — never a literal, so a contract change cannot leave these tests
 *  passing against a scenario that no longer exists (exactly what froze T4.5 at 75). */
const IH_MAX = CONTENT_CONTRACT.itemHighlights.max

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
    expect(out.length).toBeLessThanOrEqual(IH_MAX)
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

  it('T4.5 a FULL-budget input is re-capped at a comma boundary; the brand survives because it is FIRST', () => {
    // Scaled to the CONTRACT budget (2026-08-10: 75 -> 125). Frozen at 75 this stopped exercising the
    // re-cap entirely once the budget rose — a test that passes because the scenario no longer occurs.
    const hl = 'soft garment-dyed cotton feel, relaxed crew neck comfort, all-day easy wear, breathable everyday softness, true to size'
    expect(hl.length).toBeGreaterThan(IH_MAX - 10)   // genuinely near the ceiling
    expect(hl.length).toBeLessThanOrEqual(IH_MAX)
    const out = ensureBlankBrandInHighlights(hl, [LOCKED_TITLE_NO_BRAND], CC)
    expect(out.startsWith('authentic Comfort Colors blank')).toBe(true)
    expect(out.length).toBeLessThanOrEqual(IH_MAX)
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
    // The floor is "<2 phrases would remain", NOT a length rule — so the fixture must be long enough
    // that the brand cannot be added within the CURRENT budget. At the old 75 a 71-char single phrase
    // did that; at 125 it does not (and the net now correctly INSERTS, which is the raised cap
    // working). Sized off IH_MAX so this keeps testing the floor at any future budget.
    const hl = 'soft breathable ring-spun cotton with a relaxed easygoing everyday feel'.padEnd(IH_MAX - 5, ' x')
    expect(hl.length).toBeGreaterThan(IH_MAX - 10)
    expect(ensureBlankBrandInHighlights(hl, [LOCKED_TITLE_NO_BRAND], CC)).toBe(hl)
  })

  it('T4.7b THE RAISED CAP: a phrase set that had NO room at 75 now takes the brand at 125', () => {
    // Regression pin for the 2026-08-10 ruling. Under the old budget this returned the input unchanged
    // (the brand could not fit), so the blank-brand waterfall silently failed on longer highlights.
    const hl = 'soft breathable ring-spun cotton with a relaxed easygoing everyday feel'
    const out = ensureBlankBrandInHighlights(hl, [LOCKED_TITLE_NO_BRAND], CC)
    expect(out.startsWith('authentic Comfort Colors blank')).toBe(true)
    expect(out).toContain('ring-spun cotton')          // original content retained, not evicted
    expect(out.length).toBeLessThanOrEqual(IH_MAX)
    expect(out.length).toBeGreaterThan(75)             // proves it uses space the old cap denied
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
    expect(String(entry.value).length).toBeLessThanOrEqual(IH_MAX)
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
    expect(String(out.details[1].recommended_value).length).toBeLessThanOrEqual(IH_MAX)
    // WATERFALL WINS (SELLER_PROFILE §5, ruling 2026-08-08): the rewritten row is stamped with
    // spec provenance (blank_specs-derived) so the NEXT regen's sticky gate reads it as a
    // legitimate spec re-propose instead of snapping it back and re-netting every regen.
    expect((out.details[1] as { value_source?: string }).value_source).toBe('spec')
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
