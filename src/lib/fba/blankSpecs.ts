/**
 * blankSpecs.ts — the DB-backed garment-blank catalog (PO GO 2026-08-04; the minimal slice of the
 * facts lever from handoff/POOL_STRATA_PLAN.md §7).
 *
 * WHY: blank facts are THE proven title lever (adding the Gildan 64000 row moved B0GR22ZHBW's
 * title 63→70 with zero other changes) — but the catalog lived as a hardcoded const inside
 * listingPipeline.ts, so every new blank was a code deploy. This module makes `blank_specs` a
 * DB catalog (migration 053, seeded byte-identically from the two hardcoded rows): the PO adds or
 * corrects a blank with one SQL INSERT/UPDATE — no deploy — and the affected listings heal on
 * their next plain regen.
 *
 * FAIL-OPEN (doctrine): a DB blip must never strip garment facts from every regen. On any load
 * error, an empty table, or a bad regex row, the reader falls back to DEFAULT_BLANK_SPECS — the
 * same two rows the DB is seeded with, so day-one behavior is byte-identical and degraded-DB
 * behavior equals today's behavior. When the load SUCCEEDS, the DB is the ONLY source (the PO can
 * therefore also EDIT the seeded rows without a deploy).
 *
 * SPEC-VS-SEARCH GROUNDING (SELLER_PROFILE.md §2): every field here is a confirmed product FACT.
 * `brand` is the AUTHORITATIVE display casing; `brand_in_copy=false` means the facts decorate copy
 * but the brand NAME never appears in customer-facing text (the Gildan rule). `match_pattern` is a
 * case-insensitive regex over the listing hay (title/attribute/productType/SKUs — note \b64000
 * with no trailing boundary so SKU-glued style numbers like "640002XL" match).
 *
 * SKU-FIRST RESOLUTION (PO ruling 2026-08-21, SELLER_PROFILE.md "Blank identity is stated in the
 * CHILD SKU"; migration 058): the blank is the STYLE CODE in each child SKU's leading token
 * (`style_code` column), never a brand word inferred from the title. Order: per-child style codes →
 * `blank_family_overrides` (PO-maintained, for families whose SKUs carry no code) → the legacy
 * `match_pattern` regex over the hay. Mixed-blank families claim only the INTERSECTION of facts.
 * `garment_family` replaces the old looksShirt gate: a tee family never inherits a sweatshirt row
 * and vice-versa. `resolveFamilyBlank` is the ONE pure core; the pipeline and every out-of-pipeline
 * net site (resolveBlankRowForNet) call it.
 */
import { createClient } from '@supabase/supabase-js'
// capItemHighlightRepeats: the ONE Amazon word-repeat + <=75-char IH net (productDetailAttrs.ts) —
// reused, never re-implemented (Invariant 5). No cycle: productDetailAttrs imports only a TYPE from
// pushFields and the supabase client type; it never imports this module.
import { capItemHighlightRepeats, isItemHighlightsField, detailValueToString } from '@/lib/fba/productDetailAttrs'

export interface BlankSpec {
  brand?: string
  brandInCopy?: boolean
  fit?: string
  sleeve?: string
  neck?: string
  weightNote?: string
  material?: string
  dye?: string
  stretch?: string
  fitToSize?: string
  /** TRUE = the blank is cut on a unisex size chart (PO 2026-08-06: whole current catalog).
   *  Drives the sizing-clarity copy in bullets/description/features — NEVER the title (PO rule).
   *  DB-only by design (seeds stay byte-identical to migration 053; fail-open = no claim). */
  unisex?: boolean
}

/** blank_specs.garment_family (migration 058). Drives the garment-compatibility gate and the Item
 *  Highlights composer's truth stage (garment nouns + audience — kids_tee reaches it UNFOLDED). */
export type GarmentFamily = 'tee' | 'long_sleeve_tee' | 'sweatshirt' | 'hoodie' | 'kids_tee'
const GARMENT_FAMILIES: ReadonlySet<string> = new Set<GarmentFamily>(['tee', 'long_sleeve_tee', 'sweatshirt', 'hoodie', 'kids_tee'])

export interface BlankSpecRow {
  match: RegExp
  spec: BlankSpec
  /** Manufacturer style code as stated in the child SKU leading token (058). Absent on pre-058 rows. */
  styleCode?: string
  /** Absent on pre-058 rows — treated as a tee by the compatibility gate (the historical catalog). */
  garmentFamily?: GarmentFamily
}

/** The seed rows — byte-identical to the historical hardcoded table (and to migration 053's
 *  seeds; 058 stamps the same two rows with style_code/garment_family, mirrored here so the
 *  fail-open floor still resolves 1717/64000 SKUs). These are the fail-open floor, never an
 *  alternate behavior path. */
