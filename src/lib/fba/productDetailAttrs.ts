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
  // Task #82 (keys live-probe-confirmed 2026-08-04, both FLAT with display-name enums). These
  // aliases are the FALLBACK layer only — regen rows carry schema-resolved sp_api_key; this keeps
  // verify-push and loadDetailContext working for legacy rows without stored metadata.
  'apparel fabric stretch':         { spApiKey: 'apparel_fabric_stretch',     scope: 'broadcast' },
  'fit to size sentiment':          { spApiKey: 'fit_to_size_sentiment',      scope: 'broadcast' },
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
 * SP-API attribute keys that describe the SPECIFIC design rather than a garment fact.
 * ───────────────────────────────────────────────────────────────────────────────────
 * `style` / `style_name` on a print-on-demand family read off the artwork ("Vintage",
 * "Funny", "Novelty"), so they legitimately DIFFER per design. They are `scope: 'broadcast'`
 * (correct for a single-design family — every child shares the one design), but broadcasting
 * one design's value across a MULTI-design family overwrites each design's distinct style —
 * the leak this gate exists to stop. Detection uses the resolved spApiKey so it catches BOTH
 * the static-map path and the schema-resolved (`pushable`/`sp_api_key`) path. Deliberately
 * conservative: on multi-design we suppress the push entirely rather than guess a shared value
 * (a future refinement could broadcast when all children already agree — see pushExecutor's
 * pickAgreedBroadcastValue). Single-design is untouched.
 */
const SINGLE_DESIGN_ONLY_KEYS = new Set(['style', 'style_name'])

/** True when this SP-API key describes the specific design (see SINGLE_DESIGN_ONLY_KEYS). */
export function isSingleDesignOnlyKey(spApiKey: string | null | undefined): boolean {
  return !!spApiKey && SINGLE_DESIGN_ONLY_KEYS.has(spApiKey)
}

/** True when this friendly name resolves to a single-design-only attribute (style / style name). */
export function isSingleDesignOnlyDetail(fieldName: string): boolean {
  return isSingleDesignOnlyKey(resolveDetailAttribute(fieldName)?.spApiKey)
}

/** Seller-facing reason a style attribute is suppressed on a multi-design family. */
export const SINGLE_DESIGN_ONLY_LEAK_REASON =
  'Style describes the specific design — on a multi-design family, pushing one value would overwrite every design’s distinct style. Set it per design in Seller Central.'

/**
 * Build the SP-API patch value array for a detail attribute.
 *
 * v1: every detail uses `{value, marketplace_id, language_tag}`. Modern productType
 * schemas accept that shape uniformly; the few that don't (older brand/manufacturer
 * schemas in some categories) will surface a clear VALIDATION_PREVIEW error which the
 * UI shows the seller. Cheap and robust without a per-attribute shape table.
 */
/**
 * Amazon's Item Highlight repeated-words rule: no non-trivial word may appear more than TWICE (a
 * "Comfort Colors" blank produced "…comfort colors tshirt, comfort colors tshirt…, comfort colors
 * t-shirts…" → "comfort"×4/"colors"×3 → Amazon rejected the SKU, and — because Amazon re-validates the
 * WHOLE item on any PATCH — it also blocked an unrelated TITLE push for that SKU). Enforce it
 * DETERMINISTICALLY at the push boundary so NO source (LLM draft, stale stored value, seller paste) can
 * ship a value Amazon rejects. Split into comma phrases; keep a phrase only while every one of its words
 * stays ≤2 (1-char tokens + trivial connectors exempt; plurals + "tshirt" folded so shirt/shirts/tshirt
 * count as one); drop the offending later phrase(s). Never blanks the field.
 */
const IH_TRIVIAL = new Set(['for', 'and', 'the', 'a', 'an', 'of', 'with', 'in', 'to', 'great', 'her', 'his', 'on', 'or', 'your'])
export function capItemHighlightRepeats(value: string): string {
  const fold = (w: string): string => {
    let b = w.toLowerCase().replace(/[^a-z0-9]/g, '')
    if (b === 'tshirt' || b === 'tshirts') b = 'shirt'
    return b.replace(/s$/, '')
  }
  const counts = new Map<string, number>()
  const kept: string[] = []
  for (const phrase of value.split(',').map((p) => p.trim()).filter(Boolean)) {
    const local = new Map<string, number>()
    for (const w of phrase.split(/[\s/-]+/).map(fold)) {
      if (w.length <= 1 || IH_TRIVIAL.has(w)) continue
      local.set(w, (local.get(w) ?? 0) + 1)
    }
    let ok = true
    for (const [w, c] of local) if ((counts.get(w) ?? 0) + c > 2) { ok = false; break }
    if (!ok) continue
    for (const [w, c] of local) counts.set(w, (counts.get(w) ?? 0) + c)
    kept.push(phrase)
  }
  // TERMINAL LENGTH NET (PO 2026-07-19): Item Highlights must stay ≤75 chars (short feature/benefit phrases,
  // not a full sentence). This runs at the PUSH boundary (buildDetailPatchValue) + every generator return +
  // the regen route, so a stale/LLM/stored ~120-char value is truncated to ≤75 at a COMMA boundary (never
  // mid-word) even if it never went through the ≤75 generator gate. Always keeps ≥1 phrase (never blanks).
  const capped: string[] = []
  let len = 0
  for (const p of kept) {
    const next = capped.length ? len + 2 + p.length : p.length
    if (next > 75 && capped.length >= 1) break
    capped.push(p); len = next
  }
  const finalPhrases = capped.length ? capped : kept.slice(0, 1)
  return finalPhrases.join(', ') || value.split(',')[0]?.trim() || value
}

