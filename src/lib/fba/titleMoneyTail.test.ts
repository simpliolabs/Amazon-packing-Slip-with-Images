import { describe, it, expect } from 'vitest'
import { enforceMoneyTail, TITLE_BAND_LO, TITLE_BAND_HI, type MoneyTailCtx } from './titleBand'
import { buildPhraseTruthCtx } from './contentTruth'
import { designScopeTokens, isForeignToDesign } from './designScope'

/* ─────────────────────────────────────────────────────────────────────────────────────────────────
 * enforceMoneyTail (#147 title half, TITLE_MONEY_TAIL) — the deterministic gold-shape net.
 *
 * THE PO LOCK this encodes (B0FKKN8XKV, locked live):
 *   THE CEO I Will Praise Him in Every Season Tee | Christian Shirts for Women
 * i.e. `Brand + design + noun | <ONE high-volume category money keyword>`. The net must produce
 * exactly that shape when the keyword fits 70-75, and be BYTE-IDENTICAL (fail-open) in every other
 * case — never truncate the keyword, never touch the protected left side, never fight the lean.
 */

/** Comfort Colors blank facts (midweight — so a market "heavyweight" phrase must be refused). */
const CC_SPEC = { fit: 'Relaxed', weightNote: 'Midweight 6.1 oz garment-dyed' }
const APPAREL: MoneyTailCtx = { apparel: true, lean: null, spec: CC_SPEC, protect: null, garmentBrand: 'Comfort Colors' }

/* The THREE PO golds, pinned as fixtures. */
const GOLD_CHRISTIAN = 'THE CEO I Will Praise Him in Every Season Tee | Christian Shirts for Women'
const GOLD_ALLIGATOR = 'THE CEO See You Later Alligator Shirt | Long Sleeve Comfort Colors Shirt'
const GOLD_SOCCER = 'THE CEO 2026 World Soccer Cup Tee Shirt | USA Mexico Canada Football Tee'