export const DEFAULT_BLANK_SPECS: BlankSpecRow[] = [
  { match: /\bcomfort\s*colors?\b/i, spec: { brand: 'Comfort Colors', fit: 'Relaxed', sleeve: 'Short Sleeve', neck: 'Crew Neck', weightNote: 'midweight 6.1 oz garment-dyed', material: '100% Ring-Spun Cotton', dye: 'Garment-Dyed', stretch: 'Low Stretch', fitToSize: 'Runs Slightly Small' }, styleCode: '1717', garmentFamily: 'tee' },
  { match: /\bgildan\b|\b64000/i, spec: { brand: 'Gildan', brandInCopy: false, fit: 'Classic', sleeve: 'Short Sleeve', neck: 'Crew Neck', weightNote: 'lightweight 4.5 oz ring-spun', material: 'Ring-Spun Cotton' }, styleCode: '64000', garmentFamily: 'tee' },
]

// Lazy Proxy (tests-into-CI pattern): defer client construction so env-free unit tests never touch it.
let _supabase: ReturnType<typeof createClient<any>> | null = null
const supabase = new Proxy({} as ReturnType<typeof createClient<any>>, {
  get(_t, prop) {
    _supabase ??= createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
    return (_supabase as unknown as Record<string | symbol, unknown>)[prop]
  },
})

interface DbRow {
  match_pattern?: string | null
  brand?: string | null
  brand_in_copy?: boolean | null
  fit?: string | null
  sleeve?: string | null
  neck?: string | null
  weight_note?: string | null
  material?: string | null
  dye?: string | null
  stretch?: string | null
  fit_to_size?: string | null
  unisex?: boolean | null
  active?: boolean | null
  style_code?: string | null
  garment_family?: string | null
}

/** DB row → BlankSpecRow. Null columns become ABSENT fields (undefined) so every existing
 *  `spec.field ? …` consumer behaves identically to the hardcoded rows. brand_in_copy defaults
 *  true in the DB; only an explicit false materializes (the CC row historically OMITS the field).
 *
 *  ⚠ PO DATA RULE (adversarial HIGH, 2026-08-08): a NULL brand_in_copy materializes as ALLOWED —
 *  the brand-insertion net below will then put that brand into customer-facing Item Highlights.
 *  Any new row for a brand whose name must stay out of copy (every Gildan-family variant — the
 *  SELLER_PROFILE §5 "NEVER Gildan" rule) MUST set brand_in_copy=false EXPLICITLY in its INSERT;
 *  relying on the default silently opts the brand INTO copy. */
export function rowToSpec(row: DbRow): BlankSpecRow | null {
  if (!row.match_pattern) return null
  let match: RegExp
  try {
    match = new RegExp(row.match_pattern, 'i')
  } catch {
    console.warn(`[blankSpecs] invalid match_pattern skipped: ${JSON.stringify(row.match_pattern)}`)
    return null
  }
  const spec: BlankSpec = {}
  if (row.brand) spec.brand = row.brand
  if (row.brand_in_copy === false) spec.brandInCopy = false
  if (row.fit) spec.fit = row.fit
  if (row.sleeve) spec.sleeve = row.sleeve
  if (row.neck) spec.neck = row.neck
  if (row.weight_note) spec.weightNote = row.weight_note
  if (row.material) spec.material = row.material
  if (row.dye) spec.dye = row.dye
  if (row.stretch) spec.stretch = row.stretch
  if (row.fit_to_size) spec.fitToSize = row.fit_to_size
  if (row.unisex === true) spec.unisex = true
  const out: BlankSpecRow = { match, spec }
  // 058 columns — fail-open: a pre-058 DB (or NULL) leaves both absent = legacy regex behaviour.
  const code = (row.style_code ?? '').trim().toUpperCase()
  if (code) out.styleCode = code
  const gf = (row.garment_family ?? '').trim()
  if (GARMENT_FAMILIES.has(gf)) out.garmentFamily = gf as GarmentFamily
  return out
}

const CACHE_TTL_MS = 5 * 60 * 1000
/** A HANG is worse than an error here: an unreachable-but-not-erroring DB (CI proved the class —
 *  the select hung >5s with real env vars but no egress) would stall every regen at the blank
 *  lookup. The race turns a hang into the same fail-open the error path takes. */
const LOAD_TIMEOUT_MS = 4000
let cache: { rows: BlankSpecRow[]; at: number } | null = null

function withTimeout<T>(query: PromiseLike<T>, timeoutMs: number, label: string): Promise<T> {
  return Promise.race([
    query,
    new Promise<never>((_, reject) => {
      const t = setTimeout(() => reject(new Error(`${label} load timed out after ${timeoutMs}ms`)), timeoutMs)
      ;(t as unknown as { unref?: () => void }).unref?.()
    }),
  ])
}

/** Load the catalog (5-min cache; ONE cheap read per window). Fail-open to the seeds. */
export async function loadBlankSpecRows(timeoutMs: number = LOAD_TIMEOUT_MS): Promise<BlankSpecRow[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.rows
  try {
    // .order('id') is LOAD-BEARING: matchBlankSpec is first-match-wins, and Postgres row order is
    // unspecified without it — a PO-added row must never nondeterministically shadow a seed.
    const query = supabase.from('blank_specs').select('*').eq('active', true).order('id', { ascending: true })
    const { data, error } = await withTimeout(query, timeoutMs, 'blank_specs')
    if (error) throw new Error(error.message)
    const rows = (Array.isArray(data) ? (data as DbRow[]) : []).map(rowToSpec).filter((r): r is BlankSpecRow => !!r)
    if (rows.length === 0) throw new Error('blank_specs empty — using seeds')
    cache = { rows, at: Date.now() }
    return rows
  } catch (e) {
    console.warn('[blankSpecs] catalog load failed (fail-open to seeds):', e instanceof Error ? e.message : e)
    cache = { rows: DEFAULT_BLANK_SPECS, at: Date.now() }
    return DEFAULT_BLANK_SPECS
  }
}

