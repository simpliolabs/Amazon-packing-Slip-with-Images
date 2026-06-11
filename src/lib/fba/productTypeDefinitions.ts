/**
 * Amazon Product Type Definitions — accepted-value (enum) lookup.
 * ─────────────────────────────────────────────────────────────────────────────
 * Some listing attributes are CONSTRAINED ENUMS, not free text. E.g. apparel
 * `department` for a given product type only accepts {Unisex, Unisex Baby, Unisex
 * Kids} — pushing "Unisex Adult" gets rejected. The audit agent doesn't know the
 * per-productType vocabulary, so before pushing a product-detail value we fetch the
 * live schema from getDefinitionsProductType and coerce the value to an accepted one
 * (and report the accepted list so the seller can pick).
 *
 * Source of truth: we read Amazon's OWN schema rather than hardcoding an enum table
 * that drifts. Best-effort — any fetch/parse failure returns null and the caller
 * pushes the value as-is (prior behavior; VALIDATION_PREVIEW still guards the write).
 */

export interface AttributeEnum {
  /** The accepted `value` strings to send to SP-API (the schema's enum). */
  values: string[]
  /** Human-readable display names (enumNames), index-aligned with values when present. */
  names: string[]
  /** Deprecated `enum` values (the schema's `enumDeprecated`) — never recommend/coerce TO these.
   *  Amazon: "instances of deprecated enum values must be replaced with valid values." */
  deprecated: string[]
}

/** Result of validating one product-detail value against the live product-type schema. */
export interface DetailCoercion {
  /** The value to show + push: the exact accepted enum member, or the raw value for free-text. */
  value: string
  /** Accepted enum members (display labels), deprecated excluded. Empty for free-text attributes. */
  accepted: string[]
  /** True = safe to push: an exact enum member, OR a free-text attribute (VALIDATION_PREVIEW guards
   *  free-text byte-length/pattern at push time). False = a constrained enum the value can't map to. */
  valid: boolean
  /** True when this attribute is a constrained enum (dropdown); false = free-text input. */
  isEnum: boolean
  /** The original raw value when coercion changed it (e.g. "Unisex Adult" → "Unisex"). */
  normalizedFrom?: string
}

interface FetchOpts {
  token: string
  marketplaceId: string
  endpoint: string
  /** Optional — some product-type schemas are scoped to the seller. */
  sellerId?: string
}

// Process-lifetime cache of SUCCESSFUL schemas ONLY. A schema is large (100KB–1MB) and
// effectively static, so one fetch per (productType, marketplace) per server instance is
// plenty. We deliberately do NOT cache failures: a transient SP-API hiccup during container
// warmup must never poison every later push with a permanent null (that bug shipped first).
const _schemaCache = new Map<string, Record<string, unknown>>()

/** Diagnostics from a fetch attempt, surfaced by the ?debug=1 route branch. */
export interface SchemaFetchDebug {
  productType: string
  cached: boolean
  metaStatus: number | null
  hasSchemaLink: boolean
  schemaStatus: number | null
  topPropertyCount: number | null
  error: string | null
}

