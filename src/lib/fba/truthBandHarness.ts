/**
 * truthBandHarness.ts — THE MERGE GATE for the title truth+band contract (PO 2026-08-22).
 *
 * WHY A HARNESS AND NOT "tsc passes". PRs #630/#631 shipped with a clean typecheck, a green suite
 * and 26 fresh pins, and were REVERTED OFF PRODUCTION on the first live regen: every rule they
 * asserted was true, and the titles came out at 29-49 characters against the 70-75 band. Nothing in
 * that suite measured the ONE property that decided the outcome — the LENGTH of the string the door
 * actually returns. Unit pins over individual leaves cannot: the failure lived in the COMPOSITION,
 * where a subtractive net had no additive counterpart.
 *
 * So the gate is a REGEN, run against the real functions on real data, asserting on the RETURNED
 * STRINGS. This module is the fixture plus the runner; `truthBandGate.test.ts` is the golden-band
 * pin that fails the build if any produced title leaves the band, states a garment the design's own
 * blank is not, forces a gender on a unisex family, carries a sibling design's name, or ends on an
 * orphan fragment. Run it directly to see the strings:
 *
 *     npx tsx src/lib/fba/truthBandHarness.ts
 *
 * THE FIXTURE IS B0DSCDZC6K, the family both reverted PRs were measured on: six designs, a mixed
 * Gildan 18000 sweatshirt + 18500 hoodie blank union, `audience_lean='unisex'`, and the one
 * mislabeled child (`BB64000XL-BK-FBA`) whose SKU says 64000, whose Amazon title says "Sweatshirt"
 * and whose PO ruling says Comfort Colors 6014 LONG SLEEVE.
 *
 * PURE AND OFFLINE. Every input is constructed here exactly as migrations 053/058/062 seed it, so
 * the gate needs no database, no API key and no network — which is the whole reason it can run on
 * every commit instead of once, by hand, after a deploy.
 */
import {
  resolveFamilyBlank, familyGarmentUnion, resolveChildStyleCode,
  type BlankSpec, type BlankSpecRow, type GarmentFamily,
} from './blankSpecs'
import {
  audienceOfGarmentFamily, normalizeAudienceLean, phraseTruthVerdict,
  type PhraseTruthCtx, type TruthGarmentFamily,
} from './contentTruth'
import {
  enforceTitleTruthBand, pickDistinctGarmentForm, titleCasePhrase, isTitleWasteVocabulary,
  TITLE_BAND_LO, TITLE_BAND_HI, type TitleBandCtx, type TruthBandDecision,
} from './titleBand'
import { resolveGarment } from './garmentNoun'
import { buildForeignDesignTokens, isForeignToDesign } from './designScope'

/* ── THE CATALOG, exactly as migrations 053 + 058 seed `blank_specs` ──────────────────────────── */

export const CATALOG: BlankSpecRow[] = [
  { match: /\bcomfort\s*colors?\b/i, styleCode: '1717', garmentFamily: 'tee',
    spec: { brand: 'Comfort Colors', fit: 'Relaxed', sleeve: 'Short Sleeve', neck: 'Crew Neck', weightNote: 'midweight 6.1 oz garment-dyed', material: '100% Ring-Spun Cotton', dye: 'Garment-Dyed', stretch: 'Low Stretch', fitToSize: 'Runs Slightly Small' } },
  { match: /\bgildan\b|\b64000/i, styleCode: '64000', garmentFamily: 'tee',
    spec: { brand: 'Gildan', brandInCopy: false, fit: 'Classic', sleeve: 'Short Sleeve', neck: 'Crew Neck', weightNote: 'lightweight 4.5 oz ring-spun', material: 'Ring-Spun Cotton' } },
  { match: /\b6014/i, styleCode: '6014', garmentFamily: 'long_sleeve_tee',
    spec: { brand: 'Comfort Colors', fit: 'Relaxed', sleeve: 'Long Sleeve', neck: 'Crew Neck', weightNote: 'midweight 6.1 oz garment-dyed', material: '100% Ring-Spun Cotton', dye: 'Garment-Dyed', stretch: 'Low Stretch', fitToSize: 'Runs Slightly Small' } },
  { match: /\b1800(?:0)?(?=\D|$)|\b18000/i, styleCode: '18000', garmentFamily: 'sweatshirt',
    spec: { brand: 'Gildan', brandInCopy: false, fit: 'Classic', sleeve: 'Long Sleeve', neck: 'Crew Neck', weightNote: 'heavyweight 8.0 oz fleece', material: '50% Cotton / 50% Polyester' } },
  { match: /\b18500/i, styleCode: '18500', garmentFamily: 'hoodie',
    spec: { brand: 'Gildan', brandInCopy: false, fit: 'Classic', sleeve: 'Long Sleeve', neck: 'Hooded', weightNote: 'heavyweight 8.0 oz fleece', material: '50% Cotton / 50% Polyester' } },
]