let overrideCache: { map: Map<string, string>; at: number } | null = null

/** blank_family_overrides (058): parent ASIN → style_code, PO-maintained for families whose child
 *  SKUs carry no style code. Tiny table, ONE read per 5-min window. Fail-open to "no override". */
export async function loadBlankFamilyOverrides(timeoutMs: number = LOAD_TIMEOUT_MS): Promise<Map<string, string>> {
  if (overrideCache && Date.now() - overrideCache.at < CACHE_TTL_MS) return overrideCache.map
  try {
    const query = supabase.from('blank_family_overrides').select('parent_asin, style_code').limit(1000)
    const { data, error } = await withTimeout(query, timeoutMs, 'blank_family_overrides')
    if (error) throw new Error(error.message)
    const map = new Map<string, string>()
    for (const r of (Array.isArray(data) ? data : []) as { parent_asin?: string | null; style_code?: string | null }[]) {
      const asin = (r.parent_asin ?? '').trim().toUpperCase()
      const code = (r.style_code ?? '').trim().toUpperCase()
      if (asin && code) map.set(asin, code)
    }
    overrideCache = { map, at: Date.now() }
    return map
  } catch (e) {
    console.warn('[blankSpecs] blank_family_overrides load failed (fail-open: no override):', e instanceof Error ? e.message : e)
    overrideCache = { map: new Map(), at: Date.now() }
    return overrideCache.map
  }
}

/** The override style code for ONE family, or null. */
export async function loadBlankFamilyOverride(parentAsin: string | null | undefined): Promise<string | null> {
  const asin = (parentAsin ?? '').trim().toUpperCase()
  if (!asin) return null
  return (await loadBlankFamilyOverrides()).get(asin) ?? null
}

// ─── SKU-FIRST FAMILY RESOLUTION (PO ruling 2026-08-21) — the pure core ─────────────────────────

/** What may follow a digit-ending style code inside the SKU leading token: nothing, a letter run
 *  (size or colour: 64000S, 64000BLK) or a glued numeric size (640002XL). A further DIGIT is not a
 *  size and means the token is some other number (17170 is not a 1717). */
const AFTER_DIGIT_CODE_RE = /^(?:$|[A-Z]|[2-6]X)/
/** What may follow a LETTER-ending code (64000B) or an elided trailing zero (1800 for 18000): only
 *  a recognised size token (adult or Y-prefixed youth), or nothing. The letter glue is ambiguous
 *  ("64000BLK" is the adult code + a colour, not youth + "LK"), so only a size disambiguates. */
const SIZE_TOKEN_RE = /^(?:$|(?:Y?(?:XXS|XS|S|M|L|XL|XXL|XXXL)|[2-6]XL?)(?![A-Z0-9]))/

/**
 * The style code stated by ONE child SKU, or null. Pure, data-driven: `codes` are the catalog's
 * style_code values (any order; matched LONGEST-FIRST so 64000B beats 64000 and 18500 is never
 * read as 1800). Scans the SKU's LEADING token only (before the first -/_/space), strips a letter
 * prefix (ADWF64000, G644002XL, BCSG18002X, BC3001XL) and tolerates a glued size. A full-code match
 * always beats the trailing-zero elision (EDG1800L / BCSG18002X → 18000, the PO's "1800x").
 */
export function extractStyleCode(sku: string | null | undefined, codes: readonly string[]): string | null {
  const token = (sku ?? '').trim().toUpperCase().split(/[-_\s]/)[0] ?? ''
  const body = token.replace(/^[A-Z]+/, '')
  if (!body) return null
  // A code is compared by its own letter-stripped body too, so a PO who types the SELLER_PROFILE
  // spelling ('G64400', 'BC3001') still matches; the RETURNED value is the catalog's code verbatim.
  const ordered = [...new Map(codes.map((c) => c.trim().toUpperCase()).filter(Boolean).map((c) => [c, c.replace(/^[A-Z]+/, '')] as const)).entries()]
    .filter(([, cb]) => cb.length > 0)
    .sort((a, b) => b[1].length - a[1].length)
  for (const [code, cb] of ordered) {
    if (!body.startsWith(cb)) continue
    const rest = body.slice(cb.length)
    if (/[A-Z]$/.test(cb) ? SIZE_TOKEN_RE.test(rest) : AFTER_DIGIT_CODE_RE.test(rest)) return code
  }
  for (const [code, cb] of ordered) {
    if (!cb.endsWith('0')) continue
    const elided = cb.slice(0, -1)
    if (body.startsWith(elided) && SIZE_TOKEN_RE.test(body.slice(elided.length))) return code
  }
  return null
}

