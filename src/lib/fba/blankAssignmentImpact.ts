/**
 * blankAssignmentImpact.ts — validation + resolution-preview helpers OWNED by the Blanks-in-Settings
 * feature (PO 2026-08-22, handoff/BLANKS_IN_PORTAL_DESIGN.md §5/§6, decisions A–D). Deliberately kept
 * SEPARATE from src/lib/fba/blankSpecs.ts, which a CONCURRENT agent owns while shipping migration
 * 062 (creates `blank_assignments`) and the live pipeline resolver that reads it. This module never
 * edits that file — it only IMPORTS its already-exported, already-tested primitives
 * (`extractStyleCode`, `matchBlankSpecRow`, `rowToSpec`) so the code-extraction / regex-matching
 * logic is never duplicated. One seam for matching; this file owns only the ORCHESTRATION the portal
 * UI needs on top of it.
 *
 * WHAT THIS FILE DOES that blankSpecs.ts does not (and, being a preview, never will): simulate
 * resolution for a PROSPECTIVE (unsaved) blank edit — "if I save this style_code/match_pattern,
 * which families would newly resolve here?" — the blast-radius preview design doc §5.3 requires
 * BEFORE every save that can change resolution. It also layers `blank_assignments` (scope
 * 'family'|'child') on top of the SKU/legacy precedence the production resolver already proves out,
 * using the SAME "most children win, catalog-id tiebreak" dominance rule as resolveFamilyBlank
 * (058) — reimplemented here (not imported) ONLY for the aggregation/precedence glue, because
 * resolveFamilyBlank does not yet accept a per-child assignment override (that lands in the other
 * agent's migration 062 work). The regex/extraction primitives themselves are always the imported
 * ones — never re-derived.
 */
import { extractStyleCode, matchBlankSpecRow, rowToSpec, type BlankSpecRow, type GarmentFamily } from '@/lib/fba/blankSpecs'

// ─── Validation (routes: POST/PATCH /api/fba/blanks) ────────────────────────────────────────────

export const GARMENT_FAMILY_VALUES: readonly GarmentFamily[] = ['tee', 'long_sleeve_tee', 'sweatshirt', 'hoodie', 'kids_tee']

// blank_specs.age_class (migration 071) — ORTHOGONAL to garment_family (any silhouette may pair
// with any age). Unlike garment_family, this is OPTIONAL (NULL = "not stated") and has no default;
// see validateBlankSpecInput below — never required on create, and 'adult' is a normal member here,
// never a fallback the UI/route synthesizes on its own.
export const AGE_CLASS_VALUES: readonly ['newborn', 'infant', 'toddler', 'kids', 'adult'] = ['newborn', 'infant', 'toddler', 'kids', 'adult']

export interface BlankSpecInput {
  style_code?: string | null
  match_pattern?: string | null
  garment_family?: string | null
  age_class?: string | null
  brand?: string | null
  brand_in_copy?: unknown
  fit?: string | null
  sleeve?: string | null
  neck?: string | null
  weight_note?: string | null
  material?: string | null
  dye?: string | null
  stretch?: string | null
  fit_to_size?: string | null
  unisex?: unknown
  active?: unknown
  notes?: string | null
}

/** One field error. The route returns the FIRST one's message as the top-level `error` string
 *  (matching the single-error-string convention of design-name-override / competitor-asin) plus the
 *  full list as `errors` for a form that wants to flag every bad field at once. */
export interface FieldError { field: string; message: string }

const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k)

/**
 * Validates a create/update payload. mode:'create' requires style_code + match_pattern + a valid
 * garment_family (the facts a brand-new row must state — match_pattern is NOT NULL in the DB
 * schema, migration 053). mode:'update' validates only the fields PRESENT in the patch, so a PATCH
 * that only sends {id, active:false} (deactivate) never trips the "required" checks.
 */