async function fetchProductTypeSchema(
  productType: string,
  opts: FetchOpts,
  debug?: SchemaFetchDebug,
): Promise<Record<string, unknown> | null> {
  const key = `${productType}|${opts.marketplaceId}`
  const cached = _schemaCache.get(key)
  if (cached) {
    if (debug) { debug.cached = true; debug.topPropertyCount = Object.keys((cached as { properties?: object }).properties ?? {}).length }
    return cached
  }

  let schema: Record<string, unknown> | null = null
  try {
    // 1) Metadata call returns a presigned link to the actual JSON Schema.
    const sellerParam = opts.sellerId ? `&sellerId=${encodeURIComponent(opts.sellerId)}` : ''
    const metaUrl =
      `${opts.endpoint}/definitions/2020-09-01/productTypes/${encodeURIComponent(productType)}` +
      `?marketplaceIds=${opts.marketplaceId}&requirements=LISTING&locale=en_US${sellerParam}`
    const metaResp = await fetch(metaUrl, { headers: { 'x-amz-access-token': opts.token } })
    if (debug) debug.metaStatus = metaResp.status
    if (metaResp.ok) {
      const meta = (await metaResp.json()) as { schema?: { link?: { resource?: string } } }
      const link = meta?.schema?.link?.resource
      if (debug) debug.hasSchemaLink = !!link
      if (link) {
        // 2) The schema lives on a presigned S3 URL — no auth header.
        const schemaResp = await fetch(link)
        if (debug) debug.schemaStatus = schemaResp.status
        if (schemaResp.ok) schema = (await schemaResp.json()) as Record<string, unknown>
      }
    } else {
      console.warn(`[productTypeDefinitions] getDefinitionsProductType ${productType} -> HTTP ${metaResp.status}`)
    }
  } catch (err) {
    if (debug) debug.error = err instanceof Error ? err.message : String(err)
    console.warn(`[productTypeDefinitions] schema fetch failed for ${productType}:`, err)
  }

  // Cache ONLY on success — never poison future calls with a transient null.
  if (schema) {
    _schemaCache.set(key, schema)
    if (debug) debug.topPropertyCount = Object.keys((schema as { properties?: object }).properties ?? {}).length
  }
  return schema
}

/** Find the accepted-value enum inside an attribute subschema. Amazon nests this differently
 *  across product types (array→items→properties.value.enum, oneOf wrappers, $defs-inlined, …),
 *  so we do a bounded DFS for ANY `enum` array — preferring one whose property key is `value`
 *  (the SP-API value field), reading its sibling `enumNames` for display labels. */
function extractEnum(node: unknown): AttributeEnum | null {
  let best: AttributeEnum | null = null      // enum found on a `value` property — preferred
  let fallback: AttributeEnum | null = null  // any other enum encountered
  const visit = (n: unknown, keyName: string, depth: number): void => {
    if (best || !n || typeof n !== 'object' || depth > 12) return
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const obj = n as Record<string, any>
    if (Array.isArray(obj.enum) && obj.enum.length) {
      const found: AttributeEnum = {
        values: obj.enum.map((v: unknown) => String(v)),
        names: Array.isArray(obj.enumNames) ? obj.enumNames.map((v: unknown) => String(v)) : [],
        deprecated: Array.isArray(obj.enumDeprecated) ? obj.enumDeprecated.map((v: unknown) => String(v)) : [],
      }
      if (keyName === 'value') { best = found; return }
      if (!fallback) fallback = found
    }
    if (Array.isArray(n)) { for (const item of n) visit(item, keyName, depth + 1) }
    else { for (const k of Object.keys(obj)) { if (k !== 'enum' && k !== 'enumNames') visit(obj[k], k, depth + 1) } }
  }
  visit(node, '', 0)
  return best || fallback
}

/** The accepted-value enum for one attribute of a product type, or null when the
 *  attribute is free-text / the schema is unavailable (caller pushes value as-is). */
export async function getAttributeEnum(
  productType: string,
  spApiKey: string,
  opts: FetchOpts,
): Promise<AttributeEnum | null> {
  const schema = await fetchProductTypeSchema(productType, opts)
  if (!schema) return null
  const props = (schema as { properties?: Record<string, unknown> }).properties
  if (!props) return null
  return extractEnum(props[spApiKey])
}

/** True if `spApiKey` is a real attribute in THIS product type's live schema. Apparel attrs
 *  (department, fit_type, fabric_type) are ABSENT on office/electronics product types — pushing one
 *  there 400s with "the provided attribute path is not valid", and recommending one creates an
 *  unfillable Features gap (a permanent dock the seller can never close). schema-unavailable →
 *  returns true (FAIL-OPEN: never block a legitimate push or drop a real field on a transient fetch error). */
export async function attributeExistsInSchema(
  productType: string,
  spApiKey: string,
  opts: FetchOpts,
): Promise<boolean> {
  const schema = await fetchProductTypeSchema(productType, opts)
  if (!schema) return true
  const props = (schema as { properties?: Record<string, unknown> }).properties
  if (!props) return true
  return Object.prototype.hasOwnProperty.call(props, spApiKey)
}

