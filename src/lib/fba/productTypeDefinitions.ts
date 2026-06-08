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
}

// Process-lifetime cache. A product-type schema is large (100KB–1MB) and effectively
// static; one fetch per (productType, marketplace) per server instance is plenty.
// `null` is cached too, so a missing/failed schema isn't re-fetched every push.
const _schemaCache = new Map<string, Record<string, unknown> | null>()

async function fetchProductTypeSchema(productType: string, opts: FetchOpts): Promise<Record<string, unknown> | null> {
  const key = `${productType}|${opts.marketplaceId}`
  if (_schemaCache.has(key)) return _schemaCache.get(key) ?? null

  let schema: Record<string, unknown> | null = null
  try {
    // 1) Metadata call returns a presigned link to the actual JSON Schema.
    const metaUrl =
      `${opts.endpoint}/definitions/2020-09-01/productTypes/${encodeURIComponent(productType)}` +
      `?marketplaceIds=${opts.marketplaceId}&requirements=LISTING&locale=en_US`
    const metaResp = await fetch(metaUrl, { headers: { 'x-amz-access-token': opts.token } })
    if (metaResp.ok) {
      const meta = (await metaResp.json()) as { schema?: { link?: { resource?: string } } }
      const link = meta?.schema?.link?.resource
      if (link) {
        // 2) The schema lives on a presigned S3 URL — no auth header.
        const schemaResp = await fetch(link)
        if (schemaResp.ok) schema = (await schemaResp.json()) as Record<string, unknown>
      }
    } else {
      console.warn(`[productTypeDefinitions] getDefinitionsProductType ${productType} -> HTTP ${metaResp.status}`)
    }
  } catch (err) {
    console.warn(`[productTypeDefinitions] schema fetch failed for ${productType}:`, err)
  }

  _schemaCache.set(key, schema)
  return schema
}

/** Walk an attribute subschema and pull the FIRST value-enum (+ optional enumNames).
 *  Handles the common shapes: array→items→properties.value.enum, properties.value.enum,
 *  enum directly on items / the node, and anyOf/oneOf/allOf wrappers. */
function extractEnum(node: unknown): AttributeEnum | null {
  if (!node || typeof node !== 'object') return null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const n = node as Record<string, any>

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const candidates: any[] = [n.items?.properties?.value, n.properties?.value, n.items, n]
  for (const c of candidates) {
    if (c && Array.isArray(c.enum) && c.enum.length) {
      return {
        values: c.enum.map((v: unknown) => String(v)),
        names: Array.isArray(c.enumNames) ? c.enumNames.map((v: unknown) => String(v)) : [],
      }
    }
  }
  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    if (Array.isArray(n[key])) {
      for (const sub of n[key]) { const r = extractEnum(sub); if (r) return r }
    }
  }
  if (n.items) { const r = extractEnum(n.items); if (r) return r }
  return null
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