export function validateBlankSpecInput(input: BlankSpecInput, mode: 'create' | 'update'): FieldError[] {
  const errors: FieldError[] = []

  if (mode === 'create' || has(input, 'style_code')) {
    const v = (input.style_code ?? '').trim()
    if (!v) errors.push({ field: 'style_code', message: 'style_code is required and cannot be blank' })
  }

  if (mode === 'create' || has(input, 'match_pattern')) {
    const v = (input.match_pattern ?? '').trim()
    if (!v) {
      errors.push({ field: 'match_pattern', message: 'match_pattern is required and cannot be blank' })
    } else {
      try {
        new RegExp(v, 'i')
      } catch (e) {
        errors.push({ field: 'match_pattern', message: e instanceof Error ? e.message : 'Invalid regular expression' })
      }
    }
  }

  if (mode === 'create' || has(input, 'garment_family')) {
    const v = input.garment_family
    if (!v || !(GARMENT_FAMILY_VALUES as readonly string[]).includes(v)) {
      errors.push({ field: 'garment_family', message: `garment_family must be one of: ${GARMENT_FAMILY_VALUES.join(', ')}` })
    }
  }

  // age_class (071) — OPTIONAL, unlike garment_family: NULL/absent = "not stated", the legal
  // default for ~600 unstated families, so this is validated ONLY when the field is PRESENT in
  // the payload — never required on create, and never rejected merely for being absent.
  if (has(input, 'age_class')) {
    const v = input.age_class
    if (v !== null && v !== undefined && v !== '' && !(AGE_CLASS_VALUES as readonly string[]).includes(v)) {
      errors.push({ field: 'age_class', message: `age_class must be blank or one of: ${AGE_CLASS_VALUES.join(', ')}` })
    }
  }

  for (const [field, val] of [['brand_in_copy', input.brand_in_copy], ['unisex', input.unisex], ['active', input.active]] as const) {
    if (has(input, field) && val !== null && val !== undefined && typeof val !== 'boolean') {
      errors.push({ field, message: `${field} must be a boolean` })
    }
  }

  return errors
}

/** True duplicate check: style_code must be unique among ACTIVE rows only — a deactivated row never
 *  blocks reuse of its old code (the whole point of "deactivate, never delete"). Returns the
 *  colliding row's id, or null. */
export function findDuplicateActiveStyleCode(
  existing: readonly { id: number; style_code: string | null; active: boolean }[],
  candidateStyleCode: string,
  excludeId?: number | null,
): number | null {
  const norm = candidateStyleCode.trim().toUpperCase()
  if (!norm) return null
  const hit = existing.find((r) => r.active && r.id !== excludeId && (r.style_code ?? '').trim().toUpperCase() === norm)
  return hit ? hit.id : null
}

/** Does this style_code exist among the given (normally: active) catalog codes? Case/whitespace
 *  insensitive — used to reject a blank-assignment PUT that names an unknown blank. */
export function styleCodeExists(catalogStyleCodes: readonly string[], candidate: string): boolean {
  const norm = candidate.trim().toUpperCase()
  if (!norm) return false
  return catalogStyleCodes.some((c) => c.trim().toUpperCase() === norm)
}

// ─── Resolution simulation (GET /api/fba/blanks usage counts, POST /api/fba/blanks/impact,
//      GET /api/fba/blank-assignment) ────────────────────────────────────────────────────────────

export type ResolutionSource = 'child-assignment' | 'sku-code' | 'family-assignment' | 'legacy' | null

/** The raw blank_specs DB row shape this module reads (mirrors DbRow in blankSpecs.ts, + id/active —
 *  duplicated rather than imported because blankSpecs.ts does not export a row shape with `id`). */
export interface DbBlankRow {
  id: number
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
  style_code?: string | null
  garment_family?: string | null
  age_class?: string | null
  active?: boolean | null
}

/** BlankSpecRow + the two fields this module needs that the shared type doesn't carry. */
export interface CatalogRow extends BlankSpecRow {
  id: number
  active: boolean
}

/** DB rows (any active state) → CatalogRow[], in the SAME order given (callers MUST supply rows
 *  ordered by id ascending — the load-bearing order blankSpecs.ts's own reader uses, so dominance
 *  tiebreaks agree with the live resolver). Rows whose match_pattern fails to compile are skipped
 *  (rowToSpec already warns + returns null for those — identical skip-not-crash behavior to the
 *  live reader). */
export function toCatalogRows(rows: readonly DbBlankRow[]): CatalogRow[] {
  const out: CatalogRow[] = []
  for (const r of rows) {
    const spec = rowToSpec(r)
    if (!spec) continue
    out.push({ ...spec, id: r.id, active: r.active !== false })
  }
  return out
}

export interface FamilyGroup { parentAsin: string; skus: string[]; hay: string }

/** Group raw listing_content rows into per-family fixtures. `hay` folds title AND every SKU
 *  together (mirrors resolveFamilyBlankForNet's title+skuHay join in blankSpecs.ts) so the legacy
 *  match_pattern fallback sees the same haystack the live resolver does. */
export function groupFamilies(rows: readonly { parent_asin?: string | null; sku?: string | null; title?: string | null }[]): Map<string, FamilyGroup> {
  const out = new Map<string, FamilyGroup>()
  for (const r of rows) {
    const asin = (r.parent_asin ?? '').trim().toUpperCase()
    if (!asin) continue
    let g = out.get(asin)
    if (!g) { g = { parentAsin: asin, skus: [], hay: '' }; out.set(asin, g) }
    if (r.sku) g.skus.push(r.sku)
    if (r.title && !g.hay.includes(r.title)) g.hay = g.hay ? `${g.hay} ${r.title}` : r.title
  }
  for (const g of out.values()) g.hay = [g.hay, ...g.skus].filter(Boolean).join(' ')
  return out
}