/** Exact-match facts: a cut/neck/sleeve that differs between children is never claimed. */
const INTERSECT_EXACT_KEYS = ['brand', 'fit', 'sleeve', 'neck', 'dye', 'stretch', 'fitToSize'] as const

/** Case-insensitive token set of a material string ("100% Airlume Combed Ring-Spun Cotton" →
 *  {100%, airlume, combed, ring, spun, cotton}). */
const materialTokens = (v: string): Set<string> => new Set(v.toLowerCase().split(/[\s\-\/]+/).filter(Boolean))

/** The facts EVERY resolved blank agrees on (PO: "a fact that differs between children — sleeve,
 *  neck — is never claimed"). brandInCopy=false if ANY blank forbids its brand; unisex only when
 *  all claim it. A single spec is returned as-is.
 *
 *  SEMANTIC intersection for the two prose facts (PO 2026-08-21, B0GR1K3TXF 64000 + BC3001: the
 *  exact-match drop of "Ring-Spun Cotton" vs "100% Airlume Combed Ring-Spun Cotton" left the
 *  family no truthful filler and the Item Highlight under floor):
 *   - material: kept when one value is a case-insensitive substring OR token-subset of every other
 *     — the SHORTEST such value is the shared fact ("Ring-Spun Cotton" ⊂ the Airlume string).
 *   - weightNote: kept as the shared CLASS WORD ("lightweight") only when trueWeightClass agrees
 *     across every blank — the ounce figures differ and are never claimed.
 *  fit / neck / sleeve / dye / stretch / fitToSize / brand stay exact-match. */
export function intersectBlankSpecs(specs: readonly BlankSpec[]): BlankSpec | null {
  if (specs.length === 0) return null
  if (specs.length === 1) return specs[0]
  const out: BlankSpec = {}
  if (specs.some((s) => s.brandInCopy === false)) out.brandInCopy = false
  for (const k of INTERSECT_EXACT_KEYS) {
    const v = specs[0][k]
    if (v && specs.every((s) => s[k] === v)) out[k] = v
  }
  const materials = specs.map((s) => (s.material ?? '').trim())
  if (materials.every(Boolean)) {
    const shared = [...materials].sort((a, b) => a.length - b.length).find((cand) => {
      const lc = cand.toLowerCase(); const toks = materialTokens(cand)
      return materials.every((m) => m.toLowerCase().includes(lc) || [...toks].every((t) => materialTokens(m).has(t)))
    })
    if (shared) out.material = shared
  }
  const classes = specs.map((s) => trueWeightClass(s))
  if (classes[0] && classes.every((c) => c === classes[0])) {
    out.weightNote = specs.every((s) => s.weightNote === specs[0].weightNote) ? specs[0].weightNote : classes[0]
  }
  if (specs.every((s) => s.unisex === true)) out.unisex = true
  return out
}

export type BlankSource = 'sku' | 'override' | 'legacy'
export interface FamilyBlankResolution {
  /** Most-common resolved blank (ties → catalog id order). null = unresolved. */
  dominant: BlankSpecRow | null
  /** Child count per extracted style code (SKU path only; {} on override/legacy). */
  byStyle: Record<string, number>
  /** More than one distinct blank among the children. */
  mixed: boolean
  /** The INTERSECTED spec — what copy may claim for the whole family. */
  spec: BlankSpec | null
  garmentFamily: GarmentFamily | null
  source: BlankSource | null
}
const EMPTY_RESOLUTION: FamilyBlankResolution = { dominant: null, byStyle: {}, mixed: false, spec: null, garmentFamily: null, source: null }

type GarmentClass = 'tee' | 'sweat'
/** The garment class the listing HAY names (same regexes as the historical looksShirt gate). */
function hayGarmentClass(hay: string): GarmentClass | null {
  if (/sweat|hoodie|fleece|pullover/i.test(hay)) return 'sweat'
  if (/\bt?[\s-]?shirts?\b|\btees?\b/i.test(hay)) return 'tee'
  return null
}
/** Pre-058 rows (no garment_family) ARE tees — the whole historical catalog was. */
function rowGarmentClass(row: BlankSpecRow): GarmentClass {
  return row.garmentFamily === 'sweatshirt' || row.garmentFamily === 'hoodie' ? 'sweat' : 'tee'
}

/**
 * THE resolver (pure). Order: per-child style codes → `override` (blank_family_overrides) → the
 * legacy match_pattern regex over `hay` (only when the hay names a garment class — the historical
 * gate, preserved) → unresolved. Then the GARMENT-COMPATIBILITY gate: when the hay names a class
 * and EVERY resolved row is of the other class (a "Sweatshirt" family resolving tee rows, or a
 * "Shirt" family resolving a hoodie), the family is unresolved with a BLANK_GARMENT_CONFLICT warn
 * — a wrong blank is worse than no blank. A partial conflict is warned and kept: the intersection
 * already drops every fact the conflicting rows disagree on.
 */
