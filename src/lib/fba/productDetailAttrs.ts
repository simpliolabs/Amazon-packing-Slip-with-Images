/**
 * Product-detail attributes — friendly-name → SP-API attribute mapping.
 * ─────────────────────────────────────────────────────────────────────────────
 * The audit agent emits `product_details_improvements: [{ field_name, recommended_value }, …]`
 * with friendly display names like "Material", "Fit Type", "Brand". To push those values
 * to Amazon via patchListingsItem we need (1) the actual SP-API attribute key
 * (`material`, `fit_type`, `brand`) and (2) the correct value shape (most modern
 * productType schemas accept `{value, marketplace_id, language_tag}` uniformly — we
 * use that shape for everything in v1 and let VALIDATION_PREVIEW reject anything
 * the schema disagrees with).
 *
 * v1 scope: ONLY broadcast-safe attributes. Per-variant attributes (color, size,
 * flash_memory_storage_capacity) appear in the map so the UI can identify them and
 * show a "set per-variant in Seller Central" tooltip instead of a Push button —
 * pushing the parent-level single value to every child would overwrite each
 * variant's distinct color/capacity, which is destructive.
 *
 * Unmapped friendly names fall back to copy-only in the UI (the seller pastes
 * the value manually in Seller Central). Over time we extend the map.
 */

import type { PatchValueEntry } from '@/lib/fba/pushFields'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * LLM/schema-sourced detail values are NOT guaranteed to be strings: the audit model can
 * emit arrays (Additional Features: ["Water Proof","Shock Proof","Temperature Proof"] —
 * the exact row that hard-crashed the B0GCF11RKL listing page) or bare numbers (capacity
 * specs). Every consumer downstream (.trim(), byte caps, PATCH bodies) assumes string, so
 * normalize at EVERY boundary with this: pipeline write, recommendations GET, push read.
 */
export function detailValueToString(v: unknown): string {
  if (v == null) return ''
  if (typeof v === 'string') return v
  if (Array.isArray(v)) return v.map((x) => detailValueToString(x)).filter(Boolean).join(', ')
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (typeof v === 'object') {
    // {value, unit} shapes from spec-style audits; anything else degrades to JSON.
    const o = v as Record<string, unknown>
    if (typeof o.value === 'string' || typeof o.value === 'number') {
      return `${o.value}${typeof o.unit === 'string' && o.unit ? ` ${o.unit}` : ''}`
    }
    try { return JSON.stringify(v) } catch { return '' }
  }
  return String(v)
}

export type DetailScope = 'broadcast' | 'per-variant'

export interface DetailAttribute {
  /** SP-API attribute key under /attributes/<key>. */
  spApiKey: string
  /** broadcast = same value to all SKUs (Material/Brand/Fit Type).
   *  per-variant = each child has its own value (Color/Size/Capacity) — NOT pushable from
   *  the parent-level recommendation. The UI shows these but disables Push. */
  scope: DetailScope
  /** Optional enum normalization: lowercase friendly value → SP-API enum key. */
  enumMap?: Record<string, string>
}

/**
 * Friendly name (case-insensitive, normalized) → SP-API attribute config.
 *
 * Names are stored normalized: lowercased, single-spaced, dashes/underscores → spaces.
 * Lookups go through `normalizeFieldName()` so "fit type", "FIT_TYPE", "Fit-Type" all
 * resolve to the same entry.
 */