/** migration 062 — `blank_assignments` scope='child'. The ONE PO-stated child assignment. */
export const CHILD_ASSIGNMENTS: ReadonlyMap<string, string> = new Map([['BB64000XL-BK-FBA', '6014']])

/* ── THE FAMILY: B0DSCDZC6K, six designs, 35 children ─────────────────────────────────────────── */

export interface HarnessChild { sku: string; asin: string; designKey: string }

/** Six designs, spelled as the seller spells them (including "Billionare"/"Hustle Definiton"). */
export const DESIGNS: { key: string; name: string }[] = [
  { key: 'BB', name: 'Business B*tch' },
  { key: 'BCS', name: 'Billionare Coming Soon' },
  { key: 'DQ', name: "Don't Quit" },
  { key: 'ED', name: 'Entrepreneur Definition' },
  { key: 'HD', name: 'Hustle Definiton' },
  { key: 'MH', name: 'Mother Hustler' },
]

/**
 * The child census the live BLANK_RESOLVE reported: 18000 ×25, 18500 ×9, and ONE 64000-coded SKU.
 * Sizes are spread across the six designs the way a real POD family is. The mislabeled child is
 * `BB64000XL-BK-FBA` and it belongs to the Business B*tch design — which is why that ONE design
 * group resolves to a different garment from its five siblings.
 */
export function buildChildren(): HarnessChild[] {
  const out: HarnessChild[] = []
  const sizes = ['S', 'M', 'L', 'XL', '2XL']
  // 25 crewneck sweatshirts (18000), spread 5 designs × 5 sizes.
  for (const d of DESIGNS.slice(0, 5)) {
    for (const s of sizes) out.push({ sku: `G18000${s}-BK-${d.key}-FBA`, asin: `B0DS${d.key}${s}`, designKey: d.key })
  }
  // 9 hoodies (18500): 5 on Mother Hustler, 4 spread over the first designs.
  for (const s of sizes) out.push({ sku: `G18500${s}-BK-MH-FBA`, asin: `B0DSMH${s}`, designKey: 'MH' })
  for (const [i, s] of ['S', 'M', 'L', 'XL'].entries()) {
    const d = DESIGNS[i % 5]
    out.push({ sku: `G18500${s}-NV-${d.key}-FBA`, asin: `B0DSH${d.key}${s}`, designKey: d.key })
  }
  // THE MISLABELED CHILD (PO 2026-08-22). SKU says 64000; it is a Comfort Colors 6014 long sleeve.
  out.push({ sku: 'BB64000XL-BK-FBA', asin: 'B0DSG4T5BR', designKey: 'BB' })
  return out
}

/** The listing hay the family resolves against — its own copy says "Sweatshirt". */
export const FAMILY_HAY = 'THE CEO Business B*tch Sweatshirt Gildan Heavy Blend Crewneck Sweatshirt SHIRT'
export const PRODUCT_TYPE = 'SHIRT'
export const AUDIENCE_LEAN = 'unisex' as const