export function resolveFamilyBlank(
  rows: readonly BlankSpecRow[],
  children: readonly { sku?: string | null }[],
  override: string | null | undefined,
  hay: string,
): FamilyBlankResolution {
  const codes = rows.map((r) => r.styleCode).filter((c): c is string => !!c)
  const rowFor = (code: string): BlankSpecRow | null => rows.find((r) => r.styleCode === code.trim().toUpperCase()) ?? null
  const byStyle: Record<string, number> = {}
  for (const c of children) {
    const code = extractStyleCode(c.sku, codes)
    if (code) byStyle[code] = (byStyle[code] ?? 0) + 1
  }
  let resolved: BlankSpecRow[] = []
  let source: BlankSource | null = null
  // Count DESC, then catalog (id) order on ties — deterministic dominance.
  const ranked = Object.entries(byStyle).sort((a, b) => (b[1] - a[1]) || (rows.findIndex((r) => r.styleCode === a[0]) - rows.findIndex((r) => r.styleCode === b[0])))
  for (const [code] of ranked) {
    const r = rowFor(code)
    if (r && !resolved.includes(r)) resolved.push(r)
  }
  if (resolved.length > 0) source = 'sku'
  if (resolved.length === 0 && override) {
    const r = rowFor(override)
    if (r) { resolved = [r]; source = 'override' }
  }
  const hayClass = hayGarmentClass(hay)
  if (resolved.length === 0 && hayClass) {
    const r = matchBlankSpecRow(rows, hay)
    if (r) { resolved = [r]; source = 'legacy' }
  }
  if (resolved.length === 0) return { ...EMPTY_RESOLUTION, byStyle }
  if (hayClass) {
    const conflicting = resolved.filter((r) => rowGarmentClass(r) !== hayClass)
    if (conflicting.length > 0) {
      const nulled = conflicting.length === resolved.length
      console.warn(JSON.stringify({ tag: 'BLANK_GARMENT_CONFLICT', hayClass, source, conflicting: conflicting.map((r) => r.styleCode ?? r.spec.brand ?? '?'), nulled }))
      if (nulled) return { ...EMPTY_RESOLUTION, byStyle }
    }
  }
  const dominant = resolved[0]
  return {
    dominant,
    byStyle,
    mixed: resolved.length > 1,
    spec: intersectBlankSpecs(resolved.map((r) => r.spec)),
    garmentFamily: dominant.garmentFamily ?? null,
    source,
  }
}

/** The resolution as the BlankSpecRow shape every existing consumer reads: the dominant row's
 *  match regex, with `spec` = the family INTERSECTION (a mixed-brand family therefore carries no
 *  brand, so the brand-insertion net can never claim one). */
export function familyBlankRow(res: FamilyBlankResolution): BlankSpecRow | null {
  if (!res.dominant) return null
  const out: BlankSpecRow = { match: res.dominant.match, spec: res.spec ?? res.dominant.spec }
  if (res.dominant.styleCode) out.styleCode = res.dominant.styleCode
  if (res.garmentFamily) out.garmentFamily = res.garmentFamily
  return out
}

/** Row-returning lookup (first matching row wins, over the joined hay of every non-empty source).
 *  Callers that need the match REGEX as well as the spec (the blank-brand IH net below) use this;
 *  `matchBlankSpec` stays the spec-only convenience every existing consumer already calls. */
export function matchBlankSpecRow(rows: readonly BlankSpecRow[], ...sources: (string | null | undefined)[]): BlankSpecRow | null {
  const hay = sources.filter(Boolean).join(' ')
  for (const b of rows) if (b.match.test(hay)) return b
  return null
}

/** The lookup — identical semantics to the historical lookupBlankSpec (first matching row wins,
 *  over the joined hay of every non-empty source). */
export function matchBlankSpec(rows: readonly BlankSpecRow[], ...sources: (string | null | undefined)[]): BlankSpec | null {
  return matchBlankSpecRow(rows, ...sources)?.spec ?? null
}

/**
 * BLANK-BRAND IH WATERFALL — deterministic terminal net (PO 2026-08-08, SELLER_PROFILE.md §5:
 * "if Comfort Colors is not in Title it needs to go to HIGHLIGHTS").
 *
 * When the FINAL title (including a PO manual lock — the title the IH will actually sit beside)
 * does NOT carry the matched blank's brand AND the blank allows its brand in copy
 * (`brandInCopy !== false` — the Gildan rule is enforced by DATA, never a second hardcoded check),
 * the Item Highlights MUST carry the brand as a fact. Runs on the SHIPPED bytes, after the last
 * LLM stage, on BOTH generator paths (LLM output + spec fallback) and the regen route — never a
 * prompt hint.
 *
 * 2026-08-21 (PO, B0FKFHSCS9): the COMPOSER now satisfies the waterfall INSIDE the line with one
 * brand-bearing phrase, so on the generation path this net must see `ih-carries` and return the
 * bytes UNTOUCHED — it never truncates or re-orders a line that already carries the brand (pinned
 * T4.10). The insertion below remains for the stored-IH re-net sites (title partial, lock guard).
 *
 * Mechanics: PREPEND `authentic <brand> blank` — insertion order is the survival mechanism, because
 * `capItemHighlightRepeats` keeps earlier phrases and drops later ones at the ≤75-char / ≤2-per-word
 * caps, at generation AND at the push boundary (buildDetailPatchValue). Post-condition guard: if the
 * capped result would drop below 2 comma phrases, the ORIGINAL string is returned unchanged — the
 * brand is never bought at the price of IH compliance.
 *
 * Idempotent: once inserted, the IH itself matches the brand test and every later pass no-ops.
 */