const SCHEMA_TITLE_QUALIFIERS = new Set(['item', 'product', 'total'])
/** Resolve a friendly attribute name ("Adhesive Type", "Package Quantity") to the REAL SP-API key for THIS
 *  product type by matching the live schema's property `title`s — so ANY category's attributes become
 *  pushable, not just the hardcoded apparel map (PO: "auto-map any item to the category's Features"). Match
 *  order: exact (squashed) → qualifier-strip ("Package Quantity" ≈ schema "Item Package Quantity") →
 *  UNAMBIGUOUS token-subset. Returns null on no/ambiguous match or schema-unavailable (FAIL-OPEN: caller
 *  falls back to the static map; an ambiguous guess is never made). */
export async function resolveSpApiKeyFromTitle(
  productType: string,
  friendlyName: string,
  opts: FetchOpts,
): Promise<{ spApiKey: string; title: string } | null> {
  const target = norm(friendlyName)
  if (!target) return null
  const schema = await fetchProductTypeSchema(productType, opts)
  const props = (schema as { properties?: Record<string, { title?: string }> } | null)?.properties
  if (!props) return null
  const entries = Object.entries(props)
  // 1. exact on squashed title OR squashed key.
  for (const [key, sub] of entries) {
    if (norm(sub?.title || '') === target || norm(key) === target) return { spApiKey: key, title: sub?.title || key }
  }
  // 2. qualifier-strip: drop a leading "Item/Product/Total" from the schema title, then exact-compare.
  for (const [key, sub] of entries) {
    const words = (sub?.title || '').toLowerCase().split(/[\s_-]+/).filter(Boolean)
    if (words.length > 1 && SCHEMA_TITLE_QUALIFIERS.has(words[0]) && norm(words.slice(1).join(' ')) === target) {
      return { spApiKey: key, title: sub?.title || key }
    }
  }
  // 3. unambiguous token-subset: friendly tokens ⊆ schema-title tokens, exactly ONE candidate (no guessing).
  const tWords = friendlyName.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 1)
  if (tWords.length) {
    const hits: { key: string; title: string }[] = []
    for (const [key, sub] of entries) {
      const titleWords = new Set((sub?.title || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean))
      if (titleWords.size && tWords.every((w) => titleWords.has(w))) hits.push({ key, title: sub?.title || key })
    }
    if (hits.length === 1) return { spApiKey: hits[0].key, title: hits[0].title }
  }
  return null
}

// Schema attributes that are NOT "Product Details" panel material: identity/content sections the
// tool manages elsewhere (title/bullets/description/keywords), structural/variation/offer keys,
// and image locators. Everything ELSE in the live schema is fair game for the audit's menu.
const MENU_EXCLUDE = new Set([
  'item_name', 'bullet_point', 'product_description', 'generic_keyword', 'brand', 'manufacturer',
  'external_product_id', 'externally_assigned_product_identifier', 'merchant_suggested_asin',
  'supplier_declared_has_product_identifier_exemption', 'item_type_keyword', 'item_type_name',
  'parentage_level', 'child_parent_sku_relationship', 'variation_theme', 'fulfillment_availability',
  'condition_type', 'condition_note', 'list_price', 'purchasable_offer', 'gift_options',
  'max_order_quantity', 'skip_offer', 'merchant_shipping_group', 'merchant_release_date',
  'product_tax_code', 'supplier_declared_dg_hz_regulation', 'batteries_required', 'batteries_included',
])
// Per-variant axes — each child differs, so one broadcast value would be WRONG for the family.
const MENU_PER_VARIANT = new Set(['color', 'size', 'memory_storage_capacity', 'style'])

/** The live schema's broadcast-pushable attributes (key + display title + accepted enum values) for
 *  the audit agent's dynamic Product-Details menu — so recommendations come FROM what THIS category
 *  actually accepts (adhesive_type, ruling_type, …) instead of an apparel-shaped guess list (PO:
 *  "offer up to 10 values that can improve the listing, dynamic per product category").
 *  Best-effort: [] on schema-unavailable (caller's prompt falls back to the legacy example list). */