/**
 * The keyword pool, containing the exact phrases the live defects came from. Three of these are
 * UNTRUE for a sweatshirt family and must never reach a title; two are true and are exactly the
 * material the band needs.
 */
export const POOL: string[] = [
  'funny work shirts',                 // wrong-garment-noun on sweatshirt/hoodie
  'funny work shirts for women',       // …and forces a gender on a unisex family
  'graphic sweatshirts for women',     // TRUE garment, but forces a gender in the TITLE
  'fall crewneck',                     // TRUE
  'mind your business',                // TRUE (and the "Mind" orphan-fragment specimen)
  'cozy fleece pullover',              // TRUE
  'motivational sweatshirt',           // TRUE
  'entrepreneur gifts',                // TRUE
  'small business owner gift',         // TRUE
]

/**
 * What the council produced for each design BEFORE the door — carrying the live defects verbatim:
 * a tee noun on a sweatshirt family, a forced gender on a unisex lean, an orphan "Mind", and a
 * sibling design's name inside another design's title.
 */
export const PRODUCED: Record<string, string> = {
  BB:  'THE CEO Business B*Tch Sweatshirt | Funny Work Shirts, Fall Crewneck, Mind',
  BCS: 'THE CEO Billionare Coming Soon Sweatshirt | Funny Work Shirts for Women',
  DQ:  "THE CEO Don't Quit Sweatshirt | Business B*tch, Funny Work Shirts for Women",
  ED:  'THE CEO Entrepreneur Definition Sweatshirt | Graphic Sweatshirts for Women',
  HD:  'THE CEO Hustle Definiton Sweatshirt | Funny Work Shirts, Business B*tch',
  MH:  'THE CEO Mother Hustler Hoodie | Funny Work Shirts for Women, Mind',
}
/** The broadcast/parent title, answerable to every design in the family. */
export const PRODUCED_PARENT = 'THE CEO Motivational Sweatshirt | Funny Work Shirts for Women'

/** What is LIVE on Amazon today — what a truth+band REFUSAL preserves. */
export const PRIOR: Record<string, string> = {
  BB:  'THE CEO Business B*tch Sweatshirt | Funny Work Shirts for Women, Gifts',
  BCS: 'THE CEO Billionare Coming Soon Crewneck | Funny Work Shirts for Women',
  DQ:  "THE CEO Don't Quit Sweatshirt | Funny Work Shirts for Women, Cozy Gift",
  ED:  'THE CEO Entrepreneur Definition Sweatshirt | Funny Work Shirts Gift',
  HD:  'THE CEO Hustle Definiton Sweatshirt | Funny Work Shirts for Women Gift',
  MH:  'THE CEO Mother Hustler Hoodie | Funny Work Shirts for Women, Cozy Gifts',
}

/* ── THE RUNNER ───────────────────────────────────────────────────────────────────────────────── */

export interface HarnessRow {
  scope: string
  design: string
  garmentFamily: TruthGarmentFamily
  union: TruthGarmentFamily[]
  produced: string
  producedLen: number
  title: string
  len: number
  decision: TruthBandDecision
  hold: boolean
  reason: string
  tried: string[]
}

export interface HarnessResult {
  familyGarmentFamily: GarmentFamily | null
  familyUnion: GarmentFamily[]
  familyByStyle: Record<string, number>
  childAssignmentHits: number
  familySource: string | null
  bySource: Partial<Record<string, number>>
  /** What `BB64000XL-BK-FBA` resolves to WITH and WITHOUT the PO override — the 062 evidence. */
  mislabeledChild: {
    withOverride: string | null
    withOverrideSource: string | null
    withoutOverride: string | null
    withoutOverrideSource: string | null
    /** The child resolved AS ITS OWN SCOPE — the per-child garment model's whole point. */
    ownGarmentFamily: GarmentFamily | null
    ownUnion: GarmentFamily[]
    /** Can THIS child truthfully say "Long Sleeve Shirt"? Yes for its own blank, no for the family. */
    longSleeveShirtOnChild: boolean
    longSleeveShirtOnFamily: boolean
  }
  rows: HarnessRow[]
}