export function ensureBlankBrandInHighlights(
  hl: string,
  titles: (string | null | undefined)[],
  blank: BlankSpecRow | null,
): string {
  // One JSON line per invocation (adversarial LOW, 2026-08-08 — SHIP_BAND_DECISION doctrine: "the
  // net fired", "never fired" and "fired and did nothing" must be distinguishable in prod logs).
  const log = (decision: string, extra?: Record<string, unknown>): void => {
    console.log(JSON.stringify({ tag: 'BLANK_BRAND_NET', decision, brand: blank?.spec.brand ?? null, ...extra }))
  }
  const brand = blank?.spec.brand
  if (!hl || !hl.trim() || !blank || !brand) { if (blank || hl) log('no-blank'); return hl }
  if (blank.spec.brandInCopy === false) { log('brand-not-in-copy'); return hl } // NEVER Gildan — brand_in_copy=false short-circuits
  // Separator-blind carry test (adversarial LOW): "Comfort-Colors Tee" must count as carrying the
  // brand — flatten every non-alphanumeric run to a single space before both the regex and the
  // includes() probe (the CC regex only spans zero-or-more WHITESPACE, so a hyphen slipped through
  // and the net redundantly inserted the brand beside a title that already named it).
  const flatten = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  const brandFlat = flatten(brand)
  const carries = (s: string): boolean => blank.match.test(s) || blank.match.test(flatten(s)) || flatten(s).includes(brandFlat)
  // Waterfall satisfied ONLY when EVERY shipped title carries the brand (adversarial LOW,
  // multi-design): the IH is ONE broadcast value pushed to every SKU, while per_child_titles ship
  // per SKU — if ANY child's title lacks the brand, that child's PDP would show it nowhere, so the
  // IH must carry it. some() → every() is the conservative direction (inserts more, never fewer).
  const named = titles.filter((t): t is string => !!t && !!t.trim())
  if (named.length > 0 && named.every((t) => carries(t))) { log('title-carries'); return hl }
  if (carries(hl)) { log('ih-carries'); return hl } // IH already carries it — idempotence
  const candidate = capItemHighlightRepeats(`authentic ${brand} blank, ${hl}`)
  const phrases = candidate.split(',').map((p) => p.trim()).filter(Boolean)
  if (phrases.length < 2) { log('floor-abort', { from: hl.length }); return hl } // compliance floor: an IH must keep >=2 phrases
  const evicted = hl.split(',').map((p) => p.trim()).filter(Boolean).length + 1 - phrases.length
  log('inserted', { evictedPhrases: evicted, from: hl.length, to: candidate.length })
  return candidate
}

/**
 * Resolve the blank row for the BRAND-INSERTION net from SPEC-TRUTH sources ONLY (adversarial
 * HIGH, 2026-08-08): titles + live listing_content title/productType/SKU style numbers — NEVER a
 * search keyphrase. A search phrase is market vocabulary ("comfort colors" contaminates other
 * listings' pools — rankAnalysis.ts:290), and first-match-wins row selection over a pin-bearing hay
 * let a Gildan 64000 family select the CC row and earn a FALSE "authentic Comfort Colors blank"
 * claim. This is the ONE resolver for every out-of-pipeline net site (regenerate-item-highlight,
 * the ai-recommendations title partial, the persist-time lock guard) — one seam, no drift.
 * Best-effort: any failure returns null → the net no-ops.
 *
 * SKU-FIRST (PO 2026-08-21): reads every child SKU of the family (listing_content by parent_asin)
 * and hands them to resolveFamilyBlank — per-child style codes → family override → legacy regex.
 * `resolveFamilyBlankForNet` is the rich result; this wrapper keeps the historical row shape with
 * `spec` = the family intersection.
 */
