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

// SECOND tier (migration 028): the in-process map resets on every deploy, so the FIRST
// regen/push after each deploy re-downloaded every schema from SP-API. pt_schema_cache
// persists successful schemas across deploys: memory miss → DB (7-day TTL) → live fetch →
// write back to both. STRICTLY best-effort — a missing table or DB error falls through to
// the live fetch exactly as before; VALIDATION_PREVIEW remains the backstop for staleness.
const SCHEMA_DB_TTL_MS = 7 * 24 * 60 * 60 * 1000

async function readSchemaFromDb(key: string): Promise<Record<string, unknown> | null> {
  try {
    const { createAdminClient } = await import('@/lib/supabase/server')
    const supabase = await createAdminClient()
    const { data } = await supabase
      .from('pt_schema_cache')
      .select('schema, fetched_at')
      .eq('cache_key', key)
      .maybeSingle()
    const row = data as { schema?: Record<string, unknown>; fetched_at?: string } | null
    if (!row?.schema || !row.fetched_at) return null
    if (Date.now() - new Date(row.fetched_at).getTime() > SCHEMA_DB_TTL_MS) return null
    return row.schema
  } catch { return null }
}

async function writeSchemaToDb(key: string, schema: Record<string, unknown>): Promise<void> {
  try {
    const { createAdminClient } = await import('@/lib/supabase/server')
    const supabase = await createAdminClient()
    await supabase
      .from('pt_schema_cache')
      .upsert({ cache_key: key, schema, fetched_at: new Date().toISOString() } as never, { onConflict: 'cache_key' } as never)
  } catch { /* best-effort — next deploy just re-downloads */ }
}

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

  // Tier 2: persisted cache survives deploys (the in-process map above does not).
  const fromDb = await readSchemaFromDb(key)
  if (fromDb) {
    _schemaCache.set(key, fromDb)
    if (debug) { debug.cached = true; debug.topPropertyCount = Object.keys((fromDb as { properties?: object }).properties ?? {}).length }
    return fromDb
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
    await writeSchemaToDb(key, schema)
    if (debug) debug.topPropertyCount = Object.keys((schema as { properties?: object }).properties ?? {}).length
  }
  return schema
}

/** Evict a product type's schema from BOTH cache tiers (in-process map + pt_schema_cache row).
 *  SELF-HEALING hook: when Amazon's validator rejects EVERY calibrated write form for an
 *  attribute, the most likely systemic cause is a STALE cached schema (Amazon revised the
 *  attribute's sub-fields). The caller busts once, re-derives the shape from a fresh live
 *  fetch, and retries the calibration one time. Best-effort — a DB error only skips tier 2. */
export async function bustProductTypeSchemaCache(productType: string, marketplaceId: string): Promise<void> {
  const key = `${productType}|${marketplaceId}`
  _schemaCache.delete(key)
  try {
    const { createAdminClient } = await import('@/lib/supabase/server')
    const supabase = await createAdminClient()
    await supabase.from('pt_schema_cache').delete().eq('cache_key', key)
  } catch { /* best-effort — the live refetch is what matters */ }
}

/** The enum a property node carries: directly, OR inside an `anyOf`/`oneOf` member. The live
 *  SHIRT schema hides the Seller-Central form vocabulary this way — `sleeve.type.value` is
 *  anyOf:[{type:string},{enum:["Short Sleeve",...]}] — so an enum-blind read demoted the honored
 *  `type` sub-field to "bare string" and the DERIVED token field (`length_description`, which
 *  Amazon does NOT honor on writes) won every resolution: chips, coercion, and the write path all
 *  consistently targeted the wrong sub-field (the sleeve hard-reject, 2026-07). `viaUnion` marks
 *  the anyOf/oneOf case ("form field"-style: open string union with a recommended vocabulary). */