/** The family's design-name union — the truth spine's design-token exemption input. */
const designNames = (): string[] => DESIGNS.map((d) => d.name)

/** The garment surface forms a set of blank families may truthfully claim (the pad's fact bank). */
function garmentFacts(fams: readonly TruthGarmentFamily[], title: string): string[] {
  const out: string[] = []
  for (const f of fams) {
    for (const alias of resolveGarment({ productType: PRODUCT_TYPE, title, blankFamily: f }).aliases) {
      const seg = titleCasePhrase(alias)
      if (seg && !out.includes(seg)) out.push(seg)
    }
  }
  return out
}

/** The truthful pool segments for ONE scope — the pad's third bank. */
function poolFacts(truthOk: (s: string) => boolean, reject?: (s: string) => boolean): string[] {
  const out: string[] = []
  for (const kw of POOL) {
    if (kw.length < 3 || kw.length > 38) continue
    if (!truthOk(kw)) continue
    if (reject && reject(kw)) continue
    const seg = titleCasePhrase(kw)
    if (seg && !out.includes(seg) && !isTitleWasteVocabulary(seg)) out.push(seg)
  }
  return out
}

export function runTruthBandHarness(): HarnessResult {
  const children = buildChildren()
  const codes = CATALOG.map((r) => r.styleCode).filter((c): c is string => !!c)

  // ── FAMILY SCOPE: the broadcast/parent title is answerable to every child ────────────────────
  const familyRes = resolveFamilyBlank(CATALOG, children, null, FAMILY_HAY, CHILD_ASSIGNMENTS)
  const familyUnion = familyGarmentUnion(CATALOG, familyRes, FAMILY_HAY)

  const mkCtx = (gf: GarmentFamily, union: GarmentFamily[], spec: BlankSpec | null, brand: string | null): PhraseTruthCtx => ({
    garmentFamily: gf,
    mixedFamilies: union.length > 1 ? union : undefined,
    spec,
    allowedBrand: brand,
    audience: audienceOfGarmentFamily(gf),
    designTokens: designNames(),
    audienceLean: normalizeAudienceLean(AUDIENCE_LEAN),
    field: 'title',
  })

  const familyBrand = familyRes.spec?.brandInCopy === false ? '' : (familyRes.spec?.brand ?? '')
  const familyCtx = familyRes.garmentFamily
    ? mkCtx(familyRes.garmentFamily, familyUnion, familyRes.spec, familyBrand || null)
    : null

  const bandCtxFor = (title: string, ctx: PhraseTruthCtx | null, fams: readonly TruthGarmentFamily[], spec: BlankSpec | null, brand: string, reject?: (s: string) => boolean): TitleBandCtx => {
    const truthOk = (s: string): boolean => !ctx || phraseTruthVerdict(s, ctx).ok
    return {
      apparel: true,
      customizable: false,
      garmentBrand: brand || null,
      factSegments: garmentFacts(fams, title),
      poolSegments: poolFacts(truthOk, reject),
      truthOk,
      spec: spec ? { fit: spec.fit ? `${spec.fit} Fit` : null, sleeve: spec.sleeve ?? null, neck: spec.neck ?? null } : null,
      garmentSecond: pickDistinctGarmentForm(title, resolveGarment({ productType: PRODUCT_TYPE, title, blankFamily: fams[0] ?? null }).aliases),
    }
  }

  const rows: HarnessRow[] = []

  // The parent title takes NO design scope: a family hub title is answerable to every design.
  {
    const produced = PRODUCED_PARENT
    const band = bandCtxFor(produced, familyCtx, familyUnion, familyRes.spec, familyBrand)
    const r = enforceTitleTruthBand({
      produced, prior: null, apparel: true, band, truth: familyCtx,
      protect: designNames().join(' '),
    })
    rows.push({
      scope: 'broadcast', design: '(family)',
      garmentFamily: familyRes.garmentFamily, union: familyUnion,
      produced, producedLen: produced.length,
      title: r.title, len: r.len, decision: r.decision, hold: r.hold, reason: r.reason, tried: r.tried,
    })
  }

  // ── PER-DESIGN SCOPE: each group judged against ITS OWN resolved blank ───────────────────────
  const foreignFor = buildForeignDesignTokens(
    DESIGNS.map((d) => ({ key: d.key, name: d.name })),
    { familyTitleText: '', poolKeywords: [], strictNames: true },
  )

  for (const d of DESIGNS) {
    const groupChildren = children.filter((c) => c.designKey === d.key)
    const groupSkuHay = groupChildren.map((c) => c.sku).join(' ')
    const produced = PRODUCED[d.key]
    const groupHay = `${produced} ${PRODUCT_TYPE} ${groupSkuHay}`
    const res = resolveFamilyBlank(CATALOG, groupChildren, null, groupHay, CHILD_ASSIGNMENTS)
    const union = res.garmentFamily ? familyGarmentUnion(CATALOG, res, groupHay) : []
    const brand = res.spec?.brandInCopy === false ? '' : (res.spec?.brand ?? '')
    const ctx = res.garmentFamily ? mkCtx(res.garmentFamily, union, res.spec, brand || null) : familyCtx
    const fams: readonly TruthGarmentFamily[] = union.length ? union : familyUnion
    const foreign = foreignFor(d.key)
    const reject = foreign.size ? (seg: string) => isForeignToDesign(seg, foreign) : undefined
    const band = bandCtxFor(produced, ctx, fams, res.spec ?? familyRes.spec, brand)
    const r = enforceTitleTruthBand({
      produced, prior: PRIOR[d.key], apparel: true, band, truth: ctx, protect: d.name, reject,
    })
    rows.push({
      scope: d.key, design: d.name,
      garmentFamily: res.garmentFamily ?? familyRes.garmentFamily, union: union.length ? union : familyUnion,
      produced, producedLen: produced.length,
      title: r.title, len: r.len, decision: r.decision, hold: r.hold, reason: r.reason, tried: r.tried,
    })
  }

  /* ── THE MISLABELED CHILD, RESOLVED AS ITS OWN SCOPE (PO 2026-08-22) ─────────────────────────
   * B0DSG4T5BR is the live proof that a FAMILY verdict is the wrong shape. Its own hay still says
   * "Sweatshirt" (that is what its stored Amazon title says), so every resolved row conflicts with
   * its own copy — and WITHOUT the PO's child override the whole scope would null out and inherit
   * the family's sweatshirt verdict, discarding the ruling. With the override, the PO's statement
   * stands: this child is a Comfort Colors 6014 long sleeve and may truthfully say so, while the
   * FAMILY it belongs to stays sweatshirt-dominant and its parent title still may not say "shirt". */
  const mislabeled = children.filter((c) => c.sku === 'BB64000XL-BK-FBA')
  const childHay = 'THE CEO Business B*tch Sweatshirt SHIRT BB64000XL-BK-FBA'
  const childRes = resolveFamilyBlank(CATALOG, mislabeled, null, childHay, CHILD_ASSIGNMENTS)
  const childUnion = childRes.garmentFamily ? familyGarmentUnion(CATALOG, childRes, childHay) : []
  const childCtx = childRes.garmentFamily
    ? mkCtx(childRes.garmentFamily, childUnion, childRes.spec, childRes.spec?.brandInCopy === false ? null : (childRes.spec?.brand ?? null))
    : null

  return {
    familyGarmentFamily: familyRes.garmentFamily,
    familyUnion,
    familyByStyle: familyRes.byStyle,
    childAssignmentHits: familyRes.childAssignmentHits ?? 0,
    familySource: familyRes.source,
    bySource: familyRes.bySource ?? {},
    mislabeledChild: {
      withOverride: resolveChildStyleCode('BB64000XL-BK-FBA', codes, CHILD_ASSIGNMENTS).code,
      withOverrideSource: resolveChildStyleCode('BB64000XL-BK-FBA', codes, CHILD_ASSIGNMENTS).source,
      withoutOverride: resolveChildStyleCode('BB64000XL-BK-FBA', codes, null).code,
      withoutOverrideSource: resolveChildStyleCode('BB64000XL-BK-FBA', codes, null).source,
      ownGarmentFamily: childRes.garmentFamily,
      ownUnion: childUnion,
      longSleeveShirtOnChild: !!childCtx && phraseTruthVerdict('Long Sleeve Shirt', childCtx).ok,
      longSleeveShirtOnFamily: !!familyCtx && phraseTruthVerdict('Long Sleeve Shirt', familyCtx).ok,
    },
    rows,
  }
}

