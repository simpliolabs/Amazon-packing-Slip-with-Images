/**
 * truthBandHarness.ts — THE MERGE GATE for the title truth+band contract, DRIVING THE DOOR
 * (handoff/TITLE_SETTLE_REWRITE.md, PO approval 2026-08-22).
 *
 * WHY THIS FILE WAS REWRITTEN. The pre-rewrite version of this harness called `enforceTitleTruthBand`
 * directly — a LEAF three stages downstream of what the route actually ships. The live door
 * (`bandTitle` in listingPipeline.ts, now `settleTitle` in titleBand.ts) ALSO runs casing, spec-truth,
 * cap+dedupe, waste-vocabulary stripping, the money tail, color stripping and the facts pad BEFORE the
 * truth+band settle — and #630/#632/#634/#637 each shipped live because a defect lived in one of
 * THOSE stages, which the leaf-only harness never exercised. A harness that green-lights a leaf while
 * the door ships lies is worse than no harness: it manufactured false confidence four times in a row.
 *
 * So this harness now calls `settleTitle` — the SAME function `bandTitle`'s thin adapter in
 * listingPipeline.ts calls, with no re-implementation in between. `truthBandGate.test.ts` is the
 * golden-band pin that fails the build if any produced title leaves the band, states a garment the
 * design's own blank is not, forces a gender on a unisex family, carries a sibling design's name,
 * names two garment classes, restates a concept in two spellings, or carries stray punctuation. Run it
 * directly to see the strings:
 *
 *     npx tsx src/lib/fba/truthBandHarness.ts
 *
 * THE FIXTURE IS B0DSCDZC6K, the family every one of the four reverted/patched PRs was measured on:
 * six designs, a mixed Gildan 18000 sweatshirt + 18500 hoodie blank union, `audience_lean='unisex'`,
 * and the one mislabeled child (`BB64000XL-BK-FBA`) whose SKU says 64000, whose Amazon title says
 * "Sweatshirt" and whose PO ruling says Comfort Colors 6014 LONG SLEEVE.
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
  settleTitle, pickDistinctGarmentForm, titleCasePhrase, isTitleWasteVocabulary,
  TITLE_BAND_LO, TITLE_BAND_HI, type TitleBandCtx, type MoneyTailCtx, type SettleTitleCtx,
  type TruthBandDecision,
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
 * group resolves to a mixed garment union its five siblings do not carry.
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
export const PARENT_ASIN = 'B0DSCDZC6K'

/**
 * THE POOL — exactly the eight phrases the acceptance fixture names. Four are UNTRUE for this
 * sweatshirt/hoodie unisex family and must never reach a title; four are TRUE and are exactly the
 * material the band needs to reach 70-75 from.
 */
export const POOL: string[] = [
  'funny work shirts',               // wrong-garment-noun on sweatshirt/hoodie
  'long sleeve',                     // TRUE — matches the family's own sleeve spec
  'pullover',                        // TRUE — the family's own garment vocabulary
  'crewneck',                        // TRUE — the 18000 half of the union
  'fall crewneck',                   // TRUE
  'mind your business',              // TRUE (and the "Mind" orphan-fragment specimen below)
  'graphic sweatshirts for women',   // TRUE garment, but forces a gender in the TITLE (unisex family)
  'tshirt for men',                  // wrong-garment-noun AND forces a gender — doubly untrue
]

/**
 * What a producer (council/LLM/prior fill) wrote BEFORE the door — carrying the live defect classes
 * verbatim: a tee/shirt noun on a sweatshirt/hoodie family, a forced gender on a unisex lean, a
 * sibling design's name inside another design's title, a stray comma before a separator, and a
 * concept restated in two spellings ("Long Sleeve" + "Longsleeve"). `settleTitle` — the real door —
 * must turn every one of these into a truthful, in-band, or honestly-held title.
 */