describe('enforceMoneyTail — PO gold fixtures', () => {
  it('pins the gold fixtures at their recorded lengths', () => {
    expect(GOLD_CHRISTIAN.length).toBe(74)
    expect(GOLD_ALLIGATOR.length).toBe(72)
    expect(GOLD_SOCCER.length).toBe(72)
  })

  it('B0FKKN8XKV lock: design-led title + money keyword → the EXACT locked gold', () => {
    const v = enforceMoneyTail(
      'THE CEO I Will Praise Him in Every Season Tee for Women',
      'christian shirts for women',
      { ...APPAREL, lean: 'female', protect: 'I Will Praise Him in Every Season' },
    )
    expect(v.decision).toBe('applied')
    expect(v.title).toBe(GOLD_CHRISTIAN)
    expect(v.title.length).toBeGreaterThanOrEqual(TITLE_BAND_LO)
    expect(v.title.length).toBeLessThanOrEqual(TITLE_BAND_HI)
  })

  it('PO RULING 2026-08-09 — direction A: a BRAND pipe tail is still PROTECTED, never evicted', () => {
    // The adversarial probe showed this mechanic deleting "Long Sleeve" and evicting "Comfort
    // Colors" from the CANONICAL protected gold #2 for ANY qualifying keyword. The PO ruling keeps
    // exactly this half: §2 — "the Comfort Colors name IS a selling point"; §3 — a tail carrying
    // the garment BRAND stays protected. Fail-open, byte-identical.
    const v = enforceMoneyTail(
      'THE CEO I Will Praise Him in Every Season Tee | Comfort Colors Shirt',
      'christian shirts for women',
      { ...APPAREL, protect: 'I Will Praise Him in Every Season' },
    )
    expect(v.decision).toBe('brand-tail')
    expect(v.title).toBe('THE CEO I Will Praise Him in Every Season Tee | Comfort Colors Shirt')
  })

  /* ── PO RULING 2026-08-09 — direction B: THE MONEY TAIL BEATS A SPEC-FACT TAIL ─────────────────
   * The ruling's own specimen, from the B0GVV3XL4T rewrite:
   *   AI:  THE CEO 2026 World Soccer Cup USA Mexico Canada Unisex Tee | Classic Fit   (72)
   *   PO:  THE CEO 2026 World Soccer Cup Tee Shirt | USA Mexico Canada Football Tee   (72)
   * "the pipe-right is the MONEY position; a spec FACT there ('Classic Fit') is a waste of the
   * highest-value real estate." Before this change every one of these returned 'fact-tail' and the
   * title shipped with the fact — verified against the shipped net, not assumed. */
  describe('a pure SPEC-FACT pipe tail is now REPLACEABLE', () => {
    const GILDAN = { fit: 'Classic', sleeve: 'Short Sleeve', neck: 'Crew Neck', weightNote: 'lightweight 4.5 oz ring-spun' }

    it('"| Classic Fit" is evicted for the money keyword (the ruling\'s own case)', () => {
      const v = enforceMoneyTail(
        'THE CEO 2026 World Soccer Cup USA Mexico Canada Tee | Classic Fit',
        'football tee shirt',
        { apparel: true, lean: null, spec: GILDAN, protect: '2026 World Soccer Cup', garmentBrand: null },
      )
      expect(v.decision).toBe('applied')
      expect(v.title).toBe('THE CEO 2026 World Soccer Cup USA Mexico Canada Tee | Football Tee Shirt')
      expect(v.title).not.toMatch(/classic fit/i)
      expect(v.title.length).toBeGreaterThanOrEqual(TITLE_BAND_LO)
      expect(v.title.length).toBeLessThanOrEqual(TITLE_BAND_HI)
    })

    it.each([
      ['a bare sleeve/fit phrase', 'THE CEO See You Later Alligator Tee Shirt | Short Sleeve Crew Neck'],
      ['a spec tail on the Gildan blank', 'THE CEO See You Later Alligator Tee Shirt | Lightweight Classic Fit'],
    ])('%s no longer blocks the money keyword', (_n, title) => {
      const v = enforceMoneyTail(title, 'christian shirts for women',
        { apparel: true, lean: null, spec: GILDAN, protect: 'See You Later Alligator', garmentBrand: null })
      expect(v.decision).toBe('applied')
      expect(v.title).toBe('THE CEO See You Later Alligator Tee Shirt | Christian Shirts for Women')
    })

    it('the BRAND guard still fires when the same tail ALSO carries the brand', () => {
      // "Long Sleeve Comfort Colors Shirt" is a spec phrase AND a brand phrase. The ruling protects
      // it on the brand axis alone, which is the whole reason gold #2 survives direction B.
      const v = enforceMoneyTail(GOLD_ALLIGATOR, 'christian shirts for women',
        { ...APPAREL, protect: 'See You Later Alligator' })
      expect(v.decision).toBe('brand-tail')
      expect(v.title).toBe(GOLD_ALLIGATOR)
    })
  })

  it('alligator gold with NO qualifying keyword is byte-identical (fail-open)', () => {
    const v = enforceMoneyTail(GOLD_ALLIGATOR, null, { ...APPAREL, protect: 'See You Later Alligator' })
    expect(v.decision).toBe('no-kw')
    expect(v.title).toBe(GOLD_ALLIGATOR)
  })

  it('THE MISSING FIXTURE (adversarial HIGH): alligator gold + a DISTINCT qualifying keyword is byte-identical', () => {
    // This is the only case where the net ever threatened gold #2 — the probe run showed the
    // pre-guard net rewriting it to "…Alligator Shirt | Comfort Colors Shirts for Women" (deleting
    // "Long Sleeve") and to "…Alligator Shirt | Cute Graphic Tshirts for Women" (evicting the
    // Comfort Colors brand ENTIRELY). The fact-tail guard pins the gold byte-identical.
    for (const kw of ['comfort colors shirts for women', 'cute graphic tshirts for women']) {
      const v = enforceMoneyTail(GOLD_ALLIGATOR, kw, { ...APPAREL, protect: 'See You Later Alligator' })
      expect(v.decision).toBe('brand-tail')
      expect(v.title).toBe(GOLD_ALLIGATOR)
    }
  })

  it('brand-tail fires from the BRAND LEXICON alone (garmentBrand unresolved) — gold #2 is a FIXTURE, not a lucky resolve', () => {
    // The hole the PO ruling opened: the old guard protected this tail via its SPEC lexicon
    // ('sleeve'), which the ruling deletes. If the brand guard depended solely on ctx.garmentBrand,
    // gold #2 would become attackable on every regen where the blank row failed to match. §3
    // protects the golds as FIXTURES, unconditionally — hence MONEY_BRAND_TAIL_PHRASES.
    const v = enforceMoneyTail(GOLD_ALLIGATOR, 'cute graphic tshirts for women',
      { ...APPAREL, garmentBrand: null, protect: 'See You Later Alligator' })
    expect(v.decision).toBe('brand-tail')
    expect(v.title).toBe(GOLD_ALLIGATOR)
  })

  it('gold #3 (soccer, 2026-08-09) is byte-identical under attack keywords', () => {
    // Its tail is the MONEY keyword already — every candidate must either see it as covered or
    // refuse to touch a keyword-bearing tail it cannot improve. Never a rewrite.
    for (const kw of ['usa mexico canada football tee', 'football tee shirt', 'soccer shirts for women']) {
      const v = enforceMoneyTail(GOLD_SOCCER, kw,
        { apparel: true, lean: null, spec: null, protect: '2026 World Soccer Cup', garmentBrand: null })
      expect(v.title).toBe(GOLD_SOCCER)
      expect(v.decision).not.toBe('applied')
    }
  })

  it('alligator gold whose tail already indexes the keyword → already-covered, byte-identical', () => {
    const v = enforceMoneyTail(GOLD_ALLIGATOR, 'comfort colors shirt', { ...APPAREL, protect: 'See You Later Alligator' })
    expect(v.decision).toBe('already-covered')
    expect(v.title).toBe(GOLD_ALLIGATOR)
  })

  it('is IDEMPOTENT — the applied gold re-enters as already-covered, byte-identical', () => {
    const once = enforceMoneyTail(
      'THE CEO I Will Praise Him in Every Season Tee for Women',
      'christian shirts for women',
      { ...APPAREL, lean: 'female' },
    )
    expect(once.decision).toBe('applied')
    const twice = enforceMoneyTail(once.title, 'christian shirts for women', { ...APPAREL, lean: 'female' })
    expect(twice.decision).toBe('already-covered')
    expect(twice.title).toBe(once.title)
  })
})