/* ── DIRECT RUN: `npx tsx src/lib/fba/truthBandHarness.ts` ────────────────────────────────────── */
function report(): void {
  const r = runTruthBandHarness()
  console.log('\n═══ TRUTH+BAND MERGE GATE — B0DSCDZC6K ═══════════════════════════════════════')
  console.log(`family garment      : ${r.familyGarmentFamily}`)
  console.log(`family union        : ${JSON.stringify(r.familyUnion)}`)
  console.log(`byStyle             : ${JSON.stringify(r.familyByStyle)}`)
  console.log(`child assignments   : ${r.childAssignmentHits}   family source: ${r.familySource}   bySource: ${JSON.stringify(r.bySource)}`)
  console.log(`BB64000XL-BK-FBA    : with assignment -> ${r.mislabeledChild.withOverride} (${r.mislabeledChild.withOverrideSource}) | without -> ${r.mislabeledChild.withoutOverride} (${r.mislabeledChild.withoutOverrideSource})`)
  console.log(`  its own scope     : ${r.mislabeledChild.ownGarmentFamily} ${JSON.stringify(r.mislabeledChild.ownUnion)}`)
  console.log(`  "Long Sleeve Shirt" truthful on the CHILD: ${r.mislabeledChild.longSleeveShirtOnChild} | on the FAMILY: ${r.mislabeledChild.longSleeveShirtOnFamily}`)
  console.log(`\nband = ${TITLE_BAND_LO}-${TITLE_BAND_HI}\n`)
  for (const row of r.rows) {
    const ok = row.len >= TITLE_BAND_LO && row.len <= TITLE_BAND_HI
    console.log(`── ${row.scope} — ${row.design}  [${row.garmentFamily} | ${row.union.join('+')}]`)
    console.log(`   produced (${String(row.producedLen).padStart(2)}): ${row.produced}`)
    console.log(`   SHIPPED  (${String(row.len).padStart(2)}): ${row.title}   ${ok ? 'IN BAND' : '*** OUT OF BAND ***'}`)
    console.log(`   decision : ${row.decision}${row.hold ? '  [HOLD]' : ''} — ${row.reason}`)
    console.log('')
  }
  const bad = r.rows.filter((x) => x.len < TITLE_BAND_LO || x.len > TITLE_BAND_HI)
  console.log(bad.length === 0
    ? `ALL ${r.rows.length} TITLES IN BAND ${TITLE_BAND_LO}-${TITLE_BAND_HI}`
    : `${bad.length} TITLE(S) OUT OF BAND: ${bad.map((x) => `${x.scope}=${x.len}`).join(', ')}`)
}

// Node ESM: run the report only when this file is the entrypoint, never on import.
if (typeof process !== 'undefined' && process.argv[1] && /truthBandHarness\.ts$/.test(process.argv[1])) report()
