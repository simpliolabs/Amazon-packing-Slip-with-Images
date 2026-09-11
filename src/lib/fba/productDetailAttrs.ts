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
import { CONTENT_CONTRACT } from '@/lib/fba/contentContract'
import type { SupabaseClient } from '@supabase/supabase-js'
import { GARMENT_HEAD_WORDS } from '@/lib/fba/garmentNoun'
// FIX ROUND 3 (I-1, controller RULING, phase-1-fix-round-3-findings.md): `healItemHighlightOnServe`
// below is the ONE "scrub-then-cap-keep-scrubbed" shape both `ai-recommendations/route.ts` serve
// sites need — trademarkGuard.ts has zero imports of its own (verified: a pure pattern-matching
// leaf), so pulling it in here does not compromise this module's client-safety (the client `page.tsx`
// imports `classifyStoredIhLine` from here directly).
import { scrubTrademarks } from '@/lib/fba/trademarkGuard'
// IH TERMINAL NET PHASE A (2026-09-10, redoing the reverted feat/ih-phase23-wip Phase 2): run
// scrubTrademarks AND scrubCelebrityNames at the detail push path (buildDetailPatchValue) — both
// scrubs were generation-time only before this, so a stale/pre-scrub-era stored value, or a
// refusal that let the pre-scrub value persist, reached this function and Amazon's PATCH body
// untouched. celebrityGuard.ts is ALSO a zero-import pure leaf (verified, same check as
// trademarkGuard.ts above) — pulling it in here does not compromise this module's client-safety.
import { scrubCelebrityNames } from '@/lib/fba/celebrityGuard'
// SEASONAL_TERMS/isOffSeasonKeyword MOVED IN (IH terminal net Phase A): seasonalTerms.ts is a
// documented ZERO-import leaf (verified), so importing it here is safe by the same rule.
import { SEASONAL_TERMS, isOffSeasonKeyword } from '@/lib/keyword-engine/seasonalTerms'
// TYPE-ONLY — erased at compile, zero runtime import, so this does NOT create the cycle a VALUE
// import would (contentTruth.ts imports blankSpecs.ts, which imports THIS module for
// `capItemHighlightRepeats` — a value import back would be circular, and would also drag
// blankSpecs.ts's supabase client into the client bundle `page.tsx` pulls this leaf into directly).
// The caller (listingPipeline.ts, which already imports contentTruth.ts) supplies the actual
// verdict function as a closure via `CapItemHighlightRepeatsOpts.truthCheck` — this module never
// calls `phraseTruthVerdict`/`ihLineTruthVerdict` itself, only types the shape of what comes back.
import type { PhraseTruthReason } from '@/lib/fba/contentTruth'

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
 * PRECEDENCE between a deterministic-truth producer and the mega-audit LLM's own guess for the
 * SAME detail field (defect class closed 2026-09-02 — the age producer, PR #654, shipped an audit
 * guess instead of its own ground-truth row because nothing arbitrated the two). Higher wins.
 * 'spec' (a stated blank_specs fact) and 'ruling' (a deterministic PO ruling) are both grounded in
 * something the seller/PO actually stated; 'audience' is the seller's own lean selector — real, but
 * weaker than a stated garment fact. An UNSTAMPED row (value_source undefined) is the mega-audit
 * re-guessing from the listing's own existing copy every run, and never outranks any of the above —
 * mirrors the ranking `stickyDetails.ts` already documents for "does a fresh row get to re-propose
 * over an accepted push" (spec/ruling can re-propose, plain LLM churn never does).
 */
const VALUE_SOURCE_RANK: Record<string, number> = { spec: 3, ruling: 2, audience: 1 }

/** Rank for a value_source; undefined/unrecognized (LLM guess) ranks lowest (0). */
function valueSourceRank(vs: string | null | undefined): number {
  return vs ? (VALUE_SOURCE_RANK[vs] ?? 0) : 0
}

/** Live product-type menu entry — the same shape `listingPipeline.ts` threads through as
 *  `input.detailAttributeMenu` (fetched once per regen from the Product Type Definitions API).
 *  `accepted` is the confirmed-live enum vocabulary (deprecated members already excluded);
 *  absent/empty means free-text or the menu was unavailable — never validate against a guess. */
export interface DetailMenuAttr { key: string; title: string; accepted?: string[] }

/** The result shape `coerceToEnum`/`coerceGenderToEnum` (productTypeDefinitions.ts) return —
 *  duplicated as a structural type (not imported) so this module stays free of that file's import,
 *  which pulls in `@/lib/supabase/server`: this file is bundled into a CLIENT component
 *  (`fba/listing/[asin]/page.tsx` imports its pushable-check helpers), and there is no reliable way
 *  to prove tree-shaking drops it from that bundle in this worktree (`next build` fails here on an
 *  unrelated Turbopack symlink error). The caller (listingPipeline.ts, server-only) injects the real
 *  functions; this file only depends on their SHAPE. */
export interface EnumCoercion { valid: boolean; value: string; accepted: string[]; changed: boolean }

/** Injected coercer: (spApiKey, rawValue, acceptedMembers) -> the accepted-member verdict. The
 *  caller supplies `coerceToEnum`/`coerceGenderToEnum` so this module validates with the EXACT same
 *  rule the LLM path is already held to (productTypeDefinitions.ts's `coerceDetailValue`) — no
 *  second rulebook. */
export type EnumCoercer = (spApiKey: string, rawValue: string, accepted: string[]) => EnumCoercion

/** Resolve the live menu entry for a field_name: the static ATTR_MAP key first (covers every field
 *  a deterministic producer in this codebase currently stamps — department, target_gender,
 *  age_range_description, fit_type, sleeve_type, apparel_fabric_stretch, fit_to_size_sentiment, …),
 *  else a normalized-title match (covers a schema-only attribute the static map has never heard
 *  of). Same "no hand-written case" guarantee `mergeDetailRowsByPrecedence` already gives
 *  provenance: a brand-new deterministic producer for a brand-new field is covered by construction. */
function menuAttrForField(fieldName: string, menu: DetailMenuAttr[]): DetailMenuAttr | undefined {
  const staticKey = resolveDetailAttribute(fieldName)?.spApiKey
  return menu.find((m) => (!!staticKey && m.key === staticKey) || normalizeFieldName(m.title) === normalizeFieldName(fieldName))
}

/**
 * THE PRECEDENCE RULE AT THE MERGE.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * DEFECT CLASS this closes: a deterministic, provenance-stamped producer (a stated blank_specs
 * fact, an audience selector, a PO ruling) and the mega-audit LLM can BOTH emit a row for the SAME
 * detail field in the SAME `product_details_improvements` array, and nothing decided which one
 * SHIPS. Some fields (Department, Fit, Sleeve, Apparel Fabric Stretch, Fit to Size Sentiment,
 * collar_style) happened to be safe only because their deterministic site OVERWRITES the existing
 * row in place (an unconditional `pdiFinal.map`). The age producer (PR #654) used the OTHER shape —
 * `appendSpecFact`'s original "add a row for this field, but only if none exists yet" — so on the
 * live case (a mega-audit that already guessed "Big Kid" for Age Range Description from the
 * listing's own existing copy) the deterministic 'Kids' row was never even proposed: whichever
 * producer WROTE FIRST won, and the LLM audit always runs first. That is an ordering accident, not
 * a rule — and every FUTURE `appendSpecFact` call for a NEW field inherits the same exposure unless
 * its author remembers to also hand-write an unconditional override, the way the six existing
 * overrides above happen to.
 *
 * THE FIX: `appendSpecFact` (listingPipeline.ts) no longer refuses to run just because a row
 * already exists for the field — it always emits its candidate when the family states the fact.
 * This function is the ONE place, called ONCE on the fully-assembled array, that then decides which
 * of possibly several rows for the same field ships: the highest-precedence `value_source` wins. A
 * field where EVERY row is unstamped (plain LLM output, nothing to arbitrate) is left exactly as
 * it was — this function only ever resolves a conflict where a stamped row exists; it never invents
 * a reason to drop a duplicate that has no deterministic competitor. A NEW producer for a NEW field
 * therefore needs no defensive code of its own: stamp `value_source:'spec'|'ruling'|'audience'` and
 * push the row — precedence is enforced HERE, structurally, not by convention at each call site.
 *
 * Pure, deterministic: ties (including two unstamped rows for the same field) keep the FIRST
 * occurrence, so output order is stable and a field with no stamped competitor is byte-identical.
 *
 * VALIDITY EXTENSION (defect class closed 2026-09-02, PR #660 follow-up): provenance rank alone is
 * not enough — a deterministic producer (`appendSpecFact` et al.) can stamp a HARDCODED label
 * (`contentTruth.ts`'s `AGE_RANGE_LABEL.kids = 'Kids'`) that Amazon's live enum does not accept,
 * while the mega-audit LLM's competing row for the same field WAS enum-accepted (the audit prompt
 * requires "verbatim" menu members). Ranking by provenance alone then promotes the UNVALIDATED
 * label over the VALIDATED guess — trading a value Amazon would accept for one it may reject
 * (live: B0DP5H8QBT shipped Age Range Description="Kids", not a member of
 * {Adult,Big Kid,Little Kid,Toddler,Infant,Newborn}, over the LLM's accepted "Big Kid").
 *
 * THE RULE IS NOW: validity outranks provenance. When `menu` + `coerce` are supplied and this
 * field has a live accepted list, a row that coerces to an accepted member always beats one that
 * doesn't, regardless of value_source; provenance rank only breaks ties WITHIN the same validity
 * tier (so "a valid spec row beats a valid LLM row" still holds, and "an invalid spec row loses to
 * a valid audience/LLM row" — the inversion #660 got wrong — now holds too). The winning row is
 * coerced to the exact accepted member and stamped `is_enum`/`enum_valid`/`enum_accepted`/
 * `normalized_from` — the same fields the route's own post-audit validation stamps on the LLM path
 * — so this function's output is self-describing without waiting on that later pass. When every
 * candidate is uncoercible, there is no valid alternative to prefer: fall back to the provenance
 * winner exactly as before, but stamp it `enum_valid:false` (never a silent, unflagged pass) and
 * log a greppable rejection so a knowingly-invalid value never ships quietly.
 *
 * NO-OP GUARANTEE: omit `menu`/`coerce`, or a field absent from the menu, or a menu entry with no
 * `accepted` list (free-text attribute) — output is byte-identical to the provenance-only rule
 * above. This function never invents an enum check where Amazon states none.
 */