describe('enforceMoneyTail — skip table (every skip must be byte-identical)', () => {
  const cases: Array<{
    name: string
    title: string
    kw: string | null
    ctx: MoneyTailCtx
    decision: string
  }> = [
    {
      name: 'lock/per-child passthrough: pipeline passes null keyword → no-kw',
      title: 'THE CEO Cashflow Cap | Puff Embroidery Cotton Twill Snapback Hat for Men',
      kw: null,
      ctx: APPAREL,
      decision: 'no-kw',
    },
    {
      name: 'non-apparel never gets the garment money tail',
      title: 'THE CEO 128GB Micro SD Memory Card High Speed for Action Cameras',
      kw: 'micro sd card shirts',
      ctx: { apparel: false },
      decision: 'non-apparel',
    },
    {
      name: 'cross-gender vs seller lean: masc-only keyword on a lean_female listing',
      title: 'THE CEO I Will Praise Him in Every Season Tee for Women',
      kw: 'mens christian shirts',
      ctx: { ...APPAREL, lean: 'lean_female' },
      decision: 'cross-gender',
    },
    {
      name: 'cross-gender vs the TITLE tail: masc-only keyword on a "for Women" title (lean unset)',
      title: 'THE CEO I Will Praise Him in Every Season Tee for Women',
      kw: 'mens graphic tshirts',
      ctx: { ...APPAREL, lean: null },
      decision: 'cross-gender',
    },
    {
      name: 'word-repeat: keyword re-prints a significant NON-garment left-side word',
      title: 'THE CEO Christian Faith Over Fear Tee Shirt for Women',
      kw: 'cute christian shirts',
      ctx: APPAREL,
      decision: 'word-repeat',
    },
    {
      name: 'word-repeat: a SECOND garment-family repeat is refused (only one allowed)',
      title: 'THE CEO Later Gator Tee Shirt Comfort Colors Graphic for Women',
      kw: 'christian tee shirts for women',
      ctx: APPAREL,
      decision: 'word-repeat',
    },
    {
      name: 'design-right: the pipe right side carries the design phrase — never replaced',
      title: 'THE CEO Faith Tee | I Will Praise Him in Every Season',
      kw: 'christian shirts for women',
      ctx: { ...APPAREL, protect: 'I Will Praise Him in Every Season' },
      decision: 'design-right',
    },
    {
      name: 'design-right when NO design name resolved: a pipe right cannot be PROVEN replaceable (fail-open, not guard-off)',
      title: 'THE CEO Faith Tee Shirt Everyday Wear | Cozy Fall Vibes Graphic',
      kw: 'christian shirts for women',
      ctx: { ...APPAREL, protect: null },
      decision: 'design-right',
    },
    {
      name: 'no-tail: the net only ever REPLACES a tail — a title with neither pipe nor audience tail is never appended to',
      title: 'THE CEO Praise Him Faith Over Fear Every Season Tee',
      kw: 'christian shirts for women',
      ctx: { ...APPAREL, protect: 'Praise Him Faith Over Fear' },
      decision: 'no-tail',
    },
    {
      name: 'spec-conflict: a market "heavyweight" phrase cannot re-leak onto a midweight blank',
      title: 'THE CEO I Will Praise Him in Every Season Tee for Women',
      kw: 'heavyweight faith shirts',
      ctx: APPAREL,
      decision: 'spec-conflict',
    },
    {
      name: 'no-fit under the band: short design phrase cannot reach 70 — keyword never padded',
      title: 'THE CEO Later Gator Tee for Women',
      kw: 'christian shirts for women',
      ctx: APPAREL,
      decision: 'no-fit',
    },
    {
      name: 'no-fit over the cap: audience NOT on the left, so the keyword suffix may not be dropped',
      title: 'THE CEO I Will Praise Him in Every Single Season Long Tee for Women',
      kw: 'christian shirts for women',
      ctx: APPAREL,
      decision: 'no-fit',
    },
    {
      name: 'empty title is the degrade gate\'s call, never this net\'s',
      title: '',
      kw: 'christian shirts for women',
      ctx: APPAREL,
      decision: 'empty',
    },
  ]

  it.each(cases)('$name', ({ title, kw, ctx, decision }) => {
    const v = enforceMoneyTail(title, kw, ctx)
    expect(v.decision).toBe(decision)
    expect(v.title).toBe(title.replace(/\s{2,}/g, ' ').trim() || title) // byte-identical (modulo the shared trim normalization)
  })
})

