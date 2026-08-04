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
  active?: boolean | null
}

/** DB row → BlankSpecRow. Null columns become ABSENT fields (undefined) so every existing
 *  `spec.field ? …` consumer behaves identically to the hardcoded rows. brand_in_copy defaults
 *  true in the DB; only an explicit false materializes (the CC row historically OMITS the field). */
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

/** The lookup — identical semantics to the historical lookupBlankSpec (first matching row wins,
 *  over the joined hay of every non-empty source). */
export function matchBlankSpec(rows: BlankSpecRow[], ...sources: (string | null | undefined)[]): BlankSpec | null {
  const hay = sources.filter(Boolean).join(' ')
  for (const b of rows) if (b.match.test(hay)) return b.spec
  return null
}