export async function resolveFamilyBlankForNet(
  // Any supabase-js client (routes construct their own); the minimal surface we call.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  opts: { parentAsin?: string | null; childAsin?: string | null; titles: (string | null | undefined)[] },
): Promise<FamilyBlankResolution> {
  try {
    let rows: { sku?: string; title?: string }[] = []
    // 2026-08-21 LIVE FINDING: this read selected a `product_type` column that listing_content has
    // NEVER had — PostgREST rejected the select, the error was discarded, and the resolver read ZERO
    // child rows for every family since 2026-08-08 (only the passed-in titles ever matched; the SKU
    // half of "spec truth" was dead from birth). Select only real columns and never hide the error.
    // limit 500, not 50: dominance needs EVERY child (B0GR1K3TXF is 85 + 41 children × FBA/FBM twins).
    if (opts.parentAsin) {
      const { data, error } = await db.from('listing_content').select('sku, title').eq('parent_asin', opts.parentAsin).limit(500)
      if (error) console.error(`[blankSpecs] BLANK_RESOLVE_READ_FAILED parent=${opts.parentAsin}: ${error.message}`)
      if (Array.isArray(data)) rows = data
    }
    if (rows.length === 0 && opts.childAsin) {
      const { data, error } = await db.from('listing_content').select('sku, title').eq('asin', opts.childAsin).limit(500)
      if (error) console.error(`[blankSpecs] BLANK_RESOLVE_READ_FAILED asin=${opts.childAsin}: ${error.message}`)
      if (Array.isArray(data)) rows = data
    }
    const liveTitle = rows.find((r) => (r.title ?? '').trim())?.title ?? ''
    const skuHay = rows.map((r) => r.sku).filter(Boolean).join(' ')
    const hay = [...opts.titles, liveTitle, skuHay].filter(Boolean).join(' ')
    const [catalog, override] = await Promise.all([loadBlankSpecRows(), loadBlankFamilyOverride(opts.parentAsin)])
    const res = resolveFamilyBlank(catalog, rows, override, hay)
    console.log(JSON.stringify({ tag: 'BLANK_RESOLVE', site: 'net', parent: opts.parentAsin ?? null, source: res.source, styleCode: res.dominant?.styleCode ?? null, garmentFamily: res.garmentFamily, mixed: res.mixed, byStyle: res.byStyle, children: rows.length }))
    return res
  } catch (e) {
    console.warn('[blankSpecs] blank-row net resolution failed (net no-ops):', e instanceof Error ? e.message : e)
    return EMPTY_RESOLUTION
  }
}

export async function resolveBlankRowForNet(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  opts: { parentAsin?: string | null; childAsin?: string | null; titles: (string | null | undefined)[] },
): Promise<BlankSpecRow | null> {
  return familyBlankRow(await resolveFamilyBlankForNet(db, opts))
}

/**
 * Re-run the blank-brand waterfall net over a STORED product_details_improvements array against the
 * title(s) that will actually ship (adversarial MEDIUMs, 2026-08-08: a title-only section regen and
 * the persist-time manual-lock guard both change the shipped title AFTER the IH was netted, so the
 * stored IH must be re-netted or brand-in-neither persists). Pure: returns the SAME array reference
 * with `changed:false` when the net no-ops, so callers can skip the DB write. Insert-only — a title
 * that GAINED the brand leaves an IH that also carries it untouched (redundancy is not a §5
 * violation; removal would churn approved copy).
 */
export function applyBlankBrandNetToDetails(
  details: unknown,
  titles: (string | null | undefined)[],
  blank: BlankSpecRow | null,
): { details: Record<string, unknown>[]; changed: boolean } {
  const arr = Array.isArray(details) ? (details as Record<string, unknown>[]) : []
  if (arr.length === 0 || !blank) return { details: arr, changed: false }
  const idx = arr.findIndex((p) => isItemHighlightsField(detailValueToString(p.field_name), (p as { sp_api_key?: string }).sp_api_key))
  if (idx < 0) return { details: arr, changed: false }
  const current = detailValueToString(arr[idx].recommended_value)
  if (!current.trim()) return { details: arr, changed: false }
  const netted = capItemHighlightRepeats(ensureBlankBrandInHighlights(current, titles, blank))
  if (netted === current) return { details: arr, changed: false }
  // WATERFALL WINS (PO ruling, SELLER_PROFILE §5 — adversarial precedence question 2026-08-08):
  // this net MAY rewrite even a sticky-kept PO-ACCEPTED Item Highlight when the shipping titles
  // lack the blank brand — §5's MUST ("the Item Highlights MUST carry it") is the PO's standing
  // rule, so brand presence beats the accepted string. Only recommended_value changes
  // (current_value stays at the accepted/live value), so the rewrite surfaces as a fresh Push
  // proposal requiring PO action — it never ships silently. Stamp value_source:'spec' (the value
  // is blank_specs-derived truth) so the NEXT regen's sticky gate classifies it as a legitimate
  // spec re-propose instead of re-deriving the same snap→net cycle every regen. Logged loudly.
  console.log(JSON.stringify({ tag: 'BLANK_BRAND_NET', decision: 'details-rewrite', field: detailValueToString(arr[idx].field_name), from: current, to: netted, note: 'waterfall-over-sticky: may rewrite an accepted IH per SELLER_PROFILE §5; surfaces as Push, never ships silently' }))
  const out = arr.map((p, i) => (i === idx ? { ...p, recommended_value: netted, value_source: 'spec' } : p))
  return { details: out, changed: true }
}

// ─── FABRIC-TRUTH TERMINAL NET (task #41 / GAP 2, 2026-08-19) ────────────────────────────────────
// The craft review caught "midweight" ×3 shipped for a Gildan 64000 (lightweight 4.5 oz) — the
// LLM contradicting the system's own spec catalog. The title brief already carries a GARMENT TRUTH
// prompt clause; a prompt is a request, never a guarantee (generation-invariants INVARIANT 2), so
// this deterministic net runs LAST on the shipped bytes of every prose surface. It also repairs
// the dangling-conjunction amputation artifact ("layers cleanly under flannels, or.") that phrase
// scrubs leave behind.