const ATTR_MAP: Record<string, DetailAttribute> = {
  // ─── APPAREL (broadcast-safe — parent-shared) ───
  'material':                       { spApiKey: 'material',                   scope: 'broadcast' },
  'material type':                  { spApiKey: 'material',                   scope: 'broadcast' },
  'fabric type':                    { spApiKey: 'fabric_type',                scope: 'broadcast' },
  'material composition':           { spApiKey: 'material_composition',       scope: 'broadcast' },
  'fit type':                       { spApiKey: 'fit_type',                   scope: 'broadcast' },
  'style':                          { spApiKey: 'style',                      scope: 'broadcast' },
  'style name':                     { spApiKey: 'style_name',                 scope: 'broadcast' },
  'pattern':                        { spApiKey: 'pattern',                    scope: 'broadcast' },
  'closure type':                   { spApiKey: 'closure_type',               scope: 'broadcast' },
  'sleeve type':                    { spApiKey: 'sleeve_type',                scope: 'broadcast' },
  'neck style':                     { spApiKey: 'neck_style',                 scope: 'broadcast' },
  'shirt form type':                { spApiKey: 'shirt_form_type',            scope: 'broadcast' },
  'care instructions':              { spApiKey: 'care_instructions',          scope: 'broadcast' },
  'department':                     { spApiKey: 'department',                 scope: 'broadcast' },
  'target gender':                  { spApiKey: 'target_gender',              scope: 'broadcast' },
  'age range':                      { spApiKey: 'age_range_description',      scope: 'broadcast' },
  'age range description':          { spApiKey: 'age_range_description',      scope: 'broadcast' },
  'occasion':                       { spApiKey: 'occasion',                   scope: 'broadcast' },
  'item shape':                     { spApiKey: 'item_shape',                 scope: 'broadcast' },

  // ─── GENERAL (broadcast-safe — parent-shared) ───
  'brand':                          { spApiKey: 'brand',                      scope: 'broadcast' },
  'manufacturer':                   { spApiKey: 'manufacturer',               scope: 'broadcast' },
  'model name':                     { spApiKey: 'model_name',                 scope: 'broadcast' },
  'country of origin':              { spApiKey: 'country_of_origin',          scope: 'broadcast' },
  'theme':                          { spApiKey: 'theme',                      scope: 'broadcast' },
  'animal theme':                   { spApiKey: 'theme',                      scope: 'broadcast' },
  'special feature':                { spApiKey: 'special_feature',            scope: 'broadcast' },
  'special features':               { spApiKey: 'special_feature',            scope: 'broadcast' },
  'included components':            { spApiKey: 'included_components',        scope: 'broadcast' },
  'number of items':                { spApiKey: 'number_of_items',            scope: 'broadcast' },

  // ─── ELECTRONICS / SD CARDS / MEMORY (broadcast-safe) ───
  'hardware interface':             { spApiKey: 'hardware_interface',         scope: 'broadcast' },
  'hardware platform':              { spApiKey: 'hardware_platform',          scope: 'broadcast' },
  'connectivity technology':        { spApiKey: 'connectivity_technology',    scope: 'broadcast' },
  'compatible devices':             { spApiKey: 'compatible_devices',         scope: 'broadcast' },
  'memory type':                    { spApiKey: 'memory_storage_type',        scope: 'broadcast' },
  'flash memory type':              { spApiKey: 'flash_memory_type',          scope: 'broadcast' },
  'memory speed class':             { spApiKey: 'memory_speed_class',         scope: 'broadcast' },

  // ─── PER-VARIANT (shown disabled — pushing a single value here would overwrite
  //                  every variant's distinct value with the parent's recommendation) ───
  'color':                          { spApiKey: 'color',                              scope: 'per-variant' },
  'colour':                         { spApiKey: 'color',                              scope: 'per-variant' },
  'size':                           { spApiKey: 'size',                               scope: 'per-variant' },
  'capacity':                       { spApiKey: 'flash_memory_storage_capacity',      scope: 'per-variant' },
  'storage capacity':               { spApiKey: 'flash_memory_storage_capacity',      scope: 'per-variant' },
  'flash memory storage capacity':  { spApiKey: 'flash_memory_storage_capacity',      scope: 'per-variant' },
  'memory storage capacity':        { spApiKey: 'memory_storage_capacity',            scope: 'per-variant' },
  'read speed':                     { spApiKey: 'read_speed_megabytes_per_second',    scope: 'per-variant' },
  'write speed':                    { spApiKey: 'write_speed_megabytes_per_second',   scope: 'per-variant' },
  'item dimensions':                { spApiKey: 'item_dimensions',                    scope: 'per-variant' },
  'item weight':                    { spApiKey: 'item_weight',                        scope: 'per-variant' },
}