describe('enforceMoneyTail — apply table', () => {
  it('ONE garment-family repeat is allowed — the golds repeat the noun (lands at exactly 70)', () => {
    const v = enforceMoneyTail(
      'THE CEO See You Later Alligator Tee Shirt for Women',
      'christian shirts for women',
      APPAREL,
    )
    expect(v.decision).toBe('applied')
    expect(v.title).toBe('THE CEO See You Later Alligator Tee Shirt | Christian Shirts for Women')
    expect(v.title.length).toBe(70)
  })

  it('a keyword WITHOUT an audience re-appends the title\'s bare tail verbatim (lean survives)', () => {
    const v = enforceMoneyTail(
      'THE CEO Fall Vibes Pumpkin Spice Season Tee for Women',
      'cozy autumn shirts',
      { ...APPAREL, lean: 'female' },
    )
    expect(v.decision).toBe('applied')
    expect(v.title).toBe('THE CEO Fall Vibes Pumpkin Spice Season Tee | Cozy Autumn Shirts for Women')
    expect(v.title.length).toBe(74)
  })

  it('an audience-word repeat resolves by dropping the keyword\'s own "for women" SUFFIX only (replacing a non-fact pipe tail)', () => {
    // The left carries "Womens", so the keyword's own "for women" suffix is the ONLY permitted
    // trim. The pipe-right ("Cozy Fall Vibes") is provably neither design nor brand nor spec fact,
    // so it is the one replaceable tail class that remains under the conservative scope.
    const v = enforceMoneyTail(
      'THE CEO Praise Him Womens Faith Over Fear Season Tee | Cozy Fall Vibes',
      'christian shirts for women',
      { ...APPAREL, protect: 'Praise Him Faith Over Fear' },
    )
    expect(v.decision).toBe('applied')
    expect(v.title).toBe('THE CEO Praise Him Womens Faith Over Fear Season Tee | Christian Shirts')
    expect(v.title.length).toBe(71)
  })

  it('every applied result is inside [70,75] and keeps the protected left side VERBATIM', () => {
    const inputs: Array<[string, string]> = [
      ['THE CEO I Will Praise Him in Every Season Tee for Women', 'christian shirts for women'],
      ['THE CEO See You Later Alligator Tee Shirt for Women', 'christian shirts for women'],
      ['THE CEO Fall Vibes Pumpkin Spice Season Tee for Women', 'cozy autumn shirts'],
    ]
    for (const [title, kw] of inputs) {
      const v = enforceMoneyTail(title, kw, APPAREL)
      expect(v.decision).toBe('applied')
      expect(v.title.length).toBeGreaterThanOrEqual(TITLE_BAND_LO)
      expect(v.title.length).toBeLessThanOrEqual(TITLE_BAND_HI)
      const left = title.replace(/\s+for\s+Women\s*$/i, '').trim()
      expect(v.title.startsWith(`${left} | `)).toBe(true) // brand + design + noun untouched
      expect(v.title).not.toMatch(/\|\s*$/) // never a dangling separator
    }
  })
})