function propertyEnum(s: unknown): { def: AttributeEnum; viaUnion: boolean } | null {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const obj = s as Record<string, any>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const read = (o: Record<string, any>, viaUnion: boolean): { def: AttributeEnum; viaUnion: boolean } => ({
    def: {
      values: o.enum.map((v: unknown) => String(v)),
      names: Array.isArray(o.enumNames) ? o.enumNames.map((v: unknown) => String(v)) : [],
      deprecated: Array.isArray(o.enumDeprecated) ? o.enumDeprecated.map((v: unknown) => String(v)) : [],
    },
    viaUnion,
  })
  if (Array.isArray(obj.enum) && obj.enum.length) return read(obj, false)
  for (const unionKey of ['anyOf', 'oneOf'] as const) {
    const members = obj[unionKey]
    if (!Array.isArray(members)) continue
    for (const m of members) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mm = m as Record<string, any> | null
      if (mm && typeof mm === 'object' && Array.isArray(mm.enum) && mm.enum.length) return read(mm, true)
    }
  }
  return null
}

/** Find the accepted-value enum inside an attribute subschema. Amazon nests this differently
 *  across product types (array→items→properties.value.enum, oneOf wrappers, $defs-inlined, …),
 *  so we do a bounded DFS for ANY `enum` array — preferring one whose property key is `value`
 *  (the SP-API value field), reading its sibling `enumNames` for display labels. An enum carried
 *  by an anyOf/oneOf member counts as THIS property's enum (see propertyEnum), so `type.value`-
 *  style sub-fields are first-class hits instead of losing to a derived token field. */
function extractEnum(node: unknown): AttributeEnum | null {
  let best: AttributeEnum | null = null      // enum found on a `value` property — preferred
  let fallback: AttributeEnum | null = null  // any other enum encountered
  const visit = (n: unknown, keyName: string, depth: number): void => {
    if (best || !n || typeof n !== 'object' || depth > 12) return
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const obj = n as Record<string, any>
    const pe = propertyEnum(obj)
    if (pe) {
      if (keyName === 'value') { best = pe.def; return }
      if (!fallback) fallback = pe.def
    }
    if (Array.isArray(n)) { for (const item of n) visit(item, keyName, depth + 1) }
    else { for (const k of Object.keys(obj)) { if (k !== 'enum' && k !== 'enumNames') visit(obj[k], k, depth + 1) } }
  }
  visit(node, '', 0)
  return best || fallback
}

/** The accepted-value enum for one attribute of a product type, or null when the
 *  attribute is free-text / the schema is unavailable (caller pushes value as-is).
 *  UNIFIED SUB-FIELD RESOLUTION: the enum the chips/coercion see MUST be the enum of the SAME
 *  sub-field the write path targets, so both read analyzeDetailValueShape's pick — resolving
 *  them by two independent traversals is how they can drift (the sleeve wrong-sub-field bug).
 *  extractEnum stays as the fallback for nodes without a properties map (top-level enums). */
