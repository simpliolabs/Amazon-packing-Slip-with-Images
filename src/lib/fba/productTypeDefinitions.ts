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
  const accepted = e.names.length ? e.names : e.values
  const rawN = norm(raw)
  if (!rawN) return { valid: false, value: raw, accepted, changed: false }

  // Candidate (normalized-token → canonical value) pairs from both values and names.
  const pairs: { token: string; value: string }[] = []
  e.values.forEach((v) => pairs.push({ token: norm(v), value: v }))
  e.names.forEach((nm, i) => { if (e.values[i] != null) pairs.push({ token: norm(nm), value: e.values[i] }) })

  const exact = pairs.find((p) => p.token === rawN)
  if (exact) return { valid: true, value: exact.value, accepted, changed: exact.value !== raw }

  let best: { token: string; value: string } | null = null
  for (const p of pairs) {
    if (p.token && rawN.startsWith(p.token) && (!best || p.token.length > best.token.length)) best = p
  }
  if (best) return { valid: true, value: best.value, accepted, changed: best.value !== raw }

  return { valid: false, value: raw, accepted, changed: false }
}