export const RAW_PARENT = 'THE CEO Motivational Entrepreneur, | Funny Work Shirts for Men'
export const RAW: Record<string, string> = {
  BB: 'THE CEO Business B*Tch Graphic Casual | Long Sleeve Longsleeve Tee for Men',
  BCS: 'THE CEO Billionare Coming Soon Sweatshirt | Funny Work Shirts for Women',
  DQ: "THE CEO Don't Quit Sweatshirt Business B*tch Crewneck | Long Sleeve for Men",
  ED: 'THE CEO Entrepreneur Definition Sweatshirt | Graphic Sweatshirts for Women',
  HD: 'THE CEO Hustle Definiton Sweatshirt Business B*tch | Long Sleeve for Men',
  MH: 'THE CEO Mother Hustler Hoodie | Funny Work Shirts for Women, Mind',
}

/** What is LIVE on Amazon today — what a truth+band REFUSAL preserves. Every one is itself
 *  truthful, in band (70-75, the same discipline a healthy prior would already meet), so a refusal
 *  is always a legitimate fallback, never a second lie and never a second short title. */
export const PRIOR_PARENT = 'THE CEO Motivational Sweatshirt | Long Sleeve Pullover Crewneck Gift Set'
export const PRIOR: Record<string, string> = {
  BB: 'THE CEO Business B*tch Sweatshirt | Long Sleeve Pullover Crewneck Gift',
  BCS: 'THE CEO Billionare Coming Soon Crewneck | Long Sleeve Pullover Sweatshirt',
  DQ: "THE CEO Don't Quit Sweatshirt | Long Sleeve Pullover Crewneck Gift Set",
  ED: 'THE CEO Entrepreneur Definition Sweatshirt | Long Sleeve Pullover Crewneck',
  HD: 'THE CEO Hustle Definiton Sweatshirt | Long Sleeve Pullover Crewneck Gift',
  MH: 'THE CEO Mother Hustler Hoodie | Long Sleeve Hooded Sweatshirt Cozy Gift',
}

/* ── THE RUNNER ───────────────────────────────────────────────────────────────────────────────── */

export interface HarnessRow {
  scope: string
  design: string
  garmentFamily: TruthGarmentFamily
  union: TruthGarmentFamily[]
  raw: string
  rawLen: number
  title: string
  len: number
  decision: TruthBandDecision
  hold: boolean
  reason: string
  tried: string[]
  /** TRUE when re-running `settleTitle` on ITS OWN shipped output returns the identical string
   *  (produced=true, same ctx). A verified, in-band, truthful title has nothing left for the door to
   *  do — so this failing would mean the returned title was NOT actually the fully-settled terminal
   *  state, which is exactly the invariant requirement #6 (nothing writes after the verify) exists to
   *  guarantee. See `truthBandGate.test.ts`'s "nothing writes after the verify" block. */
  idempotent: boolean
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
  /** ONE row per title exit, produced by calling `settleTitle` — THE DOOR — exactly as
   *  listingPipeline.ts's `bandTitle` adapter does. */
  rows: HarnessRow[]
}

/** The family's design-name union — the truth spine's design-token exemption input. */
const designNames = (): string[] => DESIGNS.map((d) => d.name)

/** The garment surface forms a set of blank families may truthfully claim (the pad's fact bank) —
 *  mirrors `garmentFactSegments` in listingPipeline.ts byte-for-byte. */
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

/** The truthful pool segments for ONE scope — the pad's third bank; mirrors `poolSegmentsFor`. */
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

/** Twin of `blankSpecFactTokens` (listingPipeline.ts) — search-shaped fact phrases from a blank spec,
 *  for the money-position gate (`dropSpecOnlyTail`). Kept local so this harness stays a zero-database
 *  leaf: importing the 9,400-line pipeline module would risk pulling in its module-scope Supabase
 *  client (the CI trap this repo's own build.yml is known to spring on lazy DB clients). */