const WEIGHT_CLASS_RE = /\b(?:light|mid|middle|heavy)[\s-]?weight\b/gi

/** The blank's true weight class word, from its weightNote — or null when the blank is unconfirmed. */
export function trueWeightClass(spec?: Pick<BlankSpec, 'weightNote'> | null): 'lightweight' | 'midweight' | 'heavyweight' | null {
  const note = spec?.weightNote?.toLowerCase() ?? ''
  if (/\blight/.test(note)) return 'lightweight'
  if (/\bmid|\bmiddle/.test(note)) return 'midweight'
  if (/\bheavy/.test(note)) return 'heavyweight'
  return null
}

/**
 * Deterministic, idempotent, pure. Enforces on any prose surface (bullet, description HTML, IH):
 *  1. WEIGHT: every weight-class adjective is rewritten to the blank's TRUE class; when the blank
 *     is unconfirmed (no weightNote), the adjective is removed — an unverifiable claim never ships.
 *  2. STRETCH: stretch-positive claims ("stretchy", "4-way stretch") are removed unless the spec
 *     explicitly declares a stretchy fabric (the current catalog is Low Stretch or silent).
 *  3. TIDY: dangling conjunctions left by phrase removal — ", or." / ", and…" before a sentence
 *     end — collapse to a clean period, and doubled whitespace is folded.
 * HTML-safe: replacements never touch tags (the patterns match prose words only).
 */
export function enforceFabricTruth(text: string, spec?: Pick<BlankSpec, 'weightNote' | 'stretch'> | null): string {
  if (!text) return text
  let t = text
  const wt = trueWeightClass(spec)
  t = t.replace(WEIGHT_CLASS_RE, () => wt ?? '')
  // Stretch claims: allowed ONLY when the spec positively declares stretch (not "Low Stretch").
  const stretchOk = !!spec?.stretch && !/low|no\b/i.test(spec.stretch)
  if (!stretchOk) {
    t = t.replace(/(?:\bwith\s+|\band\s+)?\b(?:(?:2|4|two|four)[\s-]?way\s+)?stretch(?:y|able|iness)?\b/gi, '')
  }
  // Tidy: fold whitespace runs the removals leave, fix " ," / " ." gaps, then repair dangling
  // conjunctions before a sentence end ("…flannels, or." → "…flannels.").
  t = t.replace(/[ \t]{2,}/g, ' ').replace(/ +([,.;])/g, '$1')
  t = t.replace(/,\s*(?:or|and|but|with|plus|for)\s*\./gi, '.')
  t = t.replace(/,\s*(?:or|and|but|with|plus|for)\s*(<\/(?:p|li)>)/gi, '.$1')
  return t
}

/**
 * Backend capability ban (GAP 2's third HIGH): tokens asserting a personalization capability the
 * listing does not have. When customizable=true the set is empty — :8088's prompt clause already
 * ENCOURAGES these terms for genuinely Amazon-Custom listings, and the fill's fact tokens add them.
 */
export function capabilityBanTokens(customizable: boolean): string[] {
  if (customizable) return []
  return ['custom', 'customs', 'customize', 'customized', 'customizable', 'personalize', 'personalized', 'monogram', 'monogrammed', 'photo']
}

/**
 * PERFORMANCE-FABRIC capability claims (PO 2026-08-21, B0DMXMH266 "Sun Protection" on a Gildan 64000):
 * a phrase asserting a fabric capability NO blank in the catalog states. Kept as a sibling of
 * `capabilityBanTokens` rather than merged into it: that list is the PERSONALIZATION ban keyed on
 * `customizable` and consumed token-exact by the backend strip — folding fabric claims into it would
 * silently change backend behaviour. BlankSpec carries no capability field today, so a consumer
 * (the Item Highlights truth stage) rejects every match unconditionally; the day a blank states
 * one, the exemption belongs HERE beside the spec, not in a prompt.
 */
export const PERFORMANCE_CLAIM_RE = /\b(?:sun[\s-]?protect(?:ion|ive)|upf|spf|moisture[\s-]?wicking|quick[\s-]?dry(?:ing)?|water[\s-]?proof|water[\s-]?resistant|water[\s-]?repellent|thermal|insulated|breathable\s+mesh|anti[\s-]?microbial|odou?r[\s-]?resistant|compression)\b/i

/** Strip capability-claim tokens from a backend string BEFORE the budget fill re-pads it, so a
 *  non-customizable listing's backend never carries the claim and the fill replaces the freed
 *  bytes with pool keywords. Token-exact, whitespace-normalized, idempotent. */
export function stripCapabilityClaims(backend: string, customizable: boolean): string {
  if (!backend || customizable) return backend
  const ban = new Set(capabilityBanTokens(false))
  return backend.split(/\s+/).filter((tok) => !ban.has(tok.toLowerCase().replace(/[^a-z0-9']/g, ''))).join(' ')
}