export function buildDetailPatchValue(
  attr: DetailAttribute,
  rawValue: string,
  marketplaceId: string,
  languageTag = 'en_US',
): PatchValueEntry[] {
  let trimmed = (rawValue || '').trim()
  if (!trimmed) return []
  // Item Highlight: cap repeated words so a non-compliant value (LLM/stored/stale) can never be the reason
  // Amazon rejects this OR any other attribute's patch for the SKU (Amazon re-validates the whole item).
  if (isItemHighlightsField(null, attr.spApiKey)) trimmed = capItemHighlightRepeats(trimmed)
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

/** collar_style from the NECKLINE truth — the #161 PO mapping as a pure rule (2026-08-08 root
 *  fix): Amazon's collar_style enum has NO "Crew Neck" member; "Round Collar" is the one member
 *  that describes a crew neckline, and the audit's "Collarless" was PO-rejected as wrong for a
 *  crew-neck tee. Extracted so listingPipeline applies it from ANY neck source (blank_specs.neck
 *  OR the audit's own Neck row) and the rule is unit-testable. Returns null when the neckline
 *  doesn't determine a collar member (never guess). */
export function collarStyleForNeck(neck: string | null | undefined): string | null {
  return /crew/i.test(neck ?? '') ? 'Round Collar' : null
}

/** Amazon error 100476 — "Provide an Item Name that is 75 characters or less to use Item Highlights".
 *  Item Highlights only render beside a SHORT title, so Amazon REFUSES the write while the listing's live
 *  item_name exceeds 75 chars. This is a DIFFERENT condition from the marketplace-wide pre-launch wall
 *  (isWriteBlockedPreLaunch / "currently unsupported"): it is PER-SKU and self-clears the moment a ≤75
 *  title is live on that SKU.
 *
 *  WHY THIS IS THE GROUND TRUTH (2026-07-19, B0FKKN8XKV): a pre-emptive gate on our OWN cached title can
 *  NOT catch this — our listing_content cache said 73 chars while Amazon rejected the write, i.e. the live
 *  item_name had diverged from the cache. Amazon's own 100476 is the only reliable signal, so we classify
 *  IT (and let the caller self-heal by pushing the ≤75 title) instead of trusting a stale local length. */
export function isItemHighlightTitleTooLongError(err: string | null | undefined): boolean {
  return !!err && /\b100476\b|item name that is 75 characters or less/i.test(err)
}

/** The remedy text shown in place of Amazon's raw code. Shared so both IH write sites say the same thing.
 *
 *  WORDED FROM VERIFIED FACT (2026-07-19, B0FKKN8XKV live push: 18 accepted / 2 failed): do NOT claim the
 *  stored title is >75 — it is NOT. A live read of all 163 buyable SKUs showed every stored item_name at
 *  73 chars with ZERO over 75, yet Amazon still returned 100476 for PHE-STS-4XL-CRMS-FBA (stored title 73)
 *  and for the variation PARENT PHE-STS-P. So Amazon measures a LONGER effective name than the one we
 *  store — most likely the variation-composed name (title + size/colour, e.g. "…TShirt, 4XL, Crimson") or a
 *  stale parent item_name that the child-title push never overwrites. The message therefore reports what
 *  Amazon said and gives the actionable lever (headroom) without asserting an unverified cause. */
export const ITEM_HIGHLIGHT_TITLE_TOO_LONG_MSG =
  'Amazon rejected Item Highlights for this SKU with error 100476 ("Provide an Item Name that is 75 characters or less"). NOTE: this listing\'s stored title is already ≤75, so Amazon is measuring a LONGER effective name for this variant — typically the variation-composed name (title + size/colour) or a stale parent item_name. Shorten the title to leave headroom for the variant suffix, then re-push; or set this one SKU\'s highlight in Seller Central.'

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