/* ─────────────────────────────────────────────────────────────────────────────────────────────────
 * `MoneyTailCtx.reject` (task 3, admission-is-verification, carried-item judgment).
 *
 * `ctx.foreignTokens` alone never protects the money slot: the keyword always assembles onto the
 * pipe-RIGHT (never segment 0), and `applyTitleTruthNet` only word-scrubs or drops a non-segment-0
 * span when `opts.rejectSegment` (or an independent truth failure) fires first — `foreignTokens`
 * only backs a segment ALREADY marked droppable, at the word level. Without `reject`, a market
 * keyword carrying a sibling design's own name tokens sails through `enforceMoneyTail`'s own
 * whole-string verify untouched. Production wires `reject` from the SAME `isForeignToDesign`
 * rejector `settleTitle`'s ctx already binds (`listingPipeline.ts`'s `moneyCtx`) — this pins that
 * the field actually does something once wired, and that its absence is the pre-existing byte-
 * identical (fail-open) behavior, never a silent regression for a caller that omits it.
 */
describe('MoneyTailCtx.reject — the whole-segment twin foreignTokens alone cannot provide', () => {
  const truth = buildPhraseTruthCtx(
    { garmentFamily: 'sweatshirt', mixedFamilies: ['sweatshirt'], spec: null, allowedBrand: null, designTokens: ['Motivational Entrepreneur'] },
    'title',
  )
  // The SAME foreign-token/reject pairing production wires — never a hand-typed token list.
  const foreignTokens = new Set(designScopeTokens('Business B*tch'))
  const reject = (seg: string): boolean => isForeignToDesign(seg, foreignTokens)
  const title = 'THE CEO Motivational Entrepreneur Sweatshirt'
  const kw = 'business hustle for men' // carries the sibling's own "business" token, no garment noun

  // COMPATIBILITY PIN, not an endorsement (review round 1, 2026-08-23 — MINOR finding): this is the
  // pre-existing fail-open shape for a caller that supplies `foreignTokens` but no `reject` — it
  // documents that `reject` is additive/optional, not that shipping a sibling name here is correct.
  // If a future cure makes `foreignTokens` alone sufficient (e.g. `applyTitleTruthNet` learns to
  // word-scrub a non-segment-0 span without a paired `rejectSegment`), THIS test should be updated
  // to expect a refusal — that would be an intentional supersession of this pin, not a regression.
  it('WITHOUT reject (compat pin): a sibling-name-bearing keyword ships — foreignTokens alone is dead weight here', () => {
    const v = enforceMoneyTail(title, kw, { apparel: true, lean: null, spec: null, protect: 'Motivational Entrepreneur', garmentBrand: null, allowAppend: true, truth, foreignTokens })
    expect(v.decision).toBe('applied')
    expect(v.title).toMatch(/business/i)
  })

  it('WITH reject wired: the same candidate is refused — the money slot cannot carry a sibling design name', () => {
    const v = enforceMoneyTail(title, kw, { apparel: true, lean: null, spec: null, protect: 'Motivational Entrepreneur', garmentBrand: null, allowAppend: true, truth, foreignTokens, reject })
    expect(v.decision).toBe('truth-lie')
    expect(v.title).toBe(title) // byte-identical refusal — nothing shipped
  })
})