function blankSpecFactTokensLike(spec: BlankSpec | null): string[] {
  if (!spec) return []
  const phrases = [spec.fit && `${spec.fit} fit`, spec.sleeve, spec.neck, spec.material, spec.dye, spec.weightNote]
  return phrases
    .filter((p): p is string => !!p)
    .map((p) => p.toLowerCase().replace(/[^a-z\s]/g, ' ').replace(/\boz\b/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
}

/** Twin of `capTitle75` (listingPipeline.ts), minus the inclusive-audience-tail special-casing this
 *  fixture never needs — word-boundary truncation + dangling-connector cleanup. Kept local for the
 *  same zero-database-leaf reason as `blankSpecFactTokensLike` above. */
function capTitle75Like(title: string): string {
  let t = (title || '').replace(/\s{2,}/g, ' ').trim()
  if (t.length <= 75) return t
  let cut = t.slice(0, 76)
  const lastSpace = cut.lastIndexOf(' ')
  cut = (lastSpace > 0 ? cut.slice(0, lastSpace) : cut.slice(0, 75)).trim()
  for (let guard = 0; guard < 6; guard++) {
    const tidied = cut.replace(/[\s,;:&|\-–—]+$/g, '').replace(/\s(?:for|and|with|in|of|to|a|an|the|or|by)$/i, '').trim()
    if (tidied === cut) break
    cut = tidied
  }
  return cut
}

/**
 * Build the FULL `SettleTitleCtx` for one exit — everything `settleTitle` (THE DOOR) needs, resolved
 * exactly the way listingPipeline.ts's `bandTitle` adapter resolves it from its own pipeline-local
 * state. This is what makes the harness drive the door rather than a leaf: every stage `settleTitle`
 * runs internally (casing, spec-truth, cap+dedupe, waste vocabulary, the money tail, color strip,
 * inclusive audience, the facts pad, the money-position gate, the terminal truth+band settle) receives
 * a real, fully-populated ctx here, not a partial one that only exercises the last stage.
 */
function buildSettleCtx(params: {
  truth: PhraseTruthCtx | null
  fams: readonly TruthGarmentFamily[]
  spec: BlankSpec | null
  brand: string
  protect: string
  prior: string | null
  reject?: (seg: string) => boolean
  foreignTokens?: ReadonlySet<string>
  holdScope: string
}): SettleTitleCtx {
  const truthOk = (s: string): boolean => !params.truth || phraseTruthVerdict(s, params.truth).ok
  const bandCtxFor = (title: string): TitleBandCtx => ({
    apparel: true,
    customizable: false,
    garmentBrand: params.brand || null,
    factSegments: garmentFacts(params.fams, title),
    poolSegments: poolFacts(truthOk, params.reject),
    truthOk,
    spec: params.spec ? { fit: params.spec.fit ? `${params.spec.fit} Fit` : null, sleeve: params.spec.sleeve ?? null, neck: params.spec.neck ?? null } : null,
    garmentSecond: pickDistinctGarmentForm(title, resolveGarment({ productType: PRODUCT_TYPE, title, blankFamily: params.fams[0] ?? null }).aliases),
  })
  const moneyCtx: MoneyTailCtx = {
    apparel: true,
    lean: AUDIENCE_LEAN,
    spec: params.spec ? { fit: params.spec.fit, sleeve: params.spec.sleeve, neck: params.spec.neck, weightNote: params.spec.weightNote } : null,
    protect: params.protect || null,
    garmentBrand: params.brand || null,
    truth: params.truth,
    foreignTokens: params.foreignTokens,
    allowAppend: true,
  }
  return {
    produced: true,
    apparel: true,
    bandCtxFor,
    // MONEY TAIL is out of scope for this fixture (Phase 1 in production only derives it for the
    // broadcast title; the defects this fixture exercises all live in the truth+band+pad path). The
    // dedicated `enforceMoneyTail` whole-string-verify coverage lives in titleBand.test.ts.
    moneyKws: null,
    moneyTailMode: 'off',
    moneyCtx,
    spec: params.spec,
    capTitle75: capTitle75Like,
    colorProtect: params.protect || null,
    lean: AUDIENCE_LEAN,
    v4NoPad: false,
    v4Mode: 'off',
    specFactTokens: blankSpecFactTokensLike(params.spec),
    truth: params.truth,
    protect: params.protect,
    reject: params.reject,
    foreignTokens: params.foreignTokens,
    // BROADCAST ONLY — see `applyTitleTruthNet`'s doc on `scrubProtectedOverlap`.
    scrubProtectedOverlap: params.holdScope === 'broadcast',
    prior: params.prior,
    holdScope: params.holdScope,
    parentAsin: PARENT_ASIN,
  }
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

  const rows: HarnessRow[] = []

  // THE DOOR, on the PARENT/broadcast title — no per-design scope: a family hub title is answerable
  // to every design, exactly as listingPipeline.ts calls `bandTitle` for `recommended_title`.
  {
    const ctx = buildSettleCtx({
      truth: familyCtx, fams: familyUnion, spec: familyRes.spec, brand: familyBrand,
      protect: designNames().join(' '), prior: PRIOR_PARENT, holdScope: 'broadcast',
    })
    const r = settleTitle(RAW_PARENT, ctx)
    const r2 = settleTitle(r.title, { ...ctx, produced: true })
    rows.push({
      scope: 'broadcast', design: '(family)',
      garmentFamily: familyRes.garmentFamily, union: familyUnion,
      raw: RAW_PARENT, rawLen: RAW_PARENT.length,
      title: r.title, len: r.title.length, decision: r.decision, hold: r.hold, reason: r.reason, tried: r.tried,
      idempotent: r2.title === r.title,
    })
  }

  // ── PER-DESIGN SCOPE: each group judged against ITS OWN resolved blank, through THE DOOR ──────
  const foreignFor = buildForeignDesignTokens(
    DESIGNS.map((d) => ({ key: d.key, name: d.name })),
    { familyTitleText: '', poolKeywords: [], strictNames: true },
  )

  for (const d of DESIGNS) {
    const groupChildren = children.filter((c) => c.designKey === d.key)
    const groupSkuHay = groupChildren.map((c) => c.sku).join(' ')
    const raw = RAW[d.key]
    const groupHay = `${raw} ${PRODUCT_TYPE} ${groupSkuHay}`
    const res = resolveFamilyBlank(CATALOG, groupChildren, null, groupHay, CHILD_ASSIGNMENTS)
    const union = res.garmentFamily ? familyGarmentUnion(CATALOG, res, groupHay) : []
    const brand = res.spec?.brandInCopy === false ? '' : (res.spec?.brand ?? '')
    const ctxTruth = res.garmentFamily ? mkCtx(res.garmentFamily, union, res.spec, brand || null) : familyCtx
    const fams: readonly TruthGarmentFamily[] = union.length ? union : familyUnion
    const foreign = foreignFor(d.key)
    const reject = foreign.size ? (seg: string) => isForeignToDesign(seg, foreign) : undefined
    const ctx = buildSettleCtx({
      truth: ctxTruth, fams, spec: res.spec ?? familyRes.spec, brand,
      protect: d.name, prior: PRIOR[d.key], reject, foreignTokens: foreign, holdScope: d.key,
    })
    const r = settleTitle(raw, ctx)
    const r2 = settleTitle(r.title, { ...ctx, produced: true })
    rows.push({
      scope: d.key, design: d.name,
      garmentFamily: res.garmentFamily ?? familyRes.garmentFamily, union: union.length ? union : familyUnion,
      raw, rawLen: raw.length,
      title: r.title, len: r.title.length, decision: r.decision, hold: r.hold, reason: r.reason, tried: r.tried,
      idempotent: r2.title === r.title,
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
  console.log('\n═══ TITLE-SETTLE MERGE GATE — B0DSCDZC6K, DRIVING THE DOOR (settleTitle) ═══════════════════')
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
    console.log(`   raw      (${String(row.rawLen).padStart(2)}): ${row.raw}`)
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