export async function listPushableSchemaAttributes(
  productType: string | null | undefined,
  opts: FetchOpts,
  max = 14,
): Promise<{ key: string; title: string; accepted?: string[] }[]> {
  if (!productType) return []
  try {
    const schema = await fetchProductTypeSchema(productType, opts)
    const props = (schema as { properties?: Record<string, { title?: string }> } | null)?.properties
    if (!props) return []
    const out: { key: string; title: string; accepted?: string[] }[] = []
    for (const [key, sub] of Object.entries(props)) {
      if (MENU_EXCLUDE.has(key) || MENU_PER_VARIANT.has(key)) continue
      if (key.includes('image_locator')) continue   // main_product_image_locator, other_product_image_locator_1…
      const enumDef = extractEnum(sub)
      const dep = new Set((enumDef?.deprecated ?? []).map((d) => d.toLowerCase()))
      const accepted = enumDef
        ? (enumDef.names.length ? enumDef.names : enumDef.values).filter((_, i) => !dep.has(String(enumDef.values[i]).toLowerCase()))
        : []
      out.push({ key, title: (sub?.title || key.replace(/_/g, ' ')).trim(), accepted: accepted.length ? accepted : undefined })
      if (out.length >= max) break
    }
    // ALWAYS-INCLUDE: the Item Highlights attribute (July 27, 2026 companion to the 75-char title)
    // must make the menu whenever THIS schema has it — schema property ORDER decides the first `max`
    // slots, so without this the feature would silently never activate for categories where it lands
    // 15th+ (adversarial-review MAJOR). Amazon shipped the attribute EARLY under the key
    // `title_differentiation` (schema title "Item Highlight" — live-verified on SELF_STICK_NOTE
    // 2026-06-11); `item_highlights` kept in case other categories use the documented name.
    for (const mustKey of ['item_highlights', 'title_differentiation']) {
      if (!out.some((o) => o.key === mustKey) && Object.prototype.hasOwnProperty.call(props, mustKey)) {
        const sub = props[mustKey]
        const enumDef = extractEnum(sub)
        const dep = new Set((enumDef?.deprecated ?? []).map((d) => d.toLowerCase()))
        const accepted = enumDef
          ? (enumDef.names.length ? enumDef.names : enumDef.values).filter((_, i) => !dep.has(String(enumDef.values[i]).toLowerCase()))
          : []
        out.push({ key: mustKey, title: (sub?.title || mustKey.replace(/_/g, ' ')).trim(), accepted: accepted.length ? accepted : undefined })
      }
    }
    return out
  } catch (err) {
    console.warn(`[productTypeDefinitions] attribute menu failed for ${productType} (non-fatal):`, err instanceof Error ? err.message : err)
    return []
  }
}

/**
 * Validate ONE product-detail value against the live product-type schema. Shared by the
 * validate-at-recommendation step AND the push path (one source of truth, no drift). Dropdown (enum)
 * attributes are coerced to an EXACT accepted member ("Unisex Adult" → "Unisex"); a value that can't
 * map stays raw with valid:false so the caller surfaces `accepted` for the seller to pick. Free-text
 * attributes pass through (the push VALIDATION_PREVIEW guards byte-length/pattern). Best-effort: a
 * schema-fetch failure → treated as free-text pass-through, exactly the prior behavior.
 */
export async function coerceDetailValue(
  productType: string,
  spApiKey: string,
  rawValue: string,
  opts: FetchOpts,
): Promise<DetailCoercion> {
  const raw = (rawValue || '').trim()
  const enumDef = await getAttributeEnum(productType, spApiKey, opts)
  if (!enumDef || enumDef.values.length === 0) {
    return { value: raw, accepted: [], valid: true, isEnum: false }   // free-text (or schema unavailable)
  }
  const dep = new Set(enumDef.deprecated.map((d) => d.toLowerCase()))
  const accepted = (enumDef.names.length ? enumDef.names : enumDef.values)
    .filter((_, i) => !dep.has(String(enumDef.values[i]).toLowerCase()))
  // Gender/department carry free-form audiences ("Men, Women", "Unisex Adults") that aren't enum
  // prefixes — map them semantically first, then fall back to the generic coercion.
  const isGender = spApiKey === 'department' || spApiKey === 'target_gender'
  const coerced = (isGender ? coerceGenderToEnum(raw, enumDef) : null) ?? coerceToEnum(raw, enumDef)
  if (coerced.valid) {
    return { value: coerced.value, accepted, valid: true, isEnum: true, normalizedFrom: coerced.changed ? raw : undefined }
  }
  return { value: raw, accepted, valid: false, isEnum: true }   // uncoercible enum — seller picks from `accepted`
}

