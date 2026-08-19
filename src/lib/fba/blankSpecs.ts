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

export interface BlankSpecRow { match: RegExp; spec: BlankSpec }

/** The seed rows — byte-identical to the historical hardcoded table (and to migration 053's
 *  seeds). These are the fail-open floor, never an alternate behavior path. */
export const DEFAULT_BLANK_SPECS: BlankSpecRow[] = [
  { match: /\bcomfort\s*colors?\b/i, spec: { brand: 'Comfort Colors', fit: 'Relaxed', sleeve: 'Short Sleeve', neck: 'Crew Neck', weightNote: 'midweight 6.1 oz garment-dyed', material: '100% Ring-Spun Cotton', dye: 'Garment-Dyed', stretch: 'Low Stretch', fitToSize: 'Runs Slightly Small' } },
  { match: /\bgildan\b|\b64000/i, spec: { brand: 'Gildan', brandInCopy: false, fit: 'Classic', sleeve: 'Short Sleeve', neck: 'Crew Neck', weightNote: 'lightweight 4.5 oz ring-spun', material: 'Ring-Spun Cotton' } },
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
  return { match, spec }
}

const CACHE_TTL_MS = 5 * 60 * 1000
/** A HANG is worse than an error here: an unreachable-but-not-erroring DB (CI proved the class —
 *  the select hung >5s with real env vars but no egress) would stall every regen at the blank
 *  lookup. The race turns a hang into the same fail-open the error path takes. */
const LOAD_TIMEOUT_MS = 4000
let cache: { rows: BlankSpecRow[]; at: number } | null = null

/** Load the catalog (5-min cache; ONE cheap read per window). Fail-open to the seeds. */
export async function loadBlankSpecRows(timeoutMs: number = LOAD_TIMEOUT_MS): Promise<BlankSpecRow[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.rows
  try {
    // .order('id') is LOAD-BEARING: matchBlankSpec is first-match-wins, and Postgres row order is
    // unspecified without it — a PO-added row must never nondeterministically shadow a seed.
    const query = supabase.from('blank_specs').select('*').eq('active', true).order('id', { ascending: true })
    const { data, error } = await Promise.race([
      query,
      new Promise<never>((_, reject) => {
        const t = setTimeout(() => reject(new Error(`blank_specs load timed out after ${timeoutMs}ms`)), timeoutMs)
        ;(t as unknown as { unref?: () => void }).unref?.()
      }),
    ])
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

/** Row-returning lookup (first matching row wins, over the joined hay of every non-empty source).
 *  Callers that need the match REGEX as well as the spec (the blank-brand IH net below) use this;
 *  `matchBlankSpec` stays the spec-only convenience every existing consumer already calls. */
export function matchBlankSpecRow(rows: BlankSpecRow[], ...sources: (string | null | undefined)[]): BlankSpecRow | null {
  const hay = sources.filter(Boolean).join(' ')
  for (const b of rows) if (b.match.test(hay)) return b
  return null
}

/** The lookup — identical semantics to the historical lookupBlankSpec (first matching row wins,
 *  over the joined hay of every non-empty source). */
export function matchBlankSpec(rows: BlankSpecRow[], ...sources: (string | null | undefined)[]): BlankSpec | null {
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
 */
export async function resolveBlankRowForNet(
  // Any supabase-js client (routes construct their own); the minimal surface we call.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  opts: { parentAsin?: string | null; childAsin?: string | null; titles: (string | null | undefined)[] },
): Promise<BlankSpecRow | null> {
  try {
    let rows: { sku?: string; product_type?: string; title?: string }[] = []
    if (opts.parentAsin) {
      const { data } = await db.from('listing_content').select('sku, product_type, title').eq('parent_asin', opts.parentAsin).limit(50)
      if (Array.isArray(data)) rows = data
    }
    if (rows.length === 0 && opts.childAsin) {
      const { data } = await db.from('listing_content').select('sku, product_type, title').eq('asin', opts.childAsin).limit(50)
      if (Array.isArray(data)) rows = data
    }
    const liveTitle = rows.find((r) => (r.title ?? '').trim())?.title ?? ''
    const productType = rows.find((r) => (r.product_type ?? '').trim())?.product_type ?? ''
    const skuHay = rows.map((r) => r.sku).filter(Boolean).join(' ')
    // Same looksShirt gate as the pipeline (listingPipeline garmentHay rule): hoodies/sweatshirts
    // never inherit a shirt blank's brand.
    const garmentHay = [...opts.titles, liveTitle, productType].filter(Boolean).join(' ')
    const looksShirt = /\bt?[\s-]?shirts?\b|\btees?\b/i.test(garmentHay) && !/sweat|hoodie|fleece|pullover/i.test(garmentHay)
    if (!looksShirt) return null
    return matchBlankSpecRow(await loadBlankSpecRows(), ...opts.titles, liveTitle, productType, skuHay)
  } catch (e) {
    console.warn('[blankSpecs] blank-row net resolution failed (net no-ops):', e instanceof Error ? e.message : e)
    return null
  }
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

/** Strip capability-claim tokens from a backend string BEFORE the budget fill re-pads it, so a
 *  non-customizable listing's backend never carries the claim and the fill replaces the freed
 *  bytes with pool keywords. Token-exact, whitespace-normalized, idempotent. */
export function stripCapabilityClaims(backend: string, customizable: boolean): string {
  if (!backend || customizable) return backend
  const ban = new Set(capabilityBanTokens(false))
  return backend.split(/\s+/).filter((tok) => !ban.has(tok.toLowerCase().replace(/[^a-z0-9']/g, ''))).join(' ')
}