/** Normalize a friendly name: lowercased, single-spaced, dashes/underscores → spaces. */
export function normalizeFieldName(name: string): string {
  return (name || '').toLowerCase().trim().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ')
}

/** Resolve a friendly name (case-insensitive) to its SP-API attribute config. */
export function resolveDetailAttribute(fieldName: string): DetailAttribute | null {
  return ATTR_MAP[normalizeFieldName(fieldName)] ?? null
}

/** True when this friendly-name is broadcast-pushable in v1 (parent-shared attribute). */
export function isPushableDetail(fieldName: string): boolean {
  const a = resolveDetailAttribute(fieldName)
  return !!a && a.scope === 'broadcast'
}

/** Reason a friendly name is NOT pushable, for surfacing to the seller. null = pushable. */
export function unpushableReason(fieldName: string): string | null {
  const a = resolveDetailAttribute(fieldName)
  if (!a) return 'This attribute isn’t mapped to an SP-API field yet. Copy the value and paste it in Seller Central.'
  if (a.scope === 'per-variant') {
    return 'This is a per-variant attribute — each child SKU has its own value (e.g. Color/Size/Capacity). Set it on each variant in Seller Central.'
  }
  return null
}

/**
 * Build the SP-API patch value array for a detail attribute.
 *
 * v1: every detail uses `{value, marketplace_id, language_tag}`. Modern productType
 * schemas accept that shape uniformly; the few that don't (older brand/manufacturer
 * schemas in some categories) will surface a clear VALIDATION_PREVIEW error which the
 * UI shows the seller. Cheap and robust without a per-attribute shape table.
 */
export function buildDetailPatchValue(
  attr: DetailAttribute,
  rawValue: string,
  marketplaceId: string,
  languageTag = 'en_US',
): PatchValueEntry[] {
  const trimmed = (rawValue || '').trim()
  if (!trimmed) return []
  const normalized = attr.enumMap ? (attr.enumMap[trimmed.toLowerCase()] ?? trimmed) : trimmed
  return [{ value: normalized, marketplace_id: marketplaceId, language_tag: languageTag }]
}

/** True when (fieldName, spApiKey) names Amazon's Item Highlights attribute
 *  (schema key `title_differentiation`, docs key `item_highlights`, display "Item Highlight(s)").
 *  Single source of truth — server gate, client Auto-Push filter, and both push hooks all call this. */
export function isItemHighlightsField(
  fieldName: string | null | undefined,
  spApiKey: string | null | undefined,
): boolean {
  if (spApiKey === 'title_differentiation' || spApiKey === 'item_highlights') return true
  const f = (fieldName ?? '').toLowerCase().replace(/[\s_-]+/g, '')
  return f === 'itemhighlight' || f === 'itemhighlights' || f === 'titledifferentiation'
}

export const ITEM_HIGHLIGHTS_STATE_KEY = 'item_highlights_api_state'

/** Persisted probe result. `supported` is the marketplace-wide verdict; `probed_at` throttles refresh. */
export interface ItemHighlightsApiState { supported: boolean; probed_at: string } // probed_at = ISO

/** READ — mirrors the single-key app_settings pattern (familyReconcile.ts / getSellerId).
 *  Returns null when never probed OR on any parse/read failure (→ date fallback). Never throws. */
export async function getItemHighlightsApiState(
  db: SupabaseClient,
): Promise<ItemHighlightsApiState | null> {
  try {
    const { data } = await db
      .from('app_settings').select('value')
      .eq('key', ITEM_HIGHLIGHTS_STATE_KEY).maybeSingle()
    const raw = (data as { value?: string } | null)?.value
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return typeof parsed?.supported === 'boolean'
      ? { supported: parsed.supported, probed_at: parsed.probed_at ?? new Date().toISOString() }
      : null
  } catch { return null }
}

/** WRITE — mirrors the settings/route.ts app_settings upsert with explicit onConflict. Best-effort.
 *  `value` is a plain string column (types/database.ts) — hence JSON.stringify / JSON.parse. */
