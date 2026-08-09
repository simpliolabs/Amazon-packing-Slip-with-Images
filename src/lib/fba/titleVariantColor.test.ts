import { describe, it, expect } from 'vitest'
import {
  collapseRepeatedWords,
  enforceInclusiveAudience,
  enforceTitleBand,
  fixApostropheCase,
  stripVariantColorWords,
  TITLE_BAND_LO,
  TITLE_BAND_HI,
  type TitleBandCtx,
  type VariantColorCtx,
} from './titleBand'
import { scrubTrademarks } from './trademarkGuard'

/* ─────────────────────────────────────────────────────────────────────────────────────────────────
 * DEFECT B — A COLOR WORD IN A SHARED TITLE (SELLER_PROFILE §5, live B0GVVY5TS9 2026-08-09 18:54).
 *
 * SHIPPED, verbatim:
 *   THE CEO Futbol World Futbol Cup Soccer Tee Shirt | the Black Short Sleeve
 *
 * §5: "Colors: shared title/bullets carry NO color word; colors rank per-child via each child's own
 * backend tail." §3: "no variant attributes (size/color)". The rule existed only as an upstream POOL
 * filter, which a council-written color word walks straight past — so it is now a deterministic net
 * on the shipped bytes, in the same `bandTitle` seam as enforceMoneyTail / enforceInclusiveAudience.
 */

/** The exact live specimen, as the PO saw it. */
const LIVE_SHIPPED = 'THE CEO Futbol World Futbol Cup Soccer Tee Shirt | the Black Short Sleeve'
/** The same title as the COLOR net actually sees it in the door — downstream of the trademark
 *  scrub, which is where DEFECT A is cured. Isolated-net assertions use this; the composed-door
 *  block below starts from the raw council output and runs the whole chain. */
const LIVE_AFTER_TM = 'THE CEO World Futbol Cup Soccer Tee Shirt | the Black Short Sleeve'

/** The two PO golds. SELLER_PROFILE §3: "Protected as test fixtures — no net may alter them." */
const GOLD_CHRISTIAN = 'THE CEO I Will Praise Him in Every Season Tee | Christian Shirts for Women'
const GOLD_ALLIGATOR = 'THE CEO See You Later Alligator Shirt | Long Sleeve Comfort Colors Shirt'

/** The facts a Comfort Colors 1717 tee actually has — nothing invented (twin of titleBand.test.ts). */
const CC_BAND: TitleBandCtx = {
  apparel: true,
  garmentBrand: 'Comfort Colors',
  spec: { fit: 'Relaxed Fit', sleeve: 'Short Sleeve', neck: 'Crewneck' },
  garmentSecond: 'Tee',
}
/** A fact-starved listing — no blank_specs row matched, so the pad has nothing to give back. */
const NO_FACTS: TitleBandCtx = { apparel: true, garmentBrand: null, spec: null, garmentSecond: null }

const ctx = (over: Partial<VariantColorCtx> = {}): VariantColorCtx =>
  ({ apparel: true, protect: null, band: CC_BAND, ...over })

