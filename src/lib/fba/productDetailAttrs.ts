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
  'country of origin':              { spApiKey: 'country_of_origin',          scope: 'broadcast' },
  'theme':                          { spApiKey: 'theme',                      scope: 'broadcast' },
  'special feature':                { spApiKey: 'special_feature',            scope: 'broadcast' },
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

/** Amazon shipped the Item Highlights ATTRIBUTE (`title_differentiation`) ahead of its July 27,
 *  2026 launch: it's in the product-type schema and the Seller Central form, but the Listings
 *  Items API still REFUSES writes — "This attribute 'Item Highlight' is currently unsupported"
 *  (live-verified 0/10 on B0F86LPSHZ, 2026-06-11). Until the launch date an empty Item Highlight
 *  must NOT count as a Features gap: the seller cannot close it (the unfillable-gap trust trap).
 *  From launch day it counts — and pushes — like any other field, with no code change. */
export function isWriteBlockedPreLaunch(fieldName: string | null | undefined, spApiKey: string | null | undefined, now = new Date()): boolean {
  if (now >= new Date('2026-07-27T00:00:00Z')) return false
  const squash = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, '')
  const f = squash(String(fieldName ?? ''))
  return spApiKey === 'title_differentiation' || f === 'itemhighlight' || f === 'itemhighlights' || f === 'titledifferentiation'
}

/**
 * Read the listing's CURRENT value for an attribute key from the cached attributes blob.
 * Listings Items returns attributes as `Record<string, Array<{value, ...}>>`. We pull the
 * first entry's `value` and stringify it.
 */
export function currentDetailValue(
  attributes: Record<string, unknown> | null | undefined,
  spApiKey: string,
): string {
  const arr = attributes?.[spApiKey]
  if (!Array.isArray(arr) || arr.length === 0) return ''
  const first = arr[0] as { value?: unknown }
  const v = first?.value
  if (v == null) return ''
  return String(v).trim()
}
