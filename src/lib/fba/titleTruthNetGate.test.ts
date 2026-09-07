/**
 * THE TRUTH-SPINE LIVE GATE (PR #630 → this PR). PR #630 shipped the shared content truth spine and
 * the PO ran the gate: a real `regenerate_section:'title'` POST on B0DSCDZC6K (Gildan 18000
 * sweatshirt + 18500 hoodie family, `audience_lean='unisex'`, 6 designs, 34 child SKUs) on live sha
 * 5dbb609. Two wins (no mid-phrase fragments, no "for Women"). THREE FAILURES, pinned here with the
 * EXACT live strings and the exact live log lines:
 *
 *  1. THE GARMENT LIE SURVIVED — the live titles still said "Funny Work Shirts" on a
 *     sweatshirt/hoodie family. The live logs say why:
 *       {"tag":"BLANK_RESOLVE","parent":"B0DSCDZC6K","source":"sku","styleCode":"18000",
 *        "garmentFamily":"sweatshirt","mixed":true,"byStyle":{"18000":25,"18500":8,"64000":1}}
 *       {"tag":"BLANK_GARMENT_CONFLICT","hayClass":"sweat","source":"sku","conflicting":["64000"],
 *        "nulled":false}
 *     ONE stray 64000 adult-TEE child among 34 SKUs put 'tee' into the family's garment-class union
 *     — the union was built by mapping `byStyle`'s raw keys onto garment families — so tee
 *     vocabulary became legal for the WHOLE family. The resolver had ALREADY named that same 64000
 *     `conflicting`. `familyGarmentUnion` is now the single authority: it drops what the family
 *     ruled incompatible, then applies GARMENT_UNION_DOMINANCE.
 *
 *  2. CROSS-DESIGN CONTAMINATION, MADE WORSE BY THE NET'S OWN PROTECTION — the "Business B*tch"
 *     design name shipped inside THREE other designs' titles, because `protectHay` was the UNION of
 *     every design name in the family and `carriesSoleDesignWord` therefore protected a SIBLING's
 *     name from being dropped. A per-child title is answerable to ONE design: its own name is the
 *     protect hay, every other design's name is rejected outright via designScope STRICT NAMES.
 *
 *  3. TITLES UNDER-BAND — parent 54, per-design 61/74/64/71/64/61 against the 70-75 band (they were
 *     70-74 before the spine). The net only SHORTENS and the band pad is what must restore the
 *     band — and on this family the pad's fact bank was EMPTY: the intersection threw away
 *     "Long Sleeve" (a fact BOTH real blanks state) because the conflicting 64000 disagreed with it,
 *     `garmentBrand` is '' (every Gildan row is brand_in_copy=false) and "Classic Fit" is title
 *     waste vocabulary. One ~8-char garment form against a 16-char gap = 'facts-exhausted'.
 *
 * Plus the cosmetic the PO named: "B*Tch". A star is a non-word character, so the repo's `\b\w`
 * Title-Case pass capitalises the letter after it and mangles the seller's own design name.
 */
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  rowToSpec,
  resolveFamilyBlank,
  familyGarmentUnion,
  blankRowConflictsWithHay,
  GARMENT_UNION_DOMINANCE,
  type BlankSpecRow,
} from './blankSpecs'
import { applyTitleTruthNet, phraseTruthVerdict, type PhraseTruthCtx, type TruthGarmentFamily } from './contentTruth'
import { buildForeignDesignTokens, isForeignToDesign } from './designScope'
import {
  enforceTitleBand,
  candidateFactCount,
  fixCensorStarCase,
  titleCasePhrase,
  TITLE_BAND_LO,
  TITLE_BAND_HI,
  type TitleBandCtx,
} from './titleBand'
import { resolveGarment } from './garmentNoun'

// blankSpecs lazily builds a service-role client; these tests only touch its PURE core.
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: () => ({ select: () => ({ eq: () => ({ order: () => Promise.resolve({ data: [], error: null }), limit: () => Promise.resolve({ data: [], error: null }) }) }) }),
  }),
}))