export interface AssignmentRow { scope: 'family' | 'child'; key: string; style_code: string }

export function buildAssignmentMaps(rows: readonly AssignmentRow[]): { childCodeBySku: Map<string, string>; familyCodeByAsin: Map<string, string> } {
  const childCodeBySku = new Map<string, string>()
  const familyCodeByAsin = new Map<string, string>()
  for (const r of rows) {
    const key = (r.key ?? '').trim().toUpperCase()
    const code = (r.style_code ?? '').trim().toUpperCase()
    if (!key || !code) continue
    if (r.scope === 'child') childCodeBySku.set(key, code)
    else if (r.scope === 'family') familyCodeByAsin.set(key, code)
  }
  return { childCodeBySku, familyCodeByAsin }
}

interface ChildResolution { sku: string; styleCode: string | null; source: 'child-assignment' | 'sku-code' | null }

function resolveChildren(skus: readonly string[], catalogCodes: readonly string[], childCodeBySku: ReadonlyMap<string, string>): ChildResolution[] {
  return skus.map((sku) => {
    const assigned = childCodeBySku.get(sku.trim().toUpperCase())
    if (assigned) return { sku, styleCode: assigned, source: 'child-assignment' }
    const code = extractStyleCode(sku, catalogCodes)
    return { sku, styleCode: code, source: code ? 'sku-code' : null }
  })
}

export interface FamilyResolution { styleCode: string | null; source: ResolutionSource; rowId: number | null }

/**
 * ONE family's resolved blank under a given (possibly hypothetical) catalog. Precedence — PO
 * 2026-08-22 design doc §5.2: child assignment → child SKU style code → family assignment → legacy
 * regex → unresolved. SKU/assignment dominance uses the count-desc / catalog-id-tiebreak rule
 * resolveFamilyBlank (058) already proved live; the label leans 'child-assignment' when ANY
 * contributing child to the WINNING code came from an explicit assignment (an assignment is the more
 * deliberate signal than an incidentally-matching SKU token).
 *
 * `catalog` MUST be in id-ascending order (the caller's `.order('id')` — see toCatalogRows).
 */
export function resolveFamily(
  family: FamilyGroup,
  catalog: readonly CatalogRow[],
  childCodeBySku: ReadonlyMap<string, string>,
  familyCodeByAsin: ReadonlyMap<string, string>,
): FamilyResolution {
  const activeCatalog = catalog.filter((r) => r.active)
  const codeOrder = activeCatalog.map((r) => r.styleCode).filter((c): c is string => !!c)
  const rowByCode = new Map(activeCatalog.filter((r) => r.styleCode).map((r) => [r.styleCode as string, r] as const))

  const children = resolveChildren(family.skus, codeOrder, childCodeBySku)
  const withCode = children.filter((c): c is ChildResolution & { styleCode: string } => !!c.styleCode)

  if (withCode.length > 0) {
    const counts = new Map<string, number>()
    const anyAssignment = new Map<string, boolean>()
    for (const c of withCode) {
      counts.set(c.styleCode, (counts.get(c.styleCode) ?? 0) + 1)
      if (c.source === 'child-assignment') anyAssignment.set(c.styleCode, true)
    }
    const ranked = [...counts.entries()].sort((a, b) => (b[1] - a[1]) || (codeOrder.indexOf(a[0]) - codeOrder.indexOf(b[0])))
    const [winner] = ranked[0]
    const row = rowByCode.get(winner) ?? null
    return { styleCode: winner, source: anyAssignment.get(winner) ? 'child-assignment' : 'sku-code', rowId: row?.id ?? null }
  }

  const famCode = familyCodeByAsin.get(family.parentAsin)
  if (famCode) {
    const row = rowByCode.get(famCode) ?? null
    return { styleCode: famCode, source: 'family-assignment', rowId: row?.id ?? null }
  }

  const legacyRow = matchBlankSpecRow(activeCatalog, family.hay) as CatalogRow | null
  if (legacyRow) return { styleCode: legacyRow.styleCode ?? null, source: 'legacy', rowId: legacyRow.id }

  return { styleCode: null, source: null, rowId: null }
}

/** Map<rowId, count of families currently resolving to that row> — powers the "used by N families"
 *  column on GET /api/fba/blanks. */