export async function setItemHighlightsApiState(
  db: SupabaseClient,
  supported: boolean,
): Promise<void> {
  const now = new Date().toISOString()
  try {
    await db.from('app_settings').upsert(
      { key: ITEM_HIGHLIGHTS_STATE_KEY, value: JSON.stringify({ supported, probed_at: now }), updated_at: now },
      { onConflict: 'key' },
    )
  } catch (e) {
    console.warn('[item-highlights] state write failed (non-fatal):', e instanceof Error ? e.message : e)
  }
}

/** Amazon shipped the Item Highlights ATTRIBUTE (`title_differentiation`) ahead of its July 27,
 *  2026 launch: it's in the product-type schema and the Seller Central form, but the Listings
 *  Items API still REFUSES writes — "This attribute 'Item Highlight' is currently unsupported"
 *  (live-verified 0/10 on B0F86LPSHZ, 2026-06-11). Until Amazon opens writes an empty Item Highlight
 *  must NOT count as a Features gap: the seller cannot close it (the unfillable-gap trust trap).
 *
 *  `apiSupported` (the persisted VALIDATION_PREVIEW probe verdict) replaces the hardcoded date as the
 *  primary driver; the July-27 date remains ONLY as the never-probed fallback:
 *    true  → Amazon accepts writes → NEVER block (even before July 27).
 *    false → "currently unsupported" → BLOCK (even after July 27).
 *    null / undefined → never probed → fall back to the July-27-2026 launch date.
 *  Guard-order note: the field match runs FIRST so the probe flag can override the date in BOTH
 *  directions (the old date-first early-return could not). Stays PURE + synchronous — the async DB
 *  read is hoisted once per request into each caller and threaded in via `opts.apiSupported`. */
export function isWriteBlockedPreLaunch(
  fieldName: string | null | undefined,
  spApiKey: string | null | undefined,
  now = new Date(),
  opts?: { apiSupported?: boolean | null },
): boolean {
  if (!isItemHighlightsField(fieldName, spApiKey)) return false
  const flag = opts?.apiSupported
  if (flag === true) return false          // probe says writable → never block
  if (flag === false) return true          // probe says unsupported → block regardless of date
  return now < new Date('2026-07-27T00:00:00Z')   // never probed → legacy date fallback
}

/**
 * Read the listing's CURRENT value for an attribute key from the cached attributes blob.
 * Listings Items returns attributes as `Record<string, Array<{value, ...}>>`. We pull the
 * first entry's `value` and stringify it.
 *
 * COMPOSITE attributes (SHIRT `neck`/`closure`/`sleeve`) carry no top-level `value` —
 * the data sits on a sub-field: neck: [{ neck_style: {value: "Crew Neck"}, … }]. Without
 * the deep fallback every read of a composite returned '' forever (verify showed 0/89
 * even for genuinely-applied values, and the diff's `current` column stayed blank).
 * Fallback order: first `value`-keyed primitive anywhere in the entry, else the first
 * primitive leaf that isn't marketplace/language/unit plumbing.
 */
export function currentDetailValue(
  attributes: Record<string, unknown> | null | undefined,
  spApiKey: string,
): string {
  const arr = attributes?.[spApiKey]
  if (!Array.isArray(arr) || arr.length === 0) return ''
  const first = arr[0] as { value?: unknown }
  const v = first?.value
  if (v != null) return String(v).trim()

  const SKIP = new Set(['marketplace_id', 'language_tag', 'unit'])
  let valueLeaf: string | null = null
  let anyLeaf: string | null = null
  const walk = (n: unknown, key: string, depth: number): void => {
    if (valueLeaf || n == null || depth > 6 || SKIP.has(key)) return
    if (typeof n === 'string' || typeof n === 'number' || typeof n === 'boolean') {
      const s = String(n).trim()
      if (!s) return
      if (key === 'value') valueLeaf = s
      else if (anyLeaf == null) anyLeaf = s
      return
    }
    if (Array.isArray(n)) { for (const item of n) walk(item, key, depth + 1); return }
    if (typeof n === 'object') { for (const [k, sub] of Object.entries(n as Record<string, unknown>)) walk(sub, k, depth + 1) }
  }
  walk(first, '', 0)
  return (valueLeaf ?? anyLeaf ?? '').trim()
}