/* ── The catalog rows migration 058 seeds, exactly as PostgREST returns them ───────────────────── */
const DB_ROWS = [
  { match_pattern: '\\bgildan\\b|\\b64000', brand: 'Gildan', brand_in_copy: false, fit: 'Classic', sleeve: 'Short Sleeve', neck: 'Crew Neck', weight_note: 'lightweight 4.5 oz ring-spun', material: 'Ring-Spun Cotton', style_code: '64000', garment_family: 'tee' },
  { match_pattern: '\\b1800(?:0)?(?=\\D|$)|\\b18000', brand: 'Gildan', brand_in_copy: false, fit: 'Classic', sleeve: 'Long Sleeve', neck: 'Crew Neck', weight_note: 'heavyweight 8.0 oz fleece', material: '50% Cotton / 50% Polyester', style_code: '18000', garment_family: 'sweatshirt' },
  { match_pattern: '\\b18500', brand: 'Gildan', brand_in_copy: false, fit: 'Classic', sleeve: 'Long Sleeve', neck: 'Hooded', weight_note: 'heavyweight 8.0 oz fleece', material: '50% Cotton / 50% Polyester', style_code: '18500', garment_family: 'hoodie' },
]
const ROWS = DB_ROWS.map((r) => rowToSpec(r)).filter((r): r is BlankSpecRow => !!r)
const rowOf = (code: string): BlankSpecRow => ROWS.find((r) => r.styleCode === code)!
const skus = (prefix: string, n: number): { sku: string }[] =>
  Array.from({ length: n }, (_, i) => ({ sku: `${prefix}${['S', 'M', 'L', 'XL', '2XL'][i % 5]}-C${i}` }))

/** The live family: 25 × 18000 + 8 × 18500 + ONE stray 64000, under a sweatshirt hay. */
const LIVE_CHILDREN = [...skus('BCSG1800', 25), ...skus('HDG18500', 8), { sku: '640002XL-C0' }]
const LIVE_HAY = 'THE CEO Business Sweatshirt SWEATSHIRT'
const LIVE_RES = resolveFamilyBlank(ROWS, LIVE_CHILDREN, null, LIVE_HAY)
const LIVE_UNION = familyGarmentUnion(ROWS, LIVE_RES, LIVE_HAY)

/** The six designs the family ships. Their names are the whole subject of FAILURE 2. */
const DESIGNS = [
  { key: 'BILLIONARE', name: 'Billionare Coming Soon' },
  { key: 'DONTQUIT', name: "Don't Quit" },
  { key: 'ENTREPRENEUR', name: 'Entrepreneur Definition' },
  { key: 'BUSINESSBTCH', name: 'Business B*tch' },
  { key: 'MINDYOURS', name: 'Mind Your Business' },
  { key: 'BOSSLADY', name: 'Boss Lady' },
]

const truthCtx = (families: TruthGarmentFamily[]): PhraseTruthCtx => ({
  garmentFamily: 'sweatshirt',
  mixedFamilies: families,
  spec: LIVE_RES.spec,
  allowedBrand: null,                       // Gildan is brand_in_copy=false
  audience: 'adult',
  designTokens: DESIGNS.map((d) => d.name),
  audienceLean: 'unisex',
  field: 'title',
})
/** The ctx as the pipeline now builds it — the resolver's own union. */
const SWEATS = truthCtx(LIVE_UNION)
/** The ctx as the pipeline built it BEFORE this PR: the raw `byStyle` census, tee and all. */
const RAW_BYSTYLE_UNION = Object.keys(LIVE_RES.byStyle)
  .map((code) => ROWS.find((r) => r.styleCode === code)?.garmentFamily ?? null)
  .filter((g): g is NonNullable<typeof g> => !!g)

/** The per-child exit's scope, built exactly as `scrubPublished` builds it. */
const foreignFor = buildForeignDesignTokens(DESIGNS, { familyTitleText: '', poolKeywords: [], strictNames: true })
const netForDesign = (title: string, key: string, own: string): string =>
  applyTitleTruthNet(title, SWEATS, own, { rejectSegment: (seg) => isForeignToDesign(seg, foreignFor(key)) })

/* ── THE EXACT LIVE PER-DESIGN TITLES (sha 5dbb609) ────────────────────────────────────────────── */
const LIVE_BILLIONARE = 'THE CEO Billionare Coming Soon | Business B*tch, Funny Work, Fall Crewneck'
const LIVE_DONTQUIT = "THE CEO Don't Quit Sweatshirt | Funny Work Shirts Business B*tch"
const LIVE_ENTREPRENEUR = 'THE CEO Entrepreneur Definition Sweatshirt | Business B*tch, Funny Work'