describe('stripVariantColorWords — the §5 rule on shipped bytes', () => {
  it('pins the live specimen at the length the PO actually saw', () => {
    expect(LIVE_SHIPPED.length).toBe(73)
    expect(scrubTrademarks(LIVE_SHIPPED)).toBe(LIVE_AFTER_TM)
  })

  it('removes the color word from the LIVE broadcast title and lands back in band', () => {
    const r = stripVariantColorWords(LIVE_AFTER_TM, ctx({ protect: 'World Cup Soccer' }))
    expect(r.decision).toBe('stripped')
    expect(r.title).not.toMatch(/\bblack\b/i)
    expect(r.title.length).toBeGreaterThanOrEqual(TITLE_BAND_LO)
    expect(r.title.length).toBeLessThanOrEqual(TITLE_BAND_HI)
    // The design identity and the garment nouns survive untouched.
    expect(r.title).toContain('THE CEO')
    expect(r.title).toContain('Soccer Tee Shirt')
    // The freed characters came back from a PRODUCT FACT, never the pool.
    expect(r.title).toContain('Comfort Colors')
  })

  it('is IDEMPOTENT — the applied result re-enters as no-color, byte-identical', () => {
    const once = stripVariantColorWords(LIVE_AFTER_TM, ctx({ protect: 'World Cup Soccer' })).title
    const twice = stripVariantColorWords(once, ctx({ protect: 'World Cup Soccer' }))
    expect(twice.decision).toBe('no-color')
    expect(twice.title).toBe(once)
  })

  it('NEVER strips a color word that IS the design ("Black Cat")', () => {
    const t = 'THE CEO Black Cat Halloween Tee Shirt | Comfort Colors Relaxed Fit Tshirt'
    const r = stripVariantColorWords(t, ctx({ protect: 'Black Cat' }))
    expect(r.decision).toBe('design-color')
    expect(r.title).toBe(t)
  })

  it('strips the VARIANT color while keeping the DESIGN color in the same title', () => {
    // "Pink" is the design ("Pink Ribbon"); "Navy" is the shirt's shade and must go.
    const t = 'THE CEO Pink Ribbon Awareness Navy Tee Shirt | Comfort Colors Relaxed Tshirt'
    const r = stripVariantColorWords(t, ctx({ protect: 'Pink Ribbon' }))
    expect(r.decision).toBe('stripped')
    expect(r.title).toContain('Pink Ribbon')
    expect(r.title).not.toMatch(/\bnavy\b/i)
    expect(r.note).toContain('1 kept as design vocabulary')
  })

  it('BAND-GUARD: refuses byte-identical when the facts cannot re-fill the freed characters', () => {
    const r = stripVariantColorWords(LIVE_AFTER_TM, ctx({ protect: 'World Cup Soccer', band: NO_FACTS }))
    expect(r.decision).toBe('band-guard')
    expect(r.title).toBe(LIVE_AFTER_TM)     // byte-identical
    expect(r.note).toContain('refused, byte-identical')
  })

  it('skips non-apparel outright — there a color is a product fact, not a variant attribute', () => {
    const t = 'Acme Black Aluminum Laptop Stand Adjustable Ergonomic Riser for Desk'
    const r = stripVariantColorWords(t, ctx({ apparel: false }))
    expect(r.decision).toBe('non-apparel')
    expect(r.title).toBe(t)
  })

  it('uses the SAME base vocabulary as the pool filters — compound colorways are NOT stripped', () => {
    // 'forest' / 'sky' / 'wine' / 'gold' live in COMPOUND_COLOR_WORDS precisely because they are
    // ordinary design vocabulary; only the base 28 are variant attributes in running copy.
    const t = 'THE CEO Forest Bathing Wine Lover Tee Shirt | Comfort Colors Relaxed Tshirt'
    const r = stripVariantColorWords(t, ctx({ protect: null }))
    expect(r.decision).toBe('no-color')
    expect(r.title).toBe(t)
  })

  it('leaves both PO golds byte-identical', () => {
    for (const gold of [GOLD_CHRISTIAN, GOLD_ALLIGATOR]) {
      expect(stripVariantColorWords(gold, ctx({ protect: null })).title).toBe(gold)
      expect(stripVariantColorWords(gold, ctx({ protect: 'I Will Praise Him in Every Season' })).title).toBe(gold)
    }
  })

  it('is a structural no-op on empty input (the degrade gate owns that case)', () => {
    expect(stripVariantColorWords('', ctx()).decision).toBe('empty')
  })
})

/* ─────────────────────────────────────────────────────────────────────────────────────────────────
 * THE COMPOSED DOOR. The defect shipped through a COMPOSITION of nets, not through one function, so
 * the live specimen is asserted end-to-end in `bandTitle`'s wire order (listingPipeline.ts:7911):
 *   scrubTrademarks (generation exit) → fixApostropheCase → specTruth → cap → collapseRepeatedWords
 *   → enforceMoneyTail → stripVariantColorWords → enforceInclusiveAudience → enforceTitleBand
 * (specTruth/cap/moneyTail are no-ops on this fixture and are omitted for readability.)
 */