export async function getAttributeEnum(
  productType: string,
  spApiKey: string,
  opts: FetchOpts,
): Promise<AttributeEnum | null> {
  const schema = await fetchProductTypeSchema(productType, opts)
  if (!schema) return null
  const props = (schema as { properties?: Record<string, unknown> }).properties
  if (!props) return null
  const node = props[spApiKey]
  const shape = analyzeDetailValueShape(node)
  if (shape?.enumDef) return shape.enumDef
  return extractEnum(node)
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

/**
 * Container fallback for suffixed apparel attributes (the 8→1 product-detail collapse,
 * 2026-06-14). Amazon's modern apparel schema exposes CONTAINERS — `neck`, `sleeve`,
 * `closure` (titles "Neck"/"Sleeve"/"Closure") — whose array items hold the value, NOT
 * the flat `neck_style`/`sleeve_type`/`closure_type` keys the static map and the audit's
 * no-menu fallback sometimes produce. When such a flat key is ABSENT from the live schema
 * but its container (the key minus a trailing _style/_type/_description) IS present, return
 * the container so the caller keeps + pushes the attribute instead of dropping it.
 *
 * PURELY ADDITIVE: callers invoke this ONLY when the primary key is already missing from the
 * schema, so a product type that genuinely uses the flat key (it exists → no fallback needed,
 * caller never calls this) is never rerouted. Returns null when there's no valid container.
 */
export async function containerKeyFallback(
  productType: string,
  spApiKey: string,
  opts: FetchOpts,
): Promise<string | null> {
  const base = spApiKey.replace(/_(?:style|type|description)$/, '')
  if (base === spApiKey || !base) return null
  return (await attributeExistsInSchema(productType, base, opts)) ? base : null
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
  // package_contains_sku is a STRUCTURED per-SKU attribute (each child lists its own SKU+quantity) —
  // broadcasting one string to the family is wrong-shaped and Amazon rejects it (live-verified
  // 2026-06-11 on B0F86LPSHZ: 0/10 accepted). Never offer it on the audit menu.
  'package_contains_sku',
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
// SEO-bearing attribute keys buyers actually search/filter by — these lead the audit menu.
// Without ranking, the menu was "first 14 in SCHEMA order", which on SHIRT (157 props) spent
// slots on voltage/wattage while occasion/theme/pattern landed 15th+ and were never offered
// (PO: "Why only 4 extra values? are there no extra features that will help us rank better?").
const MENU_SEO_PRIORITY = /occasion|theme|pattern|special_feature|lifestyle|style_name|collar|neck|sleeve|closure|fit_type|material|fabric|care_instructions|age_range|target_gender|department|season|sport|character|team_name|league|item_type_name|top_style|weave|finish|shape/
// Compliance/electrical/logistics noise — real schema keys that never help a shopper find the
// product; they go LAST so they only appear when nothing better fills the menu.
const MENU_NOISE = /voltage|wattage|batter|compliance|regulat|warrant|hazmat|ghs|safety|unspsc|fcc_|dsa_|epr_|package_(?:weight|dimension|level|quantity)|item_(?:weight|dimension)|country_of_origin|manufacturer|external|gtin|upc|ean/

export async function listPushableSchemaAttributes(
  productType: string | null | undefined,
  opts: FetchOpts,
  max = 26,
): Promise<{ key: string; title: string; accepted?: string[] }[]> {
  if (!productType) return []
  try {
    const schema = await fetchProductTypeSchema(productType, opts)
    const props = (schema as { properties?: Record<string, { title?: string }> } | null)?.properties
    if (!props) return []
    const eligible = Object.entries(props).filter(([key]) =>
      !MENU_EXCLUDE.has(key) && !MENU_PER_VARIANT.has(key) && !key.includes('image_locator'))
    // SEO-bearing keys first, compliance noise last, schema order within each band.
    // NOISE tested FIRST: compliance_age_range contains "age_range" and must not
    // ride the SEO band (the unit test caught exactly this precedence).
    const band = (key: string): number => (MENU_NOISE.test(key) ? 2 : MENU_SEO_PRIORITY.test(key) ? 0 : 1)
    eligible.sort((a, b) => band(a[0]) - band(b[0]))
    const out: { key: string; title: string; accepted?: string[] }[] = []
    for (const [key, sub] of eligible) {
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

/**
 * COMPOSITE attribute value shape (the Neck/Closure/Sleeve no-op-push bug, 2026-06-12).
 * ─────────────────────────────────────────────────────────────────────────────
 * Apparel schemas don't expose `neck_style`/`closure_type`/`sleeve_type` as top-level
 * attributes — the live SHIRT schema (157 properties) only has the CONTAINERS `neck`,
 * `closure`, `sleeve`, whose array items hold sub-objects (the Seller Central form's
 * "Neck Style", "Closure Type", "Sleeve Type" fields). Pushing the flat
 * `[{value, marketplace_id, language_tag}]` shape into a container PASSES
 * VALIDATION_PREVIEW and gets ACCEPTED — then Amazon's processor silently drops it:
 * live-verified 0/89 SKUs carrying `neck`/`closure` hours after an accepted 157-SKU
 * push, while lastUpdatedDate moved (the submission processed, the value vanished).
 *
 * Fix: derive the value PATH from the attribute's own subschema (the same traversal
 * preference extractEnum uses — first `value`-keyed enum, else any enum, else a
 * `value`-named string property) and build the patch along it:
 *   neck   → path [neck_style, value] → [{ neck_style: {value, language_tag?}, marketplace_id? }]
 *   sleeve → path [type, value]       → [{ type: {value, language_tag?}, marketplace_id? }]
 * Simple attributes resolve to path [value] → callers keep the proven flat builder
 * (getDetailValueShape returns null for them — zero change to working pushes).
 */
export interface DetailValueShape {
  /** Property-key path from the attribute's array-item root to the value leaf,
   *  e.g. ['neck_style','value'] for SHIRT `neck`. Always non-empty. */
  path: string[]
  /** Index-aligned with `path`: the object CONTAINING path[i] also declares a
   *  language_tag sibling there (so the builder adds it at that level only). */
  languageTagAt: boolean[]
  /** Index-aligned with `path`: property path[i] is itself an ARRAY in the schema, so its
   *  content must be wrapped in `[ ]`. SHIRT `neck` = neck_style:[{value,language_tag}] —
   *  the sub-field is an array, not an object (live-verified from the raw schema 2026-06-12;
   *  the object form was rejected with InvalidInput on every SKU). */
  isArrayAt: boolean[]
  /** The attribute's item root declares marketplace_id (attached to the entry). */
  hasMarketplaceId: boolean
  /** This sub-field's OWN accepted vocabulary (a direct enum or an anyOf/oneOf member's — see
   *  propertyEnum). Absent = free-text sub-field. The write path coerces into THIS enum, so the
   *  value written always belongs to the sub-field it lands on. */
  enumDef?: AttributeEnum
  /** ALL value-bearing sub-field candidates of this attribute, THIS shape's sub-field first.
   *  A container can carry several (SHIRT sleeve: `type` + `cuff_style` + `length_description`)
   *  and Amazon honors only one on writes — the calibration probes them in this order. Present
   *  only on the shape returned for the attribute root; candidates themselves don't nest. */
  candidates?: DetailValueShape[]
}

/** Walk one attribute subschema and locate the value leaf + its property path.
 *  Preference order: (1) first enum under a property named `value` — direct OR carried by an
 *  anyOf/oneOf member (propertyEnum), (2) first enum under any property, (3) first string
 *  property named `value`. This pick IS the source of truth for the enum lookup too —
 *  getAttributeEnum returns the picked sub-field's enumDef, so the "AMAZON ACCEPTS" chips,
 *  the coercion, and the write path can never disagree about which sub-field they target.
 *  Exported for the ?debug route and shape tests; production callers use
 *  getDetailValueShape (which also applies the flat-attribute bypass). */
export function analyzeDetailValueShape(attrNode: unknown): DetailValueShape | null {
  type Hit = { shape: DetailValueShape; kind: 'valueEnum' | 'anyEnum' | 'valueString'; viaUnion: boolean }
  const hits: Hit[] = []
  let rootHasMarketplaceId = false
  let sawRootProps = false
  const visit = (n: unknown, path: string[], langs: boolean[], arrs: boolean[], depth: number): void => {
    if (!n || typeof n !== 'object' || depth > 12) return
    if (Array.isArray(n)) { for (const item of n) visit(item, path, langs, arrs, depth + 1); return }
    const obj = n as Record<string, unknown>
    const props = obj.properties as Record<string, unknown> | undefined
    if (props && typeof props === 'object') {
      // The FIRST properties map we meet is the array-item root — marketplace_id lives there.
      if (!sawRootProps) { sawRootProps = true; rootHasMarketplaceId = Object.prototype.hasOwnProperty.call(props, 'marketplace_id') }
      const hasLang = Object.prototype.hasOwnProperty.call(props, 'language_tag')
      for (const [key, sub] of Object.entries(props)) {
        // Plumbing keys never carry the attribute's value: ids/locale, and `unit` —
        // a measurement-unit enum ("inches") must not win the path over the real field.
        if (key === 'marketplace_id' || key === 'language_tag' || key === 'unit') continue
        const s = sub as Record<string, unknown> | null
        // Is this property itself an array (neck_style:[{value,language_tag}]) → wrap in [].
        const isArr = !!s && (s.type === 'array' || s.items != null)
        const nextPath = [...path, key]
        const nextLangs = [...langs, hasLang]
        const nextArrs = [...arrs, isArr]
        // Direct enum OR union-carried (anyOf/oneOf member) enum — see propertyEnum. Without the
        // union case, SHIRT sleeve's honored `type` sub-field read as a bare string and the
        // derived `length_description` token enum won the path (writes Amazon now hard-rejects).
        const pe = s && typeof s === 'object' ? propertyEnum(s) : null
        if (pe) {
          hits.push({ shape: { path: nextPath, languageTagAt: nextLangs, isArrayAt: nextArrs, hasMarketplaceId: false, enumDef: pe.def }, kind: key === 'value' ? 'valueEnum' : 'anyEnum', viaUnion: pe.viaUnion })
        } else if (s && typeof s === 'object' && key === 'value' && (s.type === 'string' || s.type == null)) {
          hits.push({ shape: { path: nextPath, languageTagAt: nextLangs, isArrayAt: nextArrs, hasMarketplaceId: false }, kind: 'valueString', viaUnion: false })
        }
        visit(sub, nextPath, nextLangs, nextArrs, depth + 1)
      }
      return
    }
    // Structural wrappers (items, oneOf/anyOf/allOf, …) — descend without extending the path.
    for (const k of Object.keys(obj)) {
      if (k === 'enum' || k === 'enumNames') continue
      visit(obj[k], path, langs, arrs, depth + 1)
    }
  }
  visit(attrNode, [], [], [], 0)
  const pick = hits.find((h) => h.kind === 'valueEnum') ?? hits.find((h) => h.kind === 'anyEnum') ?? hits.find((h) => h.kind === 'valueString')
  if (!pick) return null
  // CANDIDATES: every distinct value-bearing sub-field, the pick first. After the pick, union-
  // carried enums ("form field"-style — the kind Seller Central's editor reads) go before direct
  // token enums, schema declaration order within each band (Array.prototype.sort is stable).
  const seenPaths = new Set<string>([pick.shape.path.join(' ')])
  const rest = hits.filter((h) => {
    const k = h.shape.path.join(' ')
    if (seenPaths.has(k)) return false
    seenPaths.add(k)
    return true
  })
  rest.sort((a, b) => Number(b.viaUnion) - Number(a.viaUnion))
  const withMkt = (s: DetailValueShape): DetailValueShape => ({ ...s, hasMarketplaceId: rootHasMarketplaceId })
  const candidates = [pick, ...rest].map((h) => withMkt(h.shape))
  return { ...withMkt(pick.shape), candidates }
}

/** The schema-derived value shape for one attribute — or null when it's a plain
 *  flat attribute (path = [value]) / schema unavailable, in which case the caller
 *  keeps the legacy flat `{value, marketplace_id, language_tag}` builder verbatim. */
export async function getDetailValueShape(
  productType: string,
  spApiKey: string,
  opts: FetchOpts,
): Promise<DetailValueShape | null> {
  const schema = await fetchProductTypeSchema(productType, opts)
  const props = (schema as { properties?: Record<string, unknown> } | null)?.properties
  if (!props) return null
  const shape = analyzeDetailValueShape(props[spApiKey])
  if (!shape) return null
  // Flat attributes (Fit Type, Model Number, Package Quantity…) keep the battle-tested
  // legacy builder — the shaped path only engages for composites (neck/closure/sleeve…).
  if (shape.path.length === 1 && shape.path[0] === 'value') return null
  return shape
}

/** Build the patch entry along a composite path, wrapping array-typed segments in `[ ]`:
 *  ['neck_style','value'] isArrayAt [true,false] + "Crew Neck"
 *    → [{ neck_style: [{ value: "Crew Neck", language_tag }], marketplace_id }] */
export function buildShapedDetailValue(
  shape: DetailValueShape,
  rawValue: string,
  marketplaceId: string,
  languageTag = 'en_US',
): Record<string, unknown>[] {
  let inner: unknown = rawValue
  for (let i = shape.path.length - 1; i >= 0; i--) {
    const wrapper: Record<string, unknown> = { [shape.path[i]]: shape.isArrayAt[i] ? [inner] : inner }
    if (shape.languageTagAt[i]) wrapper.language_tag = languageTag
    inner = wrapper
  }
  const entry = inner as Record<string, unknown>
  if (shape.hasMarketplaceId) entry.marketplace_id = marketplaceId
  return [entry]
}

/** Every plausible write-form for a composite value, most-likely first. Reading the schema
 *  statically guessed WRONG on SHIRT `neck` (live 2026-06-12: the derived
 *  {neck_style:{value,language_tag}} form drew "The provided value for 'neck' is invalid"
 *  on every SKU — schemas express the same sub-field as {value,language_tag} objects, bare
 *  enum strings, or oneOf unions of both). So the push CALIBRATES instead of guessing: it
 *  tries these on the FIRST SKU in VALIDATION_PREVIEW (no write happens) and uses the form
 *  Amazon validates. The flat legacy form is deliberately ABSENT for composites — it
 *  validates and then silently no-ops (the #204 discovery), the one failure mode
 *  calibration must never pick. */
export function buildShapedDetailValueVariants(
  shape: DetailValueShape,
  rawValue: string,
  marketplaceId: string,
  languageTag = 'en_US',
): { id: string; value: Record<string, unknown>[] }[] {
  const out: { id: string; value: Record<string, unknown>[] }[] = []
  // PER-SUB-FIELD candidates (the sleeve fix): each candidate sub-field emits its own variant
  // set carrying ITS OWN coerced enum member — display "Short Sleeve" into `type`, token
  // "short_sleeve" into `length_description` (coerceToEnum maps display->token via enumNames;
  // when values==names it degenerates to an exact match). A candidate whose vocabulary can't
  // host the value is SKIPPED (never write a non-member); when none can host it (free-text
  // sub-fields, or a placeholder like the ?debug probe), the primary shape passes the raw
  // value through exactly as before.
  const candidates = shape.candidates?.length ? shape.candidates : [shape]
  const targets: { cand: DetailValueShape; value: string; sub: string }[] = []
  for (const cand of candidates) {
    const sub = cand.path.join('.')
    if (cand.enumDef && cand.enumDef.values.length) {
      const c = coerceToEnum(rawValue, cand.enumDef)
      if (c.valid) targets.push({ cand, value: c.value, sub })
    } else {
      targets.push({ cand, value: rawValue, sub })
    }
  }
  if (targets.length === 0) targets.push({ cand: candidates[0], value: rawValue, sub: candidates[0].path.join('.') })

  for (const { cand, value, sub } of targets) {
    // Every id is SUB-FIELD-QUALIFIED (e.g. "type.value:shaped") so a cached winning id stays
    // unambiguous regardless of candidate ORDER — the live-listing hint can reorder candidates
    // between calibrations, and an order-relative id would silently cross to another sub-field.
    const idFor = (base: string) => `${sub}:${base}`
    out.push({ id: idFor('shaped'), value: buildShapedDetailValue(cand, value, marketplaceId, languageTag) })
    if (cand.languageTagAt.some(Boolean)) {
      const noLang: DetailValueShape = { ...cand, languageTagAt: cand.languageTagAt.map(() => false) }
      out.push({ id: idFor('shaped-no-lang'), value: buildShapedDetailValue(noLang, value, marketplaceId, languageTag) })
    }
    if (cand.path.length > 1 && cand.path[cand.path.length - 1] === 'value') {
      // The sub-field carrying the BARE value (array-aware): [{ neck_style: ["Crew Neck"], marketplace_id }]
      const direct: DetailValueShape = {
        path: cand.path.slice(0, -1),
        languageTagAt: cand.languageTagAt.slice(0, -1).map(() => false),
        isArrayAt: cand.isArrayAt.slice(0, -1),
        hasMarketplaceId: cand.hasMarketplaceId,
      }
      out.push({ id: idFor('direct-leaf'), value: buildShapedDetailValue(direct, value, marketplaceId, languageTag) })
    }
    // OBJECT fallback: the same path WITHOUT array-wrapping any segment — for product types
    // whose composite sub-field is a plain object, not an array. Cheap insurance; calibration
    // picks whichever Amazon validates.
    if (cand.isArrayAt.some(Boolean)) {
      const noArr: DetailValueShape = { ...cand, isArrayAt: cand.isArrayAt.map(() => false) }
      out.push({ id: idFor('no-array'), value: buildShapedDetailValue(noArr, value, marketplaceId, languageTag) })
    }
  }
  const seen = new Set<string>()
  return out.filter((v) => { const k = JSON.stringify(v.value); if (seen.has(k)) return false; seen.add(k); return true })
}

/** The RAW subschema node for one attribute — the ?debug=2 ground-truth view (read-only). */
export async function getAttributeSubschema(
  productType: string,
  spApiKey: string,
  opts: FetchOpts,
): Promise<unknown> {
  const schema = await fetchProductTypeSchema(productType, opts)
  return (schema as { properties?: Record<string, unknown> } | null)?.properties?.[spApiKey] ?? null
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