/* ══ FAILURE 1 — ONE stray tee child licensed "shirts" for the whole family ═════════════════════ */

describe('FAILURE 1 — the garment-class union is the RESOLVER\'s decision, not a raw SKU census', () => {
  it('reproduces the live BLANK_RESOLVE census and the live BLANK_GARMENT_CONFLICT verdict', () => {
    expect(LIVE_RES.byStyle).toEqual({ '18000': 25, '18500': 8, '64000': 1 })
    expect(LIVE_RES.dominant?.styleCode).toBe('18000')
    expect(LIVE_RES.garmentFamily).toBe('sweatshirt')
    expect(LIVE_RES.mixed).toBe(true)
    // The resolver's OWN conflict predicate — the authority this fix defers to, not a second one.
    expect(blankRowConflictsWithHay(rowOf('64000'), LIVE_HAY)).toBe(true)
    expect(blankRowConflictsWithHay(rowOf('18000'), LIVE_HAY)).toBe(false)
    expect(blankRowConflictsWithHay(rowOf('18500'), LIVE_HAY)).toBe(false)
  })

  it('THE LEVER: the pre-fix union (raw byStyle keys) contained tee — and that made the lie TRUE', () => {
    expect(RAW_BYSTYLE_UNION).toContain('tee')
    expect(phraseTruthVerdict('Funny Work Shirts', truthCtx(RAW_BYSTYLE_UNION))).toEqual({ ok: true })
  })

  it('the resolver\'s union excludes the conflicting style code — tee vocabulary is a LIE again', () => {
    expect(LIVE_UNION).toEqual(['sweatshirt', 'hoodie'])
    expect(LIVE_UNION).not.toContain('tee')
    expect(phraseTruthVerdict('Funny Work Shirts', SWEATS)).toEqual({ ok: false, reason: 'wrong-garment-noun' })
    // …while every noun the family REALLY is stays legal.
    expect(phraseTruthVerdict('Fall Crewneck', SWEATS)).toEqual({ ok: true })
    expect(phraseTruthVerdict('Cozy Fleece Hoodie', SWEATS)).toEqual({ ok: true })
    expect(phraseTruthVerdict('Pullover Sweatshirt', SWEATS)).toEqual({ ok: true })
  })

  it('DOMINANCE is the second, independent gate — ONE named constant, no inline literals', () => {
    expect(GARMENT_UNION_DOMINANCE).toEqual({ minChildren: 2, minShare: 0.10 })
    // A hay that names NO garment class conflicts with nothing, so the tee row is only excluded by
    // dominance here — 1 child fails minChildren.
    const neutralHay = 'THE CEO Business Apparel'
    const one = resolveFamilyBlank(ROWS, LIVE_CHILDREN, null, neutralHay)
    expect(familyGarmentUnion(ROWS, one, neutralHay)).toEqual(['sweatshirt', 'hoodie'])
    // 3 tee children of 40 clears minChildren but is 7.5% — under minShare.
    const thin = resolveFamilyBlank(ROWS, [...skus('BCSG1800', 30), ...skus('HDG18500', 7), ...skus('ADWF64000', 3)], null, neutralHay)
    expect(familyGarmentUnion(ROWS, thin, neutralHay)).toEqual(['sweatshirt', 'hoodie'])
    // A REAL mixed family is not gutted: 12 tee children of 42 is 28.6% and joins the union.
    const real = resolveFamilyBlank(ROWS, [...skus('BCSG1800', 30), ...skus('ADWF64000', 12)], null, neutralHay)
    expect(familyGarmentUnion(ROWS, real, neutralHay).sort()).toEqual(['sweatshirt', 'tee'])
  })

  it('the dominant family is ALWAYS in its own union, even below the thresholds', () => {
    const tiny = resolveFamilyBlank(ROWS, [{ sku: 'BCSG1800M-C0' }], null, 'THE CEO Sweatshirt')
    expect(familyGarmentUnion(ROWS, tiny, 'THE CEO Sweatshirt')).toEqual(['sweatshirt'])
  })

  it('the LIVE title loses the garment lie once the union is the resolver\'s', () => {
    // Segment 0 (brand + design + noun) is never dropped; the untrue phrase after the pipe is.
    expect(netForDesign(LIVE_DONTQUIT, 'DONTQUIT', "Don't Quit")).toBe("THE CEO Don't Quit Sweatshirt")
  })
})