/** Diagnostics for the ?debug=1 route branch — pinpoints WHERE enum resolution fails
 *  (definitions HTTP status, presigned-schema status, attribute presence, extraction). */
export async function inspectProductTypeAttribute(
  productType: string,
  spApiKey: string,
  opts: FetchOpts,
): Promise<{ debug: SchemaFetchDebug; attrPresent: boolean; attrKeysSample: string[]; result: AttributeEnum | null }> {
  const debug: SchemaFetchDebug = {
    productType, cached: false, metaStatus: null, hasSchemaLink: false,
    schemaStatus: null, topPropertyCount: null, error: null,
  }
  const schema = await fetchProductTypeSchema(productType, opts, debug)
  const props = (schema as { properties?: Record<string, unknown> } | null)?.properties ?? null
  const attrPresent = !!props && Object.prototype.hasOwnProperty.call(props, spApiKey)
  const attrKeysSample = props
    ? Object.keys(props).filter((k) => /depart|gender|fit|sleeve|neck|closure|age|size|colou?r|material|style/i.test(k)).slice(0, 25)
    : []
  const result = props ? extractEnum(props[spApiKey]) : null
  return { debug, attrPresent, attrKeysSample, result }
}

/** Normalize for comparison: lowercase, strip spaces/dashes/underscores. */
function norm(s: string): string {
  return (s || '').toLowerCase().replace(/[\s_-]+/g, '')
}

export interface CoerceResult {
  /** True when `value` is an accepted enum entry (either unchanged or coerced). */
  valid: boolean
  /** The value to push: the accepted enum entry when valid, else the raw input. */
  value: string
  /** Accepted display values (enumNames when present, else the raw enum). */
  accepted: string[]
  /** True when coercion changed the input (e.g. "Unisex Adult" → "Unisex"). */
  changed: boolean
}

/**
 * Map a raw value to an accepted enum value.
 *  1. exact normalized match — handles ci-exact and "unisex-adult" vs "Unisex Adult".
 *  2. else the LONGEST accepted value that is a prefix of the input — an over-specified
 *     input like "Unisex Adult" collapses to the accepted base "Unisex".
 *  3. else invalid — the caller surfaces `accepted` so the seller can choose.
 */