const door = (raw: string, protect: string, band: TitleBandCtx = CC_BAND): string => {
  const scrubbed = scrubTrademarks(raw)
  const cased = fixApostropheCase(scrubbed)
  const deduped = collapseRepeatedWords(cased).title
  const decolored = stripVariantColorWords(deduped, { apparel: true, protect, band }).title
  const inclusive = enforceInclusiveAudience(decolored, { apparel: true, lean: null, band }).title
  return enforceTitleBand(inclusive, band).title
}

describe('bandTitle door — the B0GVVY5TS9 regen, both defects at once', () => {
  /** What the council actually produced, before any net touched it. */
  const COUNCIL = 'THE CEO Futbol World Cup Soccer Tee Shirt | The Black Short Sleeve'

  it('ships neither the doubled trademark substitution nor the color word', () => {
    const out = door(COUNCIL, 'World Cup Soccer')
    expect(out).not.toMatch(/futbol\s+world\s+futbol/i)   // DEFECT A
    expect(out).not.toMatch(/\bworld\s+cup\b/i)           // the mark itself is still gone
    expect(out).toMatch(/world futbol cup/i)              // ... via the safe phrasing, printed ONCE
    expect(out).not.toMatch(/\bblack\b/i)                 // DEFECT B
    expect(out.length).toBeGreaterThanOrEqual(TITLE_BAND_LO)
    expect(out.length).toBeLessThanOrEqual(TITLE_BAND_HI)
  })

  it('is a FIXED POINT — a second trip through the door changes nothing', () => {
    const once = door(COUNCIL, 'World Cup Soccer')
    expect(door(once, 'World Cup Soccer')).toBe(once)
  })

  it('THE OSCILLATION IS DEAD: the dedupe can never hand a bare trademark back to the scrub', () => {
    // The non-adjacent shape the absorb pass deliberately does NOT rewrite. Pre-fix, the dedupe
    // deleted the repeated "Futbol" and the route's scrub-on-serve re-substituted it, forever.
    const scrubbed = scrubTrademarks('THE CEO Futbol Shirt World Cup Soccer Tee for Women')
    expect(scrubbed).toContain('World Futbol Cup')
    const deduped = collapseRepeatedWords(scrubbed)
    expect(deduped.refusedForTrademark).toBe(true)
    expect(deduped.title).toBe(scrubbed)                  // byte-identical, fail-open
    expect(scrubTrademarks(deduped.title)).toBe(scrubbed) // and the next scrub is a no-op
  })

  it('leaves gold #1 byte-identical through the whole door', () => {
    expect(door(GOLD_CHRISTIAN, 'I Will Praise Him in Every Season')).toBe(GOLD_CHRISTIAN)
  })

  it('gold #2: neither new net touches it (the known collapseRepeatedWords conflict is unrelated)', () => {
    // `collapseRepeatedWords` (#148) strips gold #2's second "Shirt" — a PRE-EXISTING conflict with
    // SELLER_PROFILE §3, already pinned in titleInclusiveAudience.test.ts:134. Neither the trademark
    // absorb nor the color net contributes to it, which is what this asserts.
    expect(scrubTrademarks(GOLD_ALLIGATOR)).toBe(GOLD_ALLIGATOR)
    expect(stripVariantColorWords(GOLD_ALLIGATOR, { apparel: true, protect: 'See You Later Alligator', band: CC_BAND }).title)
      .toBe(GOLD_ALLIGATOR)
    // …and the door minus that one pre-existing net is byte-identical.
    const decolored = stripVariantColorWords(fixApostropheCase(scrubTrademarks(GOLD_ALLIGATOR)), { apparel: true, protect: 'See You Later Alligator', band: CC_BAND }).title
    expect(enforceTitleBand(enforceInclusiveAudience(decolored, { apparel: true, lean: null, band: CC_BAND }).title, CC_BAND).title)
      .toBe(GOLD_ALLIGATOR)
  })
})