/* ══ FAILURE 2 — a sibling design's name must never survive a per-child title ═══════════════════ */

describe('FAILURE 2 — cross-design contamination on the EXACT live per-child titles', () => {
  it('"Business B*tch" is gone from all three OTHER designs\' titles', () => {
    expect(netForDesign(LIVE_BILLIONARE, 'BILLIONARE', 'Billionare Coming Soon'))
      .toBe('THE CEO Billionare Coming Soon | Funny Work, Fall Crewneck')
    expect(netForDesign(LIVE_DONTQUIT, 'DONTQUIT', "Don't Quit"))
      .toBe("THE CEO Don't Quit Sweatshirt")
    expect(netForDesign(LIVE_ENTREPRENEUR, 'ENTREPRENEUR', 'Entrepreneur Definition'))
      .toBe('THE CEO Entrepreneur Definition Sweatshirt | Funny Work')
  })

  it('THE PIN: no design name that belongs to a DIFFERENT design survives any per-child title', () => {
    const titles: Array<[string, string, string]> = [
      [LIVE_BILLIONARE, 'BILLIONARE', 'Billionare Coming Soon'],
      [LIVE_DONTQUIT, 'DONTQUIT', "Don't Quit"],
      [LIVE_ENTREPRENEUR, 'ENTREPRENEUR', 'Entrepreneur Definition'],
    ]
    for (const [title, key, own] of titles) {
      const out = netForDesign(title, key, own).toLowerCase()
      for (const d of DESIGNS) {
        if (d.key === key) continue
        expect(out, `${d.name} leaked into ${own}'s title`).not.toContain(d.name.toLowerCase())
      }
    }
  })

  it('the REJECTOR did it, not the garment rule — "Business B*tch" is a perfectly TRUE phrase', () => {
    // The Entrepreneur title's first droppable segment is the bare sibling name: no garment noun,
    // no audience claim, no brand — the truth spine has nothing against it.
    expect(phraseTruthVerdict('Business B*tch', SWEATS)).toEqual({ ok: true })
    // Without the per-design rejector the segment survives; with it, it goes.
    expect(applyTitleTruthNet(LIVE_ENTREPRENEUR, SWEATS, 'Entrepreneur Definition'))
      .toContain('Business B*tch')
    expect(netForDesign(LIVE_ENTREPRENEUR, 'ENTREPRENEUR', 'Entrepreneur Definition'))
      .not.toContain('Business B*tch')
  })

  it('the design that OWNS the name keeps it verbatim — protection follows the design, not the family', () => {
    const own = 'THE CEO Business B*tch Sweatshirt | Funny Work Crewneck'
    expect(netForDesign(own, 'BUSINESSBTCH', 'Business B*tch')).toBe(own)
    // And even when its own name sits in a droppable segment, it is protected there. Segment 0 here
    // is deliberately UNRELATED filler for this design (BUSINESSBTCH), NOT a real sibling's name —
    // fix round 1 (2026-09-06, B1) widened the shared audience lexicon's REMOVER to match its
    // DETECTOR (`LEAN_FEM_CORE` now includes "lady"), so this fixture's original filler "Boss Lady"
    // (coincidentally also a REAL sibling design's name, `DESIGNS.BOSSLADY`) is correctly recognised
    // as a forced-gender word on this unisex-lean SWEATS ctx and would now be word-scrubbed by rule
    // (b) — a true, unrelated consequence of the ruling, not a bug in this test's actual subject
    // (whether "Business B*tch" survives in a droppable comma segment). Swapped to gender-neutral
    // filler so the assertion stays about what it was written to test.
    const commaed = 'THE CEO Grind Mode Sweatshirt | Fall Crewneck, Business B*tch'
    expect(netForDesign(commaed, 'BUSINESSBTCH', 'Business B*tch')).toBe(commaed)
  })

  it('the family NICHE word is never foreign — only the other designs\' distinguishing words are', () => {
    const fishing = [
      { key: 'FT', name: 'Fishing Trip' },
      { key: 'FH', name: 'Fishing Hard' },
    ]
    const ff = buildForeignDesignTokens(fishing, { familyTitleText: '', poolKeywords: [], strictNames: true })
    expect(isForeignToDesign('Funny Fishing Gifts', ff('FT'))).toBe(false)   // shared by 2/2 names
    expect(isForeignToDesign('Fish Hard Apparel', ff('FT'))).toBe(true)      // FH's own word
  })

  it('the ship door binds the per-child scope to the door itself (source pin — no exit can forget it)', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'lib', 'fba', 'listingPipeline.ts'), 'utf8')
    expect(src).toContain("{ familyTitleText: '', poolKeywords: [], strictNames: true }")
    // 2026-08-22: the scope now also carries the design's BAND half (facts/pool/truthOk), so the
    // truth net and the pad answer to the same design. Still ONE destructure, still bound at the door.
    expect(src).toContain('const { titleTruthDoor, protect, band } = titleScopeFor(c)')
    // …and the per-design TITLE FILL is scoped too, so the producer never writes the sibling in.
    expect(src).toContain('const titleForeignFor = buildForeignDesignTokens(')
    expect(src).toContain("tag: 'TITLE_DESIGN_SCOPE'")
  })
})