export function mergeDetailRowsByPrecedence<T extends {
  field_name: string
  recommended_value: string
  value_source?: string | null
  is_enum?: boolean
  enum_valid?: boolean
  enum_accepted?: string[]
  normalized_from?: string
}>(
  rows: T[],
  menu?: DetailMenuAttr[],
  coerce?: EnumCoercer,
): T[] {
  const groups = new Map<string, { rows: T[]; bestRank: number }>()
  const order: string[] = []
  for (const row of rows) {
    const key = normalizeFieldName(row.field_name)
    const rank = valueSourceRank(row.value_source)
    let g = groups.get(key)
    if (!g) { g = { rows: [], bestRank: -1 }; groups.set(key, g); order.push(key) }
    g.rows.push(row)
    if (rank > g.bestRank) g.bestRank = rank
  }
  const out: T[] = []
  for (const key of order) {
    const g = groups.get(key)!
    if (g.rows.length === 1 || g.bestRank <= 0) {
      // Single row for this field, OR every row for it is unstamped — nothing to arbitrate; pass
      // through untouched (preserves pre-existing behavior for any duplicate this function was
      // never asked to resolve).
      out.push(...g.rows)
      continue
    }
    const menuAttr = menu ? menuAttrForField(g.rows[0].field_name, menu) : undefined
    const accepted = menuAttr?.accepted
    if (!coerce || !accepted || accepted.length === 0) {
      // No live enum to validate against (menu unavailable, field not on it, or free-text) —
      // EXACT prior rule: keep the FIRST row at the highest provenance rank, drop the rest.
      out.push(g.rows.find((r) => valueSourceRank(r.value_source) === g.bestRank)!)
      continue
    }
    const spApiKey = menuAttr!.key
    const scored = g.rows.map((r) => ({ row: r, rank: valueSourceRank(r.value_source), coerced: coerce(spApiKey, r.recommended_value, accepted) }))
    const validPool = scored.filter((s) => s.coerced.valid)
    if (validPool.length === 0) {
      // No candidate coerces to an accepted member — nothing valid to prefer. Fall back to the
      // provenance winner (unchanged pick), but NEVER ship it as a silent pass: stamp it invalid
      // and log loudly so a hardcoded label that drifts from Amazon's enum is caught, not shipped.
      const fallback = scored.find((s) => s.rank === g.bestRank)!
      console.warn(JSON.stringify({
        tag: 'ENUM_PRECEDENCE_NO_VALID_CANDIDATE', field: g.rows[0].field_name, spApiKey, accepted,
        candidates: scored.map((s) => ({ source: s.row.value_source ?? null, value: s.row.recommended_value })),
      }))
      out.push({ ...fallback.row, is_enum: true, enum_valid: false, enum_accepted: fallback.coerced.accepted } as T)
      continue
    }
    // Best VALID candidate wins — provenance rank only breaks ties within the valid pool (first
    // occurrence on a tie, exactly like the no-menu rule above).
    let best = validPool[0]
    for (const s of validPool) if (s.rank > best.rank) best = s
    for (const s of scored) {
      if (s !== best && !s.coerced.valid) {
        console.warn(JSON.stringify({
          tag: 'ENUM_PRECEDENCE_REJECTED', field: g.rows[0].field_name, spApiKey,
          rejectedSource: s.row.value_source ?? null, rejectedValue: s.row.recommended_value,
          shippedSource: best.row.value_source ?? null, shippedValue: best.coerced.value, accepted,
        }))
      }
    }
    out.push({
      ...best.row,
      recommended_value: best.coerced.value,
      is_enum: true,
      enum_valid: true,
      enum_accepted: best.coerced.accepted,
      ...(best.coerced.changed ? { normalized_from: best.row.recommended_value } : {}),
    } as T)
  }
  return out
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

/* ── THE ONE ITEM-HIGHLIGHT REPEAT RULE ────────────────────────────────────────────────────────
 *
 * Until 2026-08-18 there were TWO, and they disagreed on every axis:
 *
 *                        threshold          tokenizer            stopwords
 *   generator validator  c > 1  (ONCE)      highlightTokens      HIGHLIGHT_STOPWORDS
 *   push boundary        > 2    (TWICE)     local split          IH_TRIVIAL
 *
 * Amazon's rule is TWICE — documented above from a real SKU rejection. So the GENERATOR was
 * enforcing a rule stricter than the marketplace, rejecting values the push boundary would have
 * shipped without complaint. The corrective-retry loop burned turns chasing a constraint that does
 * not exist, and the deterministic fallback dropped descriptive phrases it never needed to drop.
 *
 * That directly fought the seller's own request (2026-08-18) to source MORE descriptive terms from
 * the keyword bank — their example, "Graphic Tee for Women", folds `tee` to `shirt`, so on any
 * highlight that already names the garment once the stricter rule refused a phrase Amazon accepts.
 *
 * ONE predicate, exported, used by both. Threshold = Amazon's. Folding = the push boundary's (the
 * side that has actually been rejected, so its folding is the tested one). The two stopword sets are
 * UNIONED rather than one being picked: each contains words the other lacks ('on'/'or'/'your' only
 * in IH_TRIVIAL), and a word wrongly counted as significant is a false rejection — the failure
 * direction that costs the seller a legal phrase.
 * ─────────────────────────────────────────────────────────────────────────────────────────────── */

/** Amazon's cap: a non-trivial word may appear at most this many times in one Item Highlight. */
export const IH_MAX_WORD_REPEATS = 2

/** Canonical fold — plurals and the tshirt/shirt family collapse to one token. */
export const ihFoldWord = (w: string): string => {
  let b = w.toLowerCase().replace(/[^a-z0-9]/g, '')
  if (b === 'tshirt' || b === 'tshirts') b = 'shirt'
  return b.replace(/s$/, '')
}

/* ── TASK 8 (2026-09-07, PO RULING verbatim "A: 2 - Sweatshirt/ crewneck/, Tee Shirt/t-Shirt/
 * tshirt/Shirt", option 2 of the Task 6 fork): the absolute no-repeat rule (below) made every
 * truthful sweatshirt/tee family HOLD, because the product's own garment noun must appear twice to
 * reach the 107-char floor once the pool's phrases are all-brand-name/category copy. The PO exempts
 * the GARMENT HEAD NOUN alone, up to Amazon's own cap — every other significant word stays at 1.
 * The exempt set is DERIVED from `GARMENT_HEAD_WORDS` (`garmentNoun.ts`, a leaf, zero imports —
 * confirmed no cycle) folded through `ihFoldWord`, never a second hand-maintained list: adding a
 * noun to the canonical set extends this budget automatically (see the derivation test in
 * `itemHighlightOneRule.test.ts`). `ihRepeatBudget` is the ONE function every consumer of "is this a
 * repeat" reads — the composer's `classifyTier`/`admitCandidate` (and therefore the shadow
 * reachability pass, by construction) and `lineHasSignificantRepeat`/`classifyStoredIhLine` (and
 * therefore the push seam's refusal and the card's pre-flight reason). Never write the literal `2`
 * anywhere else — `IH_MAX_WORD_REPEATS` above is the one constant. */
export const IH_GARMENT_HEAD_FOLDED: ReadonlySet<string> = new Set([...GARMENT_HEAD_WORDS].map(ihFoldWord))

/* ── TASK 8 ROUND 2 (2026-09-07, controller RULING, task-8-round-2-findings.md, R1) ─────────────
 * FIX ROUND 1 closed the Blocking finding (the pad's `${spec.fit} Fit` / `Unisex Fit` boilerplate
 * collision) with a hand-written `IH_BOILERPLATE_BUDGET_2 = new Set(['fit'])` — a REMEMBERED fact
 * about the pad-bank templates ("fit happens to be the only word two templates append today"),
 * not something derived from the templates themselves. And the pad bank that fact was about existed
 * TWICE in `itemHighlightComposer.ts` (the shadow reachability pass, `:313-314` at HEAD 1d24425, and
 * the live pad loop, `:511-514`) — the I-1 class again, on the pad side.
 *
 * `IhPadSpec` is a LOCAL structural type (not a value import of `blankSpecs.ts` — this module's
 * value imports stay `contentContract` + `garmentNoun` only, per the brief's F1 leaf pin); any
 * `Pick<BlankSpec, 'material'|'fit'|'unisex'|'neck'|'sleeve'|'dye'>`-shaped object satisfies it
 * structurally, so the composer can pass its own `opts.spec` (a superset) with no cast. */
export interface IhPadSpec {
  material?: string | null
  fit?: string | null
  unisex?: boolean | null
  neck?: string | null
  sleeve?: string | null
  dye?: string | null
}

/** The boilerplate SUFFIX words the pad templates append — named ONCE so a template is built FROM
 *  the constant instead of a repeated literal, and so the budget derivation (below) can fold on it. */
export const IH_PAD_SUFFIX_FIT = 'Fit'
export const IH_PAD_SUFFIX_FABRIC = 'Fabric'

/** One pad-bank template: a fact slot the composer's pad loop may fill from `IhPadSpec`, and — if
 *  the filler appends a fixed boilerplate word to the spec value — which suffix that is. `suffix:
 *  null` means the filler is the raw spec value with nothing appended (material/neck/sleeve today).
 *  `suffix` is what the budget derivation below folds on; it is independent of exactly how `build`
 *  spells the filler, so a template's wording can change without touching the derivation. */
interface IhPadFillerDescriptor {
  readonly key: string
  readonly suffix: string | null
  readonly build: (spec: IhPadSpec) => string
}

/** THE pad bank — the ONE template list, moved verbatim from the composer (same order, same
 *  conditions: `material`, `${fit} Fit`, `Unisex Fit` when `unisex === true`, `neck`, `sleeve`,
 *  `${dye} Fabric`). Both the composer's live pad loop and its shadow reachability pass build their
 *  filler candidates from `ihSpecFactFillers` below instead of hand-writing this array a second
 *  time — the day one drifts from the other is now structurally impossible because there is only
 *  one array. */
// Exported so a test can reference the SAME list the production derivation and both composer call
// sites read (perturbing a COPY of it, never this one) — never a second hand-typed template list.
// TASK 8 ROUND 3: every descriptor that declares a `suffix` must BUILD it from the same constant
// (never a literal that merely happens to spell the same word today) — the self-consistency pin in
// itemHighlightOneRule.test.ts enforces this so `deriveIhBoilerplateBudget` (reads `suffix`) can
// never silently diverge from the bytes `build` actually appends.
export const IH_PAD_FILLER_DESCRIPTORS: readonly IhPadFillerDescriptor[] = [
  { key: 'material', suffix: null, build: (sp) => sp.material || '' },
  { key: 'fit', suffix: IH_PAD_SUFFIX_FIT, build: (sp) => (sp.fit ? `${sp.fit} ${IH_PAD_SUFFIX_FIT}` : '') },
  { key: 'unisex', suffix: IH_PAD_SUFFIX_FIT, build: (sp) => (sp.unisex === true ? `Unisex ${IH_PAD_SUFFIX_FIT}` : '') },
  { key: 'neck', suffix: null, build: (sp) => sp.neck || '' },
  { key: 'sleeve', suffix: null, build: (sp) => sp.sleeve || '' },
  { key: 'dye', suffix: IH_PAD_SUFFIX_FABRIC, build: (sp) => (sp.dye ? `${sp.dye} ${IH_PAD_SUFFIX_FABRIC}` : '') },
]

/** The ONE pad bank. Returns the true, non-empty filler phrases for `spec`, in priority order,
 *  exactly as `composeItemHighlightDetailed`'s live pad loop and its shadow reachability pass used
 *  to each hand-write independently. `titleCasePhrase` remains the CALLER's responsibility (as it
 *  was before) — this function returns raw fact strings, not display-cased ones, so byte-identity
 *  with the pre-round-2 output holds exactly. */
export function ihSpecFactFillers(spec: IhPadSpec | null | undefined): string[] {
  if (!spec) return []
  return IH_PAD_FILLER_DESCRIPTORS.map((d) => d.build(spec)).filter(Boolean)
}

/** COMPUTED, not remembered: fold every template's appended suffix word (skipping templates with no
 *  suffix) and keep any suffix appended by >= 2 templates — two independent spec facts that happen
 *  to share only that one boilerplate word are not a real customer-visible repeat (PO 2026-08-06
 *  unisex ruling; fix round 1's Blocking finding). A suffix appended by exactly one template (today:
 *  "fabric", from `dye` alone) stays at the default budget of 1. Exported so a test can perturb a
 *  COPY of the descriptor list and prove this derives — the day a template appends a THIRD shared
 *  suffix, or a new suffix starts being shared, this recomputes automatically; a hand-written Set
 *  could not have. */
export function deriveIhBoilerplateBudget(descriptors: readonly Pick<IhPadFillerDescriptor, 'suffix'>[]): ReadonlySet<string> {
  const counts = new Map<string, number>()
  for (const d of descriptors) {
    if (!d.suffix) continue
    const folded = ihFoldWord(d.suffix)
    counts.set(folded, (counts.get(folded) ?? 0) + 1)
  }
  return new Set([...counts.entries()].filter(([, c]) => c >= 2).map(([w]) => w))
}

const IH_BOILERPLATE_BUDGET_2: ReadonlySet<string> = deriveIhBoilerplateBudget(IH_PAD_FILLER_DESCRIPTORS)
export function ihRepeatBudget(folded: string): number {
  return IH_GARMENT_HEAD_FOLDED.has(folded) || IH_BOILERPLATE_BUDGET_2.has(folded) ? IH_MAX_WORD_REPEATS : 1
}

/** Words that never count toward the repeat cap. Union of both historical sets — see the block
 *  comment above for why union rather than a pick. */
export const IH_INSIGNIFICANT: ReadonlySet<string> = new Set([
  ...IH_TRIVIAL,
  'great', 'her', 'his',   // from the generator's HIGHLIGHT_STOPWORDS
])

/** THE rule. Returns the folded words that exceed Amazon's cap (empty = compliant).
 *  One implementation, so the generator can never reject what the push boundary would ship. */
export function ihRepeatViolations(value: string): string[] {
  const counts = new Map<string, number>()
  for (const w of (value || '').split(/[\s/,-]+/).map(ihFoldWord)) {
    if (w.length <= 1 || IH_INSIGNIFICANT.has(w)) continue
    counts.set(w, (counts.get(w) ?? 0) + 1)
  }
  return [...counts.entries()].filter(([, c]) => c > IH_MAX_WORD_REPEATS).map(([w]) => w)
}

/* ── THE ABSOLUTE NO-REPEAT PREDICATE — ONE HOME (FIX WAVE 2 ROUND 2, F1, controller RULING,
 * 2026-09-06, final-fix-wave-2-round-2-findings.md) ───────────────────────────────────────────────
 *
 * `lineHasSignificantRepeat` (PO ruling "2. No Repeat as per Amazon Ruules") used to live in
 * `itemHighlightComposer.ts` — the GENERATION path (imports `contentTruth` -> `blankSpecs` -> a
 * lazy supabase client). `perDesignItemHighlights.ts` (the push seam + the per-design row builder
 * the CLIENT page reads, `fba/listing/[asin]/page.tsx`, 'use client') imported it from there, so the
 * client page transitively reached the composer: the next value-level import added to the composer
 * would have landed in the browser bundle silently, regardless of whether tree-shaking hid today's
 * import. This module is already a leaf `page.tsx` imports directly and already hosts the sibling
 * predicate (`ihRepeatViolations`, Amazon's own ≤2-per-word cap) — ONE home for both Item-Highlight
 * repeat predicates. `itemHighlightComposer.ts` now imports `GENDER_FOLDS`/`significantFolded`/
 * `lineHasSignificantRepeat` from HERE instead of defining them; `perDesignItemHighlights.ts` never
 * imports anything from the composer again. */

/** Gender/audience irregular plurals fold together (woman≡women, ladies≡lady, man≡men) — without
 *  this, "alligator shirt women" + "alligator shirts woman" both pass novelty and the line becomes
 *  the exact permutation-spam the PO rejected. The ONE fold every repeat check in this codebase
 *  uses — the composer's selection loop AND the push seam's terminal net both read this, so a
 *  folding drift between "what composition calls a repeat" and "what the push seam calls a repeat"
 *  (the class `coverage-token-folding-shirt-hub-trap` names) cannot happen. */
export const GENDER_FOLDS: Record<string, string> = { women: 'woman', men: 'man', ladies: 'lady', gals: 'gal' }

/** RULING P6 (fix round B5, value Important P6a/b): a token that is PURELY numeric/percentage
 *  (after `ihFoldWord` strips punctuation — "50%" folds to "50") is a COMPOSITION FACT, not a
 *  repeated significant word. Before this rule, a true 50/50 (or any N/N) material split — the
 *  composer's own pad bank writes "50% Cotton / 50% Polyester" verbatim — folded to the SAME word
 *  "50" twice and was refused as `repeat-in-stored-line` by `classifyStoredIhLine`/
 *  `lineHasSignificantRepeat`, on every 50/50 family (B0DSCDZC6K included), at the PUSH SEAM — not
 *  only inside the writer. Reproduced live (unmodified HEAD `7a05570`): `classifyStoredIhLine('50%
 *  Cotton / 50% Polyester')` returned `'repeat-in-stored-line'`. A bare digit string is never a
 *  customer-facing "word" a shopper would read as repeating — it is part of the RATIO notation
 *  ("50/50", "52/48") — so it is excluded from the significant-word count entirely, the same way
 *  punctuation and stopwords already are. */
const isPureNumericToken = (folded: string): boolean => /^[0-9]+$/.test(folded)

export const significantFolded = (phrase: string): string[] =>
  phrase.toLowerCase().split(/\s+/)
    .map((w) => { const f = ihFoldWord(w); return GENDER_FOLDS[f] ?? f })
    .filter((w) => w && !IH_INSIGNIFICANT.has(w) && !isPureNumericToken(w))

/** RULING P7 (fix round B5, value Important I2): the SURFACE word(s) behind a folded significant
 *  word, aligned one-to-one with `significantFolded`'s own fold+filter (never a second copy of that
 *  logic) — so a retry/refusal message can name what the LINE actually SAYS ("Women"/"Woman") rather
 *  than the internal folded stem ("woman"), and can quote every distinct SPELLING that folded to the
 *  same word (plural/gender forms fold together, so a mixed-case line like "…Women…Woman…" reports
 *  both surface spellings under the one folded key). */
export interface SignificantWordOccurrence { folded: string; surface: string }
export const significantWordsWithSurface = (phrase: string): SignificantWordOccurrence[] => {
  const out: SignificantWordOccurrence[] = []
  for (const raw of (phrase || '').split(/\s+/)) {
    if (!raw) continue
    const f0 = ihFoldWord(raw)
    const f = GENDER_FOLDS[f0] ?? f0
    if (!f || IH_INSIGNIFICANT.has(f) || isPureNumericToken(f)) continue
    const surface = raw.replace(/[^A-Za-z0-9'-]/g, '')
    if (!surface) continue
    out.push({ folded: f, surface })
  }
  return out
}

/** TRUE when `line` (the composer's own comma-joined shipped bytes, or any candidate stored line)
 *  repeats a folded significant word — the ABSOLUTE rule (PO ruling 2026-09-06, "2. No Repeat as
 *  per Amazon Ruules") stated as a predicate over bytes rather than over the live selection state,
 *  so a caller holding only the STORED line (no `usedFolded` set — the push seam, a stale per-child
 *  entry) can still ask the same question the composer's own selection loop asks incrementally. */
export const lineHasSignificantRepeat = (line: string): boolean => {
  // TASK 8 (2026-09-07): counts, not a seen-Set — the garment head noun's budget is 2, so only a
  // count PAST that budget (`ihRepeatBudget`) is a repeat; every other word's budget is still 1.
  const counts = new Map<string, number>()
  for (const w of significantFolded(line)) {
    const c = (counts.get(w) ?? 0) + 1
    counts.set(w, c)
    if (c > ihRepeatBudget(w)) return true
  }
  return false
}

/** FIX WAVE 2 ROUND 2 (F2, controller RULING): the ONE classification of a STORED per-design Item
 *  Highlight line, shared by the push seam (`buildPerSkuItemHighlightMap`) and the card's row
 *  builder (`perDesignIhRows`, `perDesignItemHighlights.ts`) — so the card can show the seam's
 *  refusal PRE-FLIGHT (before any push is attempted) instead of learning it only from a push
 *  report. `'no-line-for-design'` — an empty/missing line (a HELD design, the pre-existing case).
 *  `'repeat-in-stored-line'` — a non-empty line that repeats a folded significant word (a
 *  pre-ruling stored value, a manual DB edit, or a future producer bug). `'under-floor'` — TASK 8
 *  ROUND 2 / IH TERMINAL NET PHASE 1 (2026-09-07, spec docs/superpowers/specs/2026-09-07-item-
 *  highlight-terminal-net.md, H13): a non-empty, non-repeating line shorter than
 *  `CONTENT_CONTRACT.itemHighlights.min` (97 as of the 2026-09-08 "2+3" floor ruling; was 107) —
 *  reproduced live: a stale/hand-edited/legacy stored
 *  line can sit under the floor forever because nothing at the push seam ever checked length, only
 *  repeats. `'ok'` — a non-empty, compliant line; the only classification that is ever pushable. */
export type IhLineClassification = 'ok' | 'no-line-for-design' | 'repeat-in-stored-line' | 'under-floor'
export function classifyStoredIhLine(value: string | null | undefined): IhLineClassification {
  const line = (value || '').trim()
  if (!line) return 'no-line-for-design'
  if (lineHasSignificantRepeat(line)) return 'repeat-in-stored-line'
  if (line.length < CONTENT_CONTRACT.itemHighlights.min) return 'under-floor'
  return 'ok'
}

/**
 * IH TERMINAL NET, PHASE 1 (2026-09-07, spec docs/superpowers/specs/2026-09-07-item-highlight-
 * terminal-net.md, PO 2026-09-07 verbatim "B: yesm go" — fix the terminal nets BEFORE the writer).
 *
 * REPRODUCED against this function unmodified (`scratchpad/ih-research/probe-h10-h13.mts`, HEAD
 * c1eabe9) — three fail-open bugs, all in the OLD trailing fallback
 * (`finalPhrases = capped.length ? capped : kept.slice(0, 1)`, then
 * `finalPhrases.join(', ') || value.split(',')[0]?.trim() || value`):
 *
 *  H10 a comma-less line repeating a significant word 4x: the per-word cap correctly computes the
 *      violation (the running `counts` map IS a whole-line count, not a per-segment one — a single
 *      comma-less "phrase" is checked against it exactly like any other) and correctly drops the
 *      sole phrase (`kept = []`) — but the OLD fallback then read `kept.slice(0,1)` (still `[]`)
 *      and fell through to `value.split(',')[0]?.trim() || value`, which — with no comma to split
 *      on — is just `value` again. The cap fires; the fallback UNDOES it. Measured: returned
 *      byte-identical to the input.
 *  H11 a comma-less 218-char line, no repeats: the length loop's own guard
 *      (`next > max && capped.length >= 1`) requires ONE phrase already kept before it will ever
 *      refuse — the first phrase is unconditionally pushed regardless of its own length. Measured:
 *      a 218-char line survived whole, past `buildDetailPatchValue`, toward the SP-API PATCH.
 *  H12 a 186-char two-clause line, one comma: the length loop correctly drops the trailing clause
 *      (86 > "next" over budget) — the drop is real and reduces the SP-API payload to 88 chars —
 *      but nothing checks whether the 88-char SURVIVOR still clears
 *      `CONTENT_CONTRACT.itemHighlights.min` (97 as of the 2026-09-08 "2+3" floor ruling; was 107).
 *      Silent amputation: half the seller's sentence
 *      ships, under the floor, and the seam does not notice.
 *
 * THE FIX. Both nets are unchanged in what they accept (repeat cap: `IH_MAX_WORD_REPEATS`/
 * `ihFoldWord`, exactly as before — Amazon's own flat cap, deliberately looser than the composer's
 * garment-exempt `ihRepeatBudget`, per the TASK 8 note this function already carried: this is the
 * push-boundary's defence-in-depth net, not a second copy of the composer's stricter rule, and nine
 * pre-existing tests (`blankBrandHighlightNet.test.ts` T4.x, `itemHighlightOneRule.test.ts`) already
 * pin bytes that would break under the stricter budget). What changes is what happens when neither
 * net can produce a compliant, non-empty result: REFUSE, never fall back to the raw un-netted input
 * and never ship a length-driven amputation that lands under the floor.
 *
 * FIX ROUND 1 (2026-09-07, controller RULING on phase-1-fix-round-findings.md — opus review
 * phase-1-review.md BLOCKING 1 + BLOCKING 2): Phase 1 encoded the refusal as `''`, and `''` already
 * meant "no value" to eight existing callers — one token, two facts. BLOCKING 1 reproduced
 * `buildDetailPatchValue` shipping `[{value:"", ...}]`, the literal body of a live SP-API `replace`
 * patch that CLEARS a shopper-visible field; BLOCKING 2 reproduced `applyBlankBrandNetPerDesign`
 * overwriting a compliant-looking 129-char stored line with `''`, `changed:true` — a design that WAS
 * pushable silently becomes HELD, and the overwrite is destructive (the truncation it replaced was
 * at least recoverable). The refusal is now a TYPED, OUT-OF-BAND result (`IhNetResult`), never a
 * string — a caller that does not destructure `.ok` before reading a value will not typecheck.
 */
/**
 * IH TERMINAL NET, PHASE A (2026-09-10, redoing the reverted `feat/ih-phase23-wip` @ `c466225`
 * Phase 2, docs/superpowers/specs/2026-09-10-item-highlight-writer.md §2 Phase A: "the five
 * already-written rules ... MOVED — not copied — onto the production path so the compose path,
 * the Regen route and the push seam all inherit").
 *
 * `validateItemHighlights` (listingPipeline.ts) already implemented five deterministic content
 * rules — off-season terms, promo/pricing language, hardcoded storage capacity, generic third-party
 * brands, and sentence shape (no sentence punctuation, at least 2 comma-phrases) — but was reachable
 * ONLY from `check-item-highlight/route.ts`, its one production caller. `capItemHighlightRepeats`
 * below — the terminal net EVERY producer, the Regen route, and `buildDetailPatchValue` (the actual
 * SP-API push) already call — never ran them: a hand-typed line containing "Free Shipping" (promo),
 * "Christmas" (off-season), a hardcoded "128GB", "Nike", or a full sentence with no comma phrases
 * each flagged by `validateItemHighlights` yet shipped byte-for-byte through the real push path —
 * the checker and the push boundary DISAGREED, the "two rulebooks" failure the spec's own adversary
 * names.
 *
 * THE MOVE. `THIRD_PARTY_BRANDS`/`THIRD_PARTY_BRAND_PHRASES`/`findThirdPartyBrands`/
 * `ownBrandTokenSet` (byte-identical bodies) and `CAPACITY_RE`/`HIGHLIGHT_PROMO_RE` relocate HERE
 * from listingPipeline.ts — the pure, client-safe leaf `capItemHighlightRepeats` already lives in —
 * and listingPipeline.ts re-imports them for its other ~20 call sites (title/bullets/backend brand
 * gates), never redefining them. `ihContentRuleViolations` below is the ONE predicate; both
 * `validateItemHighlights` (which now calls it, never re-implements it) and `capItemHighlightRepeats`
 * (which enforces it) read the SAME rules — a drift between "what the checker flags" and "what
 * actually ships" is now structurally impossible, not just coincidentally absent.
 *
 * BLOCKING 3, closed here (finish-final-review.md — the reverted branch's push seam asserted the
 * blanket default `designSeasons: []`, which asserts "this design is about NO occasion" and refused
 * a true Valentine line at `buildDetailPatchValue`). `designSeasons` below is OPTIONAL with NO
 * default: `undefined` means "this caller has no occasion signal" and the off-season rule is
 * SKIPPED entirely (never asserts an absence it does not know); an explicitly-passed `[]` means a
 * caller genuinely RESOLVED the design's occasions and found none, so the rule fires exactly as the
 * historical blanket behaviour did. `buildDetailPatchValue` (a pure leaf with no DB/title access —
 * it provably cannot know a SKU's occasion) omits `designSeasons` and so never runs the off-season
 * rule; every caller that DOES have real title/design-name context (the compose path via
 * `deriveDesignSeasons`, the per-child persist net, the Regen route via `seasonsIn`) passes the
 * real, resolved set.
 *
 * FIX ROUND 2 (RULING I-2/F2, I-2/F3): `capacityFamily` (default `false`) and `brandName` (default
 * `'THE CEO'`) are SAFE defaults in the sense that they can only ever ADD a refusal when told the
 * real signal, never guess — but a default that also happens to be a legal, common value HIDES a
 * caller's failure to resolve it (`research-vs-publish-boundary`'s own naming for this class): the
 * reviewer measured BOTH directions live — `hardcoded-capacity` never fired on the push path
 * because no caller threaded `capacityFamily: true` for a real multi-capacity family (a "128GB
 * Storage Room" line the CHECKER flagged still SHIPPED), and the `brandName` default disagreed with
 * the checker the other way when the seller's OWN brand token collides with a THIRD_PARTY_BRANDS
 * entry. Every caller that CAN resolve the real value now does: the compose path
 * (`buildItemHighlights`/`buildItemHighlightsPerDesign`, threaded from the SAME `PipelineInput.
 * brandName` and the pipeline's own family-wide capacity-token detection, listingPipeline.ts), the
 * per-child persist net (same closure scope, same two signals), and the Regen route (which
 * re-derives both locally, since it bypasses the pipeline — see that route's own comment).
 * `buildDetailPatchValue` (a pure leaf with no DB/brand-config/children access — it provably cannot
 * resolve either) is the ONE caller left on the default, which is why it is safe ONLY here: this
 * codebase hardcodes exactly one seller brand (`'THE CEO'` — listingPipeline.ts, `handoff/
 * SELLER_PROFILE.md:1`) and every OTHER caller of this leaf now supplies the real signal instead of
 * relying on the coincidence that the default happens to match.
 */
export const THIRD_PARTY_BRANDS = new Set([
  // Cameras & imaging
  'canon', 'nikon', 'sony', 'fujifilm', 'fuji', 'olympus', 'panasonic', 'pentax', 'leica',
  'kodak', 'gopro', 'insta360', 'dji', 'ricoh', 'sigma', 'tamron',
  // Memory / storage manufacturers
  'sandisk', 'samsung', 'lexar', 'kingston', 'pny', 'toshiba', 'transcend', 'adata', 'patriot',
  'crucial', 'seagate', 'maxell', 'micron',
  // Phones & computing
  'apple', 'iphone', 'ipad', 'macbook', 'imac', 'galaxy', 'pixel', 'microsoft', 'surface',
  'huawei', 'xiaomi', 'oneplus', 'motorola',
  // Drones
  'parrot', 'autel', 'skydio', 'yuneec',
  // Gaming
  'nintendo', 'playstation', 'xbox', 'switch',
  // Audio
  'bose', 'beats', 'jbl', 'sennheiser',
  // Apparel / athletic competitor RETAIL brands (2026-07-07, B0FRYMM56C: "why do we have NIKE"). The
  // keyword research pulls the #1 competitor's ranking terms ("nike shirts women") into the pool as
  // proven converters, and — until now — no filter knew Nike was a brand, so the bullet coverage
  // backstop wove it straight into customer copy. A graphic tee is NOT "compatible with" Nike, so these
  // are DROPPED (like trademark phrases), never framed "for [Brand]". OMITTED pending a context-guard
  // because they double as legit design words: champion / gap / columbia / express (common words),
  // puma (animal), wrangler (cowboy/Jeep), levis / hollister (names).
  'nike', 'adidas', 'reebok', 'lululemon', 'athleta', 'underarmour', 'vuori', 'gymshark',
  'fabletics', 'aeropostale', 'abercrombie', 'nautica',
])

/** Multi-word brand phrases (checked verbatim, not per-word). */
const THIRD_PARTY_BRAND_PHRASES = [
  'western digital', 'audio technica', 'sea gate', 'go pro',
  // Apparel/athletic competitor brands whose name is multi-word (per-word checks would false-positive
  // on 'under'/'new'/'north'/'face'). See the apparel block in THIRD_PARTY_BRANDS above.
  'under armour', 'new balance', 'north face',
]

/** Find every third-party brand token in `text`, excluding the seller's own brand. MOVED here
 *  (IH terminal net Phase A) from listingPipeline.ts — byte-identical body; re-imported there too. */
export function findThirdPartyBrands(text: string, ownBrandTokens: Set<string>): string[] {
  const lc = text.toLowerCase()
  const found = new Set<string>()
  for (const w of lc.split(/[^a-z0-9]+/).filter(Boolean)) {
    if (ownBrandTokens.has(w)) continue
    if (THIRD_PARTY_BRANDS.has(w)) found.add(w)
  }
  for (const phrase of THIRD_PARTY_BRAND_PHRASES) {
    if (lc.includes(phrase)) found.add(phrase)
  }
  return [...found]
}

/** Get the seller's own brand tokens for exemption from brand checks. Includes NORMALIZED forms
 *  (apostrophe-deleted, punctuation-stripped) alongside the raw tokens (adversarial 2026-07-08):
 *  the backend ban sites compare against normalized tokens ("Darlin' Co." must ban "darlin"), and
 *  a raw-only set silently no-ops for any punctuated brand. Superset — raw consumers unaffected.
 *  MOVED here (IH terminal net Phase A) from listingPipeline.ts — byte-identical body. */
export function ownBrandTokenSet(brandName: string): Set<string> {
  const s = new Set<string>()
  for (const t of brandName.toLowerCase().split(/\s+/).filter(Boolean)) {
    s.add(t)
    const stripped = t.replace(/['’]/g, '').replace(/[^a-z0-9]/g, '')
    if (stripped) s.add(stripped)
  }
  return s
}

// A storage-capacity token ("128GB", "1 TB"). MOVED here (IH terminal net Phase A) from
// listingPipeline.ts, byte-identical — re-imported there for its other call sites (capacityOf,
// the keyword-pool capacity filter, the per-keyword capacity strip), none of which change.
export const CAPACITY_RE = /\b(\d{1,4})\s?(t|g)b?\b/i // GB/TB only — "MB" is usually a transfer speed, not capacity

// Pricing/promo language never belongs in a customer-facing highlight. "% off" and "$" match
// anywhere (a \b next to "$" could never fire — it is not a word char); the words need boundaries.
// MOVED here (IH terminal net Phase A) from listingPipeline.ts, byte-identical.
const HIGHLIGHT_PROMO_RE = /\b(?:sale|discount|cheap|free|deal)\b|% ?off|\$/i

/** The five rules moved in Phase A. */
export type IhContentRuleReason = 'sentence-shape' | 'off-season' | 'promo-pricing' | 'hardcoded-capacity' | 'third-party-brand'

export interface IhContentRuleCtx {
  /** Seller's own brand — exempted from the third-party-brand check. Default `'THE CEO'` (see the
   *  block comment above: the ONE brand this codebase already hardcodes as its own fallback). */
  brandName?: string
  /** Whether this SKU belongs to a storage-capacity variation family. Default `false` — the
   *  capacity rule can only ever ADD a refusal when told the family is one; it never guesses. */
  capacityFamily?: boolean
  /** Canonical occasions THIS design is about (deriveDesignSeasons/seasonsIn). BLOCKING 3
   *  (finish-final-review.md): `undefined` (the default — omitted entirely) SKIPS the off-season
   *  rule — this caller has no occasion signal, so the rule must not assert one. An explicitly
   *  passed `[]` means the caller genuinely resolved the design's occasions and found none, so the
   *  rule fires exactly as the historical blanket behaviour did. NEVER default this to `[]`. */
  designSeasons?: readonly string[]
}

/** ONE named violation of a moved content rule — `message` is the EXACT text
 *  `validateItemHighlights` used to hand-roll inline (so it can now delegate here byte-for-byte
 *  instead of re-implementing), `reason` is the terminal net's refusal bucket. */
export interface IhContentRuleViolation { reason: IhContentRuleReason; message: string }

/** THE moved predicate (IH terminal net Phase A) — every rule `validateItemHighlights` used to
 *  enforce alone, now the ONE source both it and `capItemHighlightRepeats` read. Order matches the
 *  original inline checks (sentence-punctuation, then the moved third-party-brand/off-season/promo/
 *  capacity block, then the min-phrase check) — no test depends on order (both consumers use
 *  `.filter`/`.some`/`[0]`, never exact-array equality), but keeping it stable avoids a gratuitous
 *  diff in the checker route's `problems` array. */
export function ihContentRuleViolations(s: string, ctx?: IhContentRuleCtx): IhContentRuleViolation[] {
  const violations: IhContentRuleViolation[] = []
  if (/[.!?](\s|$)/.test(s)) {
    violations.push({ reason: 'sentence-shape', message: 'reads as a full sentence — use short comma-separated feature/benefit phrases with NO sentence punctuation (. ! ?)' })
  }
  const brandName = ctx?.brandName ?? 'THE CEO'
  const capacityFamily = ctx?.capacityFamily ?? false
  const brands = findThirdPartyBrands(s, ownBrandTokenSet(brandName))
  if (brands.length) violations.push({ reason: 'third-party-brand', message: `contains third-party brand(s)/team(s): ${brands.join(', ')}` })
  const lc = s.toLowerCase()
  // OFF-SEASON only (2026-07-23): "evergreen" means "not about a holiday we are not about". A
  // Valentine design's own "Valentine" is its subject, not a seasonal claim. BLOCKING 3: this rule
  // runs ONLY when the caller actually resolved a real occasion signal (`ctx.designSeasons !==
  // undefined`) — never on the bare absence of a ctx, which used to be indistinguishable from "we
  // checked and this design has no occasion" (see the type doc above).
  if (ctx?.designSeasons !== undefined) {
    const season = SEASONAL_TERMS.find((t) => lc.includes(t) && isOffSeasonKeyword(t, ctx.designSeasons))
    if (season) violations.push({ reason: 'off-season', message: `contains the seasonal term "${season}" — this is an evergreen field` })
  }
  if (HIGHLIGHT_PROMO_RE.test(s)) violations.push({ reason: 'promo-pricing', message: 'contains pricing/promotional language (sale/discount/cheap/free/deal/$/% off)' })
  if (capacityFamily && CAPACITY_RE.test(s)) violations.push({ reason: 'hardcoded-capacity', message: 'hardcodes a storage capacity — the field is shared across all capacity variants' })
  if (s.split(',').map((p) => p.trim()).filter(Boolean).length < 2) {
    violations.push({ reason: 'sentence-shape', message: 'must be at least 2 comma-separated phrases' })
  }
  return violations
}

/** The FIRST moved-rule violation, or null — what the terminal net (`capItemHighlightRepeats`)
 *  refuses on. Reads `ihContentRuleViolations` (never a second copy of the same checks) so the
 *  net and the checker can never drift apart from each other again. */
export function ihFirstContentRuleViolation(s: string, ctx?: IhContentRuleCtx): IhContentRuleReason | null {
  return ihContentRuleViolations(s, ctx)[0]?.reason ?? null
}

export type IhRefusalReason = 'repeat-over-budget' | 'over-max' | 'under-floor' | IhContentRuleReason | PhraseTruthReason
export type IhNetResult = { ok: true; value: string } | { ok: false; reason: IhRefusalReason }

/** PHASE A: the shape of a line-level truth check, injected by the caller (see the `truthCheck`
 *  doc below) — the SAME shape `ihLineTruthVerdict`/`phraseTruthVerdict` (contentTruth.ts) already
 *  return, typed here without importing them (value import would cycle — see the top-of-file
 *  comment on the `PhraseTruthReason` type-only import). */
export type IhTruthCheckFn = (line: string) => { ok: true } | { ok: false; reason: PhraseTruthReason }

export interface CapItemHighlightRepeatsOpts {
  /** IH terminal net Phase A: real context for the moved content-rule checks (see the block
   *  comment above `IhContentRuleReason` for the safe defaults every caller gets when this is
   *  omitted). CORRECTED (fix round 3, R4/I2 — the prior wording claimed EVERY pre-Phase-A call
   *  site "stays byte-identical under the defaults", which the reviewer measured false): the moved
   *  rules now reach FOUR of five seams with real, resolved `capacityFamily`/`brandName` context —
   *  the compose path, the per-child persist net, and the Regen route all thread the real signal.
   *  The FIFTH seam, `buildDetailPatchValue` below (the actual SP-API push), runs on the defaults —
   *  see the comment at its `capItemHighlightRepeats` call for why it provably cannot resolve
   *  either signal — and that is measured to produce 17 new refusals vs `150778c` (bytes3 probe)
   *  that the other four seams do not: a genuinely multi-capacity family's stale/hand-edited stored
   *  line can still ship a hardcoded capacity through THIS seam alone (a known, named gap — R4/I2
   *  leaves it as a FILED follow-up, not a silent one). */
  contentCtx?: IhContentRuleCtx
  /** R2 (finish-line-rulings.md, controller RULING, 2026-09-08) refuses any ACTUAL length-driven
   *  drop outright — see the `lengthDropped` block below. The ONE named, deliberate exception:
   *  `ensureBlankBrandInHighlights` (blankSpecs.ts) calls this net on its OWN
   *  `"authentic <brand> blank, " + hl` candidate, where trimming trailing phrases to fit is the
   *  DOCUMENTED insertion mechanic (PO ruling, SELLER_PROFILE.md §5 — "insertion order is the
   *  survival mechanism") that displaces LOW-priority phrases to make room for a MUST-carry brand
   *  fact, never the seller's own composed meaning being silently halved (H12's class). The floor
   *  check (`under-floor`, unconditional, checked first) still refuses an eviction that guts the
   *  line either way — this flag only widens what may clear it. No other caller may pass it; every
   *  other call site is exactly the terminal-net validation of a FINAL, already-composed/stored
   *  line R2 is about. */
  allowLengthAmputation?: boolean
  /** PHASE A (IH terminal net): the line-level content-TRUTH check — garment-noun, capability,
   *  audience, competitor-brand, weight-class, fit-claim, audience-lean, and material-lie — run on
   *  the FINAL netted bytes, after every other stage, exactly where the moved content rules (above)
   *  are wired. Injected (never imported — see the block comment on the `PhraseTruthReason` import
   *  at the top of this file) as a closure over `ihLineTruthVerdict(line, ctx)` and the caller's
   *  already-resolved `PhraseTruthCtx` (the SAME ctx the composer already built for this design,
   *  where one is available). Omitted ⇒ skip — a caller with no resolvable product-fact context
   *  (`buildDetailPatchValue`, a generic leaf with no DB/spec access) stays byte-identical; the
   *  composer's own per-candidate `ihTruthVerdict` check already covers a FRESH compose, so this is
   *  the backstop for a stale stored value, a hand-edit, or a candidate the compose-time check never
   *  saw assembled together with the brand/wear-fact phrase. */
  truthCheck?: IhTruthCheckFn
}

export function capItemHighlightRepeats(value: string, opts?: CapItemHighlightRepeatsOpts): IhNetResult {
  // Empty/whitespace-only input is NOT a refusal — it is "nothing to net", the pre-existing meaning
  // of `''` every caller already treats as "no value" before or after calling this net.
  // `buildDetailPatchValue` guards it BEFORE calling in; `regenerate-item-highlight/route.ts` does
  // not, so this keeps that caller's legacy behaviour byte-identical instead of mislabeling an
  // absent line as a "repeat"/"over-max" refusal.
  if (!value.trim()) return { ok: true, value: '' }
  // TASK 8 (2026-09-07): the local hand-copy of the fold is gone — this is the SAME hand-copy class
  // this function's own docstring history already names; `ihFoldWord` is byte-identical (proven on
  // this function's own pre-existing tests). The cap below is Amazon's own cap
  // (`IH_MAX_WORD_REPEATS`), unchanged and unrelated to the garment exemption — this is the terminal
  // push-boundary net, not the composer's stricter budget.
  // TASK 8 ROUND 2 (R1, reviewer Minor M1): the literal `2` is gone — `IH_MAX_WORD_REPEATS` above is
  // the one constant, never written as a bare number anywhere else in this file.
  // The running `counts` map is the WHOLE-LINE tally (Phase 1, H10) — it persists across every
  // comma-phrase in order, so a solitary comma-less "phrase" (the entire line) is checked against
  // it exactly like any later segment of a multi-phrase line would be; there is no separate
  // per-segment notion of "repeat" here to begin with, only a fallback that used to discard the
  // correct verdict (see the refusal below).
  const counts = new Map<string, number>()
  const kept: string[] = []
  const phrases = value.split(',').map((p) => p.trim()).filter(Boolean)
  for (const phrase of phrases) {
    const local = new Map<string, number>()
    for (const w of phrase.split(/[\s/-]+/).map(ihFoldWord)) {
      if (w.length <= 1 || IH_TRIVIAL.has(w)) continue
      local.set(w, (local.get(w) ?? 0) + 1)
    }
    let ok = true
    for (const [w, c] of local) if ((counts.get(w) ?? 0) + c > IH_MAX_WORD_REPEATS) { ok = false; break }
    if (!ok) continue
    for (const [w, c] of local) counts.set(w, (counts.get(w) ?? 0) + c)
    kept.push(phrase)
  }
  // TERMINAL LENGTH NET (PO 2026-08-10, was ≤75 per PO 2026-07-19): Item Highlights stay within
  // CONTENT_CONTRACT.itemHighlights.max (125) — Amazon's stated budget for this field, of which the old
  // 75 discarded 40%. The QUALITY rule is unchanged and is what the 2026-07-19 ruling was really about:
  // short feature/benefit phrases,
  // not a full sentence). This runs at the PUSH boundary (buildDetailPatchValue) + every generator return +
  // the regen route, so an over-budget stale/LLM/stored value is truncated to the contract max at a
  // COMMA boundary (never mid-word) even if it skipped the generator gate.
  // PHASE 1 (H11): the old guard (`&& capped.length >= 1`) forced the FIRST phrase to survive no
  // matter how long it was on its own — removed. A phrase (first or not) that alone would push past
  // the max is now dropped like any other; if that is every phrase, `capped` ends up empty and the
  // refusal below fires instead of a truncated lie.
  const capped: string[] = []
  let len = 0
  for (const p of kept) {
    const next = capped.length ? len + 2 + p.length : p.length
    if (next > CONTENT_CONTRACT.itemHighlights.max) break
    capped.push(p); len = next
  }
  // REFUSE, never truncate into a lie (Phase 1, H10/H11): nothing survived either net — the raw
  // `value` (H10, H11's old fallback) is never returned; a design that cannot net to a compliant
  // line is exactly as unshippable as one the composer never composed in the first place.
  // FIX ROUND 1: the reason distinguishes WHICH net emptied it — the repeat cap already dropped every
  // phrase (`kept.length === 0`, H10's class) vs. the repeat cap kept phrases but the length cap could
  // not fit even one of them (`kept.length > 0`, H11's class: a single phrase over budget on its own).
  if (capped.length === 0) {
    return { ok: false, reason: kept.length === 0 ? 'repeat-over-budget' : 'over-max' }
  }
  const joined = capped.join(', ')
  // REFUSE rather than amputate (Phase 1, H12; IMPORTANT 4, fix round 1): a drop that EITHER net
  // actually performed — the LENGTH net (`capped` shorter than `kept`) OR the REPEAT net (`kept`
  // shorter than the original phrase count) — must not silently land the survivor under
  // `CONTENT_CONTRACT.itemHighlights.min` (97 as of the 2026-09-08 "2+3" floor ruling; was 107).
  // Phase 1 scoped this floor check to the length-driven
  // drop only; the reviewer reproduced the same silent amputation reached via a REPEAT-only drop (a
  // 112-char, 5-phrase line whose repeat cap alone drops one "cotton" phrase, landing a 90-char
  // 4-phrase survivor — no length-driven drop ever occurred, so the old guard never fired). Scoped to
  // an ACTUAL drop on EITHER axis (never fires when every original phrase already survived both nets,
  // so a naturally-short-but-untouched value — not this net's job to floor-check, see
  // `classifyStoredIhLine` for the pre-flight floor gate on STORED lines — still passes through
  // unchanged as before).
  const lengthDropped = capped.length < kept.length
  const dropped = lengthDropped || kept.length < phrases.length
  if (dropped && joined.length < CONTENT_CONTRACT.itemHighlights.min) {
    return { ok: false, reason: 'under-floor' }
  }
  // R2 (finish-line-rulings.md, controller RULING, 2026-09-08): implement the spec's rule
  // LITERALLY — docs/superpowers/specs/2026-09-07-item-highlight-terminal-net.md says "the length
  // rule refuses rather than truncates", with no floor qualification. REPRODUCED (phase-1-final-
  // review-2.md IMPORTANT 2, scratchpad/finish-a/r2-truncate.ts): the check above scoped the
  // refusal to a survivor landing UNDER the floor — a length-driven amputation whose survivor
  // clears the floor (e.g. `itemHighlightBudget.test.ts`'s 142c fixture -> 118c survivor) still
  // shipped truncated as `{ok:true}` with no refusal, no signal. Any ACTUAL length-driven drop
  // (the length loop dropped at least one phrase the repeat net had already kept) is now refused
  // outright, whether or not the survivor clears the floor — "a truncated line is a line whose
  // meaning nobody chose" (the spec's own adversary section). Scoped to the LENGTH axis only, not a
  // repeat-only drop that never needed length trimming (`kept.length === capped.length`): today's
  // producer never emits >125 chars, so this is byte-identical on every real composed line — the
  // repeat cap's own defence-in-depth truncation (a distinct, pre-existing behaviour, unchanged
  // here) is not what this ruling named.
  if (lengthDropped && !opts?.allowLengthAmputation) {
    return { ok: false, reason: 'over-max' }
  }
  // IH TERMINAL NET, PHASE A: the moved content rules run on `joined` — the FINAL shipped bytes,
  // after every other stage (repeat cap, length cap, floor/amputation refusals) — never on the raw
  // candidate. This matches the spec's own requirement ("it runs on what is about to be written to
  // Amazon, after every other stage — not on candidate phrases") and, as important, keeps this
  // net's EXISTING diagnoses specific: a comma-less line the repeat or length cap alone already
  // reduces to zero phrases refuses with `repeat-over-budget`/`over-max` exactly as before — it
  // never reaches here, so it is never masked by the generic `sentence-shape` "must be at least 2
  // comma-separated phrases" rule. Safe defaults (see the block comment above `IhContentRuleReason`)
  // apply when `opts.contentCtx` is omitted — byte-identical on every real composed line (the
  // composer never emits these five violations to begin with).
  const contentViolation = ihFirstContentRuleViolation(joined, opts?.contentCtx)
  if (contentViolation) return { ok: false, reason: contentViolation }
  // IH TERMINAL NET, PHASE A (line-level truth): runs LAST of all, on `joined`, same "final shipped
  // bytes" discipline as the content-rule check above — so a comma-less line the repeat/length cap
  // alone already emptied is never masked by a truth diagnosis either. Skipped when the caller has
  // no ctx to check with (a generic push-boundary leaf); see the `truthCheck` doc above for why this
  // is injected rather than imported.
  if (opts?.truthCheck) {
    const truthVerdict = opts.truthCheck(joined)
    if (!truthVerdict.ok) return { ok: false, reason: truthVerdict.reason }
  }
  return { ok: true, value: joined }
}

/**
 * FIX ROUND 3 (I-1, controller RULING, phase-1-fix-round-3-findings.md): the ONE "heal an Item
 * Highlight value on serve" shape. The reviewer's Important 1 proved a scrub-bypass at
 * `listingPipeline.ts:10104-10113` (the verdict was taken on `scrubPub(line)`, but the PRE-scrub
 * value is what persisted on refusal — `scrubCelebrityNames` runs ONLY at that one choke point for
 * this field, so a refusal silently skipped it). `ai-recommendations/route.ts`'s two serve-path
 * heal-on-read sites (`:2208` broadcast, `:2262` per-child) carried the SAME shape — `r.ok ? r.value
 * : <pre-scrub>` — a THIRD copy of the exact bug class this repo keeps re-discovering per-site
 * instead of fixing once. This function is the single source: scrub ONCE, cap the SCRUBBED string,
 * and on refusal keep the SCRUBBED value — never the raw pre-scrub one, and never `''` for a
 * refusal (BLOCKING 2's own discipline). Empty/whitespace input is not a refusal; it stays ''.
 *
 * The broadcast site (`:2208`) never called `scrubTrademarks` at all before this fix (unlike title/
 * bullets/description/per-child, which all get a serve-time trademark heal elsewhere in the same
 * route) — adding it here closes that parity gap too, not just the bypass. Scrubbing is idempotent
 * and pure removal/substitution, so this is safe on every already-clean historical value.
 */
export function healItemHighlightOnServe(rawValue: string | null | undefined): string {
  if (!rawValue) return ''
  const scrubbed = scrubTrademarks(rawValue)
  const r = capItemHighlightRepeats(scrubbed)
  return r.ok ? r.value : scrubbed
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
  if (isItemHighlightsField(null, attr.spApiKey)) {
    // IH TERMINAL NET, PHASE A (2026-09-10, redoing the reverted feat/ih-phase23-wip Phase 2):
    // scrub trademarks + celebrity names AT THE ACTUAL PUSH BOUNDARY. Both scrubs were
    // generation-time only before this — the ONE celebrity door lived at listingPipeline.ts's
    // `scrubPub` — so a stale/pre-scrub-era stored value, or a refusal that let the pre-scrub value
    // persist, reached this function and Amazon's PATCH body untouched. Idempotent pure removal
    // (both functions are zero-import leaves), so already-clean content is unaffected; this is the
    // SAME order (`scrubCelebrityNames(scrubTrademarks(s))`) every other push-time scrub site in
    // this codebase already uses.
    const preScrubLen = trimmed.length
    trimmed = scrubCelebrityNames(scrubTrademarks(trimmed), `push:item-highlights:${attr.spApiKey}`)
    // A scrub that empties the whole line (the line WAS only a trademark/celebrity name) falls
    // through the SAME "nothing to patch" `[]` path this function already uses for empty input two
    // lines up — not `[{value:''}]`, the field-clearing defect this function already guards below.
    if (!trimmed) return []
    // BLOCKING 2 (opus review, finish-final-review.md, reproduced against feat/ih-phase23-wip @
    // c466225 unmodified: scratchpad probe repro-blocking2-under-floor-scrub.mts — a 109-char line
    // whose ONLY change is the scrub removing "Nike" ships as a 104-char PATCH body with ZERO
    // refusal). The scrub above is a length-REDUCING transform that runs OUTSIDE
    // `capItemHighlightRepeats`, so that net's own floor check — conditioned on a drop the net
    // itself performed — can never see scrub-driven shortening. Checked HERE, on whether THE SCRUB
    // itself carried a compliant line under the floor (never conditioned on any drop the net makes)
    // — never on the bare fact that the survivor is short: a value that was ALREADY under the floor
    // before the scrub ran (untouched by it) is `capItemHighlightRepeats`'s own documented case
    // (a naturally-short, untouched value passes unflagged — see that function's doc and
    // `itemHighlightOneRule.test.ts`/`blankBrandHighlightNet.test.ts`'s pinned short fixtures); this
    // is a NEW, narrower check for the one thing those fixtures never exercised: the SCRUB crossing
    // the floor on a line that was compliant before it ran.
    //
    // FIX ROUND 2 (RULING I-1): the per-child PERSIST net (listingPipeline.ts's `scrubPublished`)
    // used to run this SAME idea unconditionally on the survivor (`scrubbed.length < min`, no
    // preScrubLen gate at all) while its own comment claimed to mirror THIS check "exactly" — it
    // did not: measured, a 77-char, scrub-untouched, otherwise-compliant value SHIPPED here and was
    // HELD there. `capItemHighlightRepeats`'s own doc (and `itemHighlightOneRule.test.ts`/
    // `blankBrandHighlightNet.test.ts`'s T4.8 pin, a 94-char scrub-untouched value) requires a
    // naturally-short, untouched value to pass unflagged — an UNCONDITIONAL check breaks that pin,
    // which is why this seam's check has always been scrub-CROSSING-scoped, never unconditional.
    // The persist net is now narrowed to this EXACT predicate (same `preScrubLen`/floor shape) —
    // ONE predicate for both seams, per the ruling's preferred resolution, not a pinned difference.
    if (preScrubLen >= CONTENT_CONTRACT.itemHighlights.min && trimmed.length < CONTENT_CONTRACT.itemHighlights.min) return []
    // BLOCKING 3 (opus review, finish-final-review.md, reproduced: scratchpad probe
    // repro-blocking3-designseasons-blanket.mts): deliberately NO `contentCtx`/`truthCheck` passed
    // to the net below. This function is a pure leaf — no DB, no title, no design-name, no
    // spec/garmentFamily access — so it provably cannot resolve which occasion(s) this design is
    // about or its product facts. Passing `designSeasons: []` (the reverted branch's default)
    // asserts "this design is about NO occasion" and refuses a truthful on-season line (a live
    // Valentine design's own "Valentine" is its SUBJECT, not a seasonal claim) —
    // `ihContentRuleViolations`'s own contract (above) treats an OMITTED `designSeasons` as "no
    // signal, skip the off-season rule", never as "resolved to no occasion". Every caller that HAS
    // real context (the compose path via `deriveDesignSeasons`, the per-child persist net, the
    // Regen route via `seasonsIn`) passes it instead — this seam correctly omits rather than guesses.
    // R4/I2 (fix round 3, controller RULING on the opus review of Phase A): the SAME inability
    // extends to `capacityFamily`/`brandName` — this leaf has no DB, no sibling-children access, and
    // no brand config, so it provably cannot tell whether THIS SKU belongs to a multi-capacity
    // variation family or resolve a non-default seller brand either. Both stay on
    // `CapItemHighlightRepeatsOpts`'s safe defaults (`capacityFamily: false`, `brandName: 'THE CEO'`)
    // for the SAME reason `designSeasons` above is omitted rather than guessed: a caller that cannot
    // resolve a signal must never assert one. This is the ONE seam left on the defaults (the compose
    // path, the per-child persist net, and the Regen route all thread the real signal instead) — a
    // named, MEASURED gap, not a silent one: a genuinely multi-capacity family's stale/hand-edited
    // stored line can still ship a hardcoded capacity through here alone (17 new refusals vs
    // `150778c` overall, bytes3 probe; FILED as a follow-up, not fixed in this round).
    const netResult = capItemHighlightRepeats(trimmed)
    // BLOCKING 1 (controller RULING, fix round 1): a refusal must NEVER become `[{value:''}]`.
    if (!netResult.ok) return []
    trimmed = netResult.value
  }
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

/** TRUE when this value reads as empty for gap-counting purposes (mirrors the inline `isEmpty`
 *  arrows syncListingContent.ts / ai-recommendations/route.ts used to each define locally). */
export function isEmptyDetailValue(v: unknown): boolean {
  return !v || !String(v).trim()
}

/**
 * THE product-details GAP predicate — the SINGLE definition syncListingContent.ts's
 * fetchScoringContext AND the ai-recommendations route's live-rescore both call, closing the
 * "using the SAME predicate... keeps THIS regen's score == the next sync's" duplication the route's
 * own comment names (a hand-copied inline filter drifting between the two sites is exactly how the
 * #85 no-flip-flop invariant breaks).
 *
 * TRUE = this row docks the Features score (a real, closable gap). FALSE for three reasons:
 *   1. write-blocked (isWriteBlockedPreLaunch) — Amazon refuses the write; unrelated to content.
 *   2. HELD (`row.hold` set) AND the live value is empty — the deterministic producer refused to
 *      compose a truthful line (SILENT-HOLD class, 2026-09-04): the seller cannot close this by
 *      pushing harder, so it must not dock like a plain missing recommendation. Gated on
 *      current_value being empty (not recommended_value) — a `hold` that survived a downstream
 *      snap-back to a real accepted value (stickyDetails.ts) no longer describes an empty field and
 *      must NOT suppress a gap that no longer exists (current_value would be non-empty by then, so
 *      this branch never fires for it — the field is simply not a gap either way).
 *   3. otherwise: a true gap when the live value is empty, or an enum row whose current value is no
 *      longer a valid member of Amazon's live schema.
 */
export function isProductDetailGap(
  row: { field_name?: string | null; sp_api_key?: string | null; current_value?: unknown; is_enum?: boolean; enum_valid?: boolean; hold?: unknown },
  opts?: { apiSupported?: boolean | null },
): boolean {
  if (isWriteBlockedPreLaunch(row.field_name, row.sp_api_key, new Date(), opts)) return false
  const currentEmpty = isEmptyDetailValue(row.current_value)
  if (currentEmpty && row.hold != null) return false
  return currentEmpty || (row.is_enum === true && row.enum_valid === false)
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