export function coerceToEnum(raw: string, e: AttributeEnum): CoerceResult {
  // Exclude deprecated enum values — never coerce TO or display a value Amazon is retiring.
  const deprecated = new Set((e.deprecated ?? []).map(norm))
  const liveIdx = e.values.map((_, i) => i).filter((i) => !deprecated.has(norm(e.values[i])))
  const accepted = e.names.length ? liveIdx.map((i) => e.names[i] ?? e.values[i]) : liveIdx.map((i) => e.values[i])
  const rawN = norm(raw)
  if (!rawN) return { valid: false, value: raw, accepted, changed: false }

  // Candidate (normalized-token → canonical value) pairs from both values and names (deprecated skipped).
  const pairs: { token: string; value: string }[] = []
  liveIdx.forEach((i) => pairs.push({ token: norm(e.values[i]), value: e.values[i] }))
  liveIdx.forEach((i) => { if (e.names[i] != null) pairs.push({ token: norm(e.names[i]), value: e.values[i] }) })

  const exact = pairs.find((p) => p.token === rawN)
  if (exact) return { valid: true, value: exact.value, accepted, changed: exact.value !== raw }

  const prefixHits = new Set<string>()
  let best: { token: string; value: string } | null = null
  for (const p of pairs) {
    if (p.token && rawN.startsWith(p.token)) { prefixHits.add(p.value); if (!best || p.token.length > best.token.length) best = p }
  }
  // Only auto-coerce when the prefix match is UNAMBIGUOUS. "Cotton Blended" matching BOTH "Cotton" and
  // "Cotton Blend" must fall through to the whole-word check / picker, not silently pick the longest
  // (adversarial review: a silent wrong-coercion would bypass the seller-picker and ship LIVE).
  if (best && prefixHits.size === 1) return { valid: true, value: best.value, accepted, changed: best.value !== raw }

  // 3. else an accepted value that appears as a WHOLE-WORD token-subsequence INSIDE the input
  //    ("Unisex relaxed fit" -> "Relaxed" — the audit often puts the audience first, the real
  //    attribute second, so it isn't a prefix). Only when EXACTLY ONE accepted value matches — an
  //    ambiguous input ("slim relaxed feel" -> Slim AND Relaxed) stays invalid so the seller picks.
  //    (Found live 2026-06-09: prefix-only missed "Unisex relaxed fit".)
  const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean)
  const rawWords = words(raw)
  const isSub = (sub: string[], arr: string[]) => {
    if (!sub.length) return false
    for (let s = 0; s + sub.length <= arr.length; s++) if (sub.every((w, k) => arr[s + k] === w)) return true
    return false
  }
  const wordHits = new Set<string>()
  for (const i of liveIdx) {
    const cands = e.names[i] != null ? [e.values[i], String(e.names[i])] : [e.values[i]]
    if (cands.some((c) => isSub(words(c), rawWords))) wordHits.add(e.values[i])
  }
  if (wordHits.size === 1) { const v = [...wordHits][0]; return { valid: true, value: v, accepted, changed: v !== raw } }

  return { valid: false, value: raw, accepted, changed: false }
}

/**
 * Semantic gender/department coercion. The audit emits human audiences ("Men, Women", "Men and
 * Women", "Unisex Adults", "Boys") that are NOT string-prefixes of Amazon's gender enum, so the
 * generic coerceToEnum can't map them. Resolve by meaning: both genders / "unisex" → Unisex; a
 * single gender → Mens/Womens; with a kid/baby/boys/girls qualifier → the Kids/Baby/Boys/Girls
 * variant. Tries the most specific accepted label first and falls back toward the base. Returns
 * null when the value carries no gender signal (caller falls back to the generic coercion).
 */
export function coerceGenderToEnum(raw: string, e: AttributeEnum): CoerceResult | null {
  const accepted = e.names.length ? e.names : e.values
  const pick = (label: string): CoerceResult | null => {
    const hit = e.values.find((v) => v.toLowerCase() === label.toLowerCase())
    return hit ? { valid: true, value: hit, accepted, changed: hit !== raw } : null
  }
  const lc = ` ${raw.toLowerCase()} `
  const male = /\b(men|man|male|mens|boys?|guys?|gentlemen)\b/.test(lc)
  const female = /\b(women|woman|female|womens|girls?|ladies|gals?)\b/.test(lc)
  const unisex = /\bunisex\b/.test(lc) || (male && female)
  if (!male && !female && !unisex) return null
  const baby = /\b(baby|infant|infants|newborn|newborns)\b/.test(lc)
  const kids = /\b(kid|kids|child|children|youth|toddler|toddlers|junior|juniors)\b/.test(lc)
  const boys = /\bboys?\b/.test(lc)
  const girls = /\bgirls?\b/.test(lc)

  const tries: string[] = []
  if (unisex) {
    if (baby) tries.push('Unisex Baby')
    else if (kids) tries.push('Unisex Kids')
    tries.push('Unisex')
  } else if (male) {
    if (baby) tries.push('Baby Boys')
    if (baby || kids || boys) tries.push('Boys')
    tries.push('Mens', 'Men')
  } else if (female) {
    if (baby) tries.push('Baby Girls')
    if (baby || kids || girls) tries.push('Girls')
    tries.push('Womens', 'Women')
  }
  for (const t of tries) { const r = pick(t); if (r) return r }
  return null
}