/* ══ FAILURE 3 — the band pad had NOTHING to say ═══════════════════════════════════════════════ */

/** The family's own garment vocabulary, composed exactly as `bandFactSegments` composes it. */
const FAMILY_GARMENT_FACTS = [...new Set(
  LIVE_UNION.flatMap((f) => resolveGarment({ productType: 'SWEATSHIRT', title: LIVE_HAY, blankFamily: f }).aliases.map(titleCasePhrase)),
)]
const bandCtx = (extra: Partial<TitleBandCtx> = {}): TitleBandCtx => ({
  apparel: true,
  garmentBrand: null,                                       // Gildan: brand_in_copy=false
  spec: { fit: LIVE_RES.spec?.fit ? `${LIVE_RES.spec.fit} Fit` : null, sleeve: LIVE_RES.spec?.sleeve, neck: LIVE_RES.spec?.neck },
  garmentSecond: null,
  factSegments: FAMILY_GARMENT_FACTS,
  truthOk: (seg: string) => phraseTruthVerdict(seg, SWEATS).ok,
  ...extra,
})

describe('FAILURE 3 — the pad must restore the band from the family\'s OWN facts', () => {
  it('ROOT CAUSE: the conflicting 64000 used to poison the INTERSECTION and delete "Long Sleeve"', () => {
    // Both real blanks state Long Sleeve; only the stray tee disagreed, and the intersection took
    // its vote. Neck genuinely differs (Crew Neck vs Hooded) and is still never claimed.
    expect(LIVE_RES.spec?.sleeve).toBe('Long Sleeve')
    expect(LIVE_RES.spec?.neck).toBeUndefined()
    expect(LIVE_RES.spec?.brandInCopy).toBe(false)
    expect(LIVE_RES.spec?.weightNote).toBe('heavyweight 8.0 oz fleece')
  })

  it('the pre-fix fact bank was ONE garment form and could not span the gap ("facts-exhausted")', () => {
    const netted = netForDesign(LIVE_ENTREPRENEUR, 'ENTREPRENEUR', 'Entrepreneur Definition')
    expect(netted.length).toBe(55)
    const before = enforceTitleBand(netted, bandCtx({ factSegments: [], spec: { fit: 'Classic Fit', sleeve: undefined, neck: undefined } }))
    expect(before.decision).toBe('no-facts')
    expect(before.title.length).toBeLessThan(TITLE_BAND_LO)
  })

  it('with the family\'s own garment vocabulary the netted live title lands IN BAND', () => {
    const netted = netForDesign(LIVE_ENTREPRENEUR, 'ENTREPRENEUR', 'Entrepreneur Definition')
    const v = enforceTitleBand(netted, bandCtx())
    expect(v.decision).toBe('padded')
    expect(v.title.length).toBeGreaterThanOrEqual(TITLE_BAND_LO)
    expect(v.title.length).toBeLessThanOrEqual(TITLE_BAND_HI)
    // What it padded with is a PRODUCT FACT of this family — never a market phrase, never a fragment.
    const added = v.title.slice(netted.length).trim()
    expect([...FAMILY_GARMENT_FACTS, 'Long Sleeve']).toContain(added)
    expect(phraseTruthVerdict(v.title, SWEATS)).toEqual({ ok: true })
  })

  it('the same is true for the Billionare title, and the bank is measurably bigger', () => {
    const netted = netForDesign(LIVE_BILLIONARE, 'BILLIONARE', 'Billionare Coming Soon')
    expect(candidateFactCount(netted, bandCtx({ factSegments: [] }))).toBeLessThan(candidateFactCount(netted, bandCtx()))
    const v = enforceTitleBand(netted, bandCtx())
    expect(v.title.length).toBeGreaterThanOrEqual(TITLE_BAND_LO)
    expect(v.title.length).toBeLessThanOrEqual(TITLE_BAND_HI)
  })

  it('THE TRUTH GATE: the pad can never weld back the lie the net just removed', () => {
    // This family's Amazon productType is a SHIRT type on plenty of POD listings, and
    // `pickDistinctGarmentForm` then hands the pad "Shirt". The pad is the LAST writer in the door.
    const netted = netForDesign(LIVE_DONTQUIT, 'DONTQUIT', "Don't Quit")
    const v = enforceTitleBand(netted, bandCtx({ garmentSecond: 'Shirt' }))
    expect(v.title).not.toMatch(/\bshirts?\b/i)
    expect(phraseTruthVerdict(v.title, SWEATS)).toEqual({ ok: true })
    // TWO INDEPENDENT GATES now hold this line (2026-08-22, defect 3's `dominantGarmentGroup` check
    // in `candidateSegments`): the title already committed to "Sweatshirt", so disabling ONLY
    // `truthOk` is no longer enough to weld "Shirt" back — the unconditional single-class gate
    // (keyed on the title's own text, not on `truthOk`) still refuses it.
    const truthGateOffOnly = enforceTitleBand(netted, bandCtx({ garmentSecond: 'Shirt', truthOk: undefined, factSegments: [] }))
    expect(truthGateOffOnly.title).not.toMatch(/\bShirt\b/)
    // Strip the money-phrase noun too, so NEITHER gate has anything to key off — THIS proves both
    // gates were carrying real weight (not merely that "Shirt" was never really a candidate).
    const bothGatesOff = enforceTitleBand("THE CEO Don't Quit", bandCtx({ garmentSecond: 'Shirt', truthOk: undefined, factSegments: [] }))
    expect(bothGatesOff.title).toMatch(/\bShirt\b/)
  })

  it('a pair is always <attribute> <garment noun> — never a spec stack in the money position', () => {
    // The PO has shipped zero "| Comfort Colors Relaxed Fit"-shaped tails; `dropSpecOnlyTail` exists
    // because of that class. Generic pairing must not manufacture it.
    const v = enforceTitleBand('THE CEO Golf Widow Support Group Tee for Women', {
      apparel: true, garmentBrand: 'Comfort Colors', spec: { fit: 'Relaxed Fit', sleeve: 'Short Sleeve', neck: 'Crew Neck' }, garmentSecond: 'Tee',
    })
    expect(v.title).not.toContain('Comfort Colors Relaxed Fit')
    expect(v.title).not.toContain('Short Sleeve Crew Neck')
  })

  it('when the facts genuinely cannot reach 70 the title stays TRUTHFUL and short — never padded with a lie', () => {
    const netted = netForDesign(LIVE_DONTQUIT, 'DONTQUIT', "Don't Quit")   // 29 chars: the net cut a lot
    const v = enforceTitleBand(netted, bandCtx())
    expect(v.decision).toBe('facts-exhausted')
    expect(v.title.length).toBeLessThan(TITLE_BAND_LO)
    expect(v.title.length).toBeGreaterThan(netted.length)                  // it still spent every fact
    expect(phraseTruthVerdict(v.title, SWEATS)).toEqual({ ok: true })
  })

  it('the ship door NAMES the refusal (source pin) — TITLE_UNDER_BAND {parent, len, reason}', () => {
    // 2026-08-22 title-settle rewrite: the door's per-stage logging (including this line) moved from
    // listingPipeline.ts's `bandTitle` closure into `settleTitle` (titleBand.ts) — the ONE function
    // that closure now thinly adapts to. The invariant is unchanged (the door still names its
    // refusal); only the file that carries it moved, which is exactly what makes the door testable
    // offline (see truthBandHarness.ts / truthBandGate.test.ts).
    const src = readFileSync(join(process.cwd(), 'src', 'lib', 'fba', 'titleBand.ts'), 'utf8')
    const at = src.indexOf("tag: 'TITLE_UNDER_BAND'")
    expect(at, 'the door does not name its refusal').toBeGreaterThan(0)
    const body = src.slice(at, at + 320)
    expect(body).toContain('parent: ctx.parentAsin')
    expect(body).toContain('len: drop.title.length')
    expect(body).toContain('reason:')
    // …and the pad is fed the family's facts + the spine's verdict, not just BLANK_SPECS scalars.
    // 2026-08-22: both are now per-EXIT (`scope?.facts` / `scope?.truthOk`) so a per-child title
    // pads from ITS design's garment vocabulary, with the family's as the default for the broadcast.
    const pipelineSrc = readFileSync(join(process.cwd(), 'src', 'lib', 'fba', 'listingPipeline.ts'), 'utf8')
    expect(pipelineSrc).toContain('factSegments: scope?.facts ?? bandFactSegments')
    expect(pipelineSrc).toContain('truthOk: scope?.truthOk ?? bandTruthOk')
  })
})