export function computeUsageCounts(
  catalog: readonly CatalogRow[],
  families: ReadonlyMap<string, FamilyGroup>,
  assignments: readonly AssignmentRow[],
): Map<number, number> {
  const { childCodeBySku, familyCodeByAsin } = buildAssignmentMaps(assignments)
  const out = new Map<number, number>()
  for (const family of families.values()) {
    const res = resolveFamily(family, catalog, childCodeBySku, familyCodeByAsin)
    if (res.rowId != null) out.set(res.rowId, (out.get(res.rowId) ?? 0) + 1)
  }
  return out
}

export interface ImpactCandidate {
  id?: number | string | null
  styleCode?: string | null
  matchPattern?: string | null
}

export interface ImpactResult {
  resolvesTodayCount: number
  wouldResolveCount: number
  sampleAsins: string[]
}

/** Matches nothing — the placeholder pattern for a candidate that supplies no match_pattern (or an
 *  invalid one; callers should already have rejected an invalid regex before reaching this point,
 *  this is just a safe fallback so the preview never throws). */
const NEVER_MATCH = /(?!)/

/**
 * Blast-radius preview for a prospective save (design doc §5.3 modal, §6 step 4): given the row
 * being edited (`candidate.id`, or absent for a brand-new blank) and its PROSPECTIVE style_code /
 * match_pattern, compute how many families resolve to it TODAY (the catalog exactly as stored) vs.
 * WOULD resolve to it if saved (same catalog, with only THIS row's identity replaced by the
 * candidate's values — a new blank gets a synthetic extra row instead). `sampleAsins` lists the
 * DELTA — families that would newly start resolving here, capped at 10 — because that is the
 * actionable "who does this touch" list; a family already resolving here today is already counted
 * in resolvesTodayCount and is not new information for the confirm step.
 */
export function computeBlankImpact(
  rawCatalog: readonly DbBlankRow[],
  families: ReadonlyMap<string, FamilyGroup>,
  assignments: readonly AssignmentRow[],
  candidate: ImpactCandidate,
): ImpactResult {
  const catalog = toCatalogRows(rawCatalog)
  const { childCodeBySku, familyCodeByAsin } = buildAssignmentMaps(assignments)
  const candidateId = candidate.id === null || candidate.id === undefined || candidate.id === '' ? null : Number(candidate.id)

  const todayByAsin = new Map<string, FamilyResolution>()
  for (const family of families.values()) todayByAsin.set(family.parentAsin, resolveFamily(family, catalog, childCodeBySku, familyCodeByAsin))

  let resolvesTodayCount = 0
  if (candidateId != null) {
    for (const res of todayByAsin.values()) if (res.rowId === candidateId) resolvesTodayCount++
  }

  let candidateMatch: RegExp = NEVER_MATCH
  if (candidate.matchPattern && candidate.matchPattern.trim()) {
    try { candidateMatch = new RegExp(candidate.matchPattern, 'i') } catch { candidateMatch = NEVER_MATCH }
  }
  const candidateStyleCode = candidate.styleCode && candidate.styleCode.trim() ? candidate.styleCode.trim().toUpperCase() : null

  let wouldCatalog: CatalogRow[]
  let wouldId: number
  if (candidateId != null) {
    wouldId = candidateId
    wouldCatalog = catalog.map((r) => {
      if (r.id !== candidateId) return r
      const out: CatalogRow = { ...r, active: true }
      if (candidateStyleCode) out.styleCode = candidateStyleCode
      else delete out.styleCode
      if (candidate.matchPattern !== undefined && candidate.matchPattern !== null) out.match = candidateMatch
      return out
    })
  } else {
    wouldId = -1
    const synthetic: CatalogRow = { id: -1, active: true, match: candidateMatch, spec: {} }
    if (candidateStyleCode) synthetic.styleCode = candidateStyleCode
    wouldCatalog = [...catalog, synthetic]
  }

  let wouldResolveCount = 0
  const sampleAsins: string[] = []
  for (const family of families.values()) {
    const wouldRes = resolveFamily(family, wouldCatalog, childCodeBySku, familyCodeByAsin)
    if (wouldRes.rowId !== wouldId) continue
    wouldResolveCount++
    // "New today" for a brand-new blank (candidateId null) is EVERY match — there is no existing
    // row an unresolved family could already be counted against, so null-vs-null must not read as
    // "already resolving here" the way it correctly would for an existing row being edited.
    const todayRowId = todayByAsin.get(family.parentAsin)?.rowId ?? null
    const alreadyResolvedHere = candidateId != null && todayRowId === candidateId
    if (!alreadyResolvedHere && sampleAsins.length < 10) sampleAsins.push(family.parentAsin)
  }

  return { resolvesTodayCount, wouldResolveCount, sampleAsins }
}