/* ══ THE COSMETIC — "B*Tch" ════════════════════════════════════════════════════════════════════ */

describe('the censor star is not a word break', () => {
  it('the repo\'s raw Title-Case pass is what manufactures the artifact', () => {
    expect('business b*tch'.replace(/\b\w/g, (c) => c.toUpperCase())).toBe('Business B*Tch')
  })
  it('titleCasePhrase — the ONE caser — ships the design name verbatim', () => {
    expect(titleCasePhrase('business b*tch')).toBe('Business B*tch')
    expect(titleCasePhrase("women's b*tch sweatshirt")).toBe("Women's B*tch Sweatshirt")
  })
  it('fixCensorStarCase repairs an already-mangled title, terminally and idempotently', () => {
    expect(fixCensorStarCase('THE CEO Business B*Tch Sweatshirt')).toBe('THE CEO Business B*tch Sweatshirt')
    expect(fixCensorStarCase('THE CEO Business B*tch Sweatshirt')).toBe('THE CEO Business B*tch Sweatshirt')
    expect(fixCensorStarCase('')).toBe('')
    expect(fixCensorStarCase('no stars here')).toBe('no stars here')
  })
  it('a deliberately ALL-CAPS censored word keeps every capital', () => {
    expect(fixCensorStarCase('F*CK YEAH TEE')).toBe('F*CK YEAH TEE')
    expect(fixCensorStarCase('SH*T HAPPENS')).toBe('SH*T HAPPENS')
    expect(fixCensorStarCase('THE CEO B*TCH BOSS')).toBe('THE CEO B*TCH BOSS')
  })
  it('the live design name survives the whole per-child door', () => {
    const t = titleCasePhrase('the ceo business b*tch sweatshirt | funny work crewneck')
    expect(netForDesign(t, 'BUSINESSBTCH', 'Business B*tch')).toContain('Business B*tch')
  })
  it('the ship door runs it beside the apostrophe fix (source pin)', () => {
    // 2026-08-22 title-settle rewrite: this pass now lives in `settleTitle` (titleBand.ts), the ONE
    // function listingPipeline.ts's `bandTitle` adapter calls — see the note on the sibling pin above.
    const src = readFileSync(join(process.cwd(), 'src', 'lib', 'fba', 'titleBand.ts'), 'utf8')
    expect(src).toContain('const starred = fixCensorStarCase(title)')
    expect(src).toContain("tag: 'SHIP_CENSOR_STAR_CASE'")
    // No PRODUCER still inlines the raw caser — they all go through the one seam. (titleBand.ts
    // itself is exempt from this check: its own doc comments quote the historical bug pattern.)
    const pipelineSrc = readFileSync(join(process.cwd(), 'src', 'lib', 'fba', 'listingPipeline.ts'), 'utf8')
    expect(pipelineSrc).not.toMatch(/fixApostropheCase\([a-zA-Z]+\.replace\(\/\\b\\w\/g/)
  })
})
