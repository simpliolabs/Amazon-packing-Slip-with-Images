/**
 * pushFields — pure, side-effect-free helpers shared by the push-content route
 * and its stress test. Keeping the field math out of the route makes it unit-
 * testable without mocking Amazon or Supabase.
 *
 * Four content fields can be pushed to Amazon via patchListingsItem:
 *   - title       → item_name           (BROADCAST: one value to every child SKU)
 *   - bullets     → bullet_point[]       (BROADCAST: a 5-value array to every child)
 *   - description → product_description   (BROADCAST)
 *   - keywords    → generic_keyword       (PER-CHILD: a unique value per SKU)
 *
 * "Broadcast" = parent-level content that must be IDENTICAL across all children,
 * so the single recommended value is written to every (ASIN-deduped) child.
 * "Per-child" = each color/size gets its own string (backend search terms).
 */

export type PushField = 'title' | 'bullets' | 'description' | 'keywords'

export const PUSH_FIELDS: PushField[] = ['title', 'bullets', 'description', 'keywords']

export interface FieldConfig {
  /** SP-API attribute name under /attributes/ */
  attribute: string
  /** true → same value to all children; false → per-child unique value */
  broadcast: boolean
  /** true → the value is a list (bullet_point); false → a single string */
  isArray: boolean
  /** human label for the UI / logs */
  label: string
  /** listing_content columns this field reads/writes for the cached "current" value */
  contentColumns: string[]
}

export const FIELD_CONFIG: Record<PushField, FieldConfig> = {
  title: {
    attribute: 'item_name',
    broadcast: true,
    isArray: false,
    label: 'Title',
    contentColumns: ['title'],
  },
  bullets: {
    attribute: 'bullet_point',
    broadcast: true,
    isArray: true,
    label: 'Bullets',
    contentColumns: ['bullet_1', 'bullet_2', 'bullet_3', 'bullet_4', 'bullet_5'],
  },
  description: {
    attribute: 'product_description',
    broadcast: true,
    isArray: false,
    label: 'Description',
    contentColumns: ['description'],
  },
  keywords: {
    attribute: 'generic_keyword',
    broadcast: false,
    isArray: false,
    label: 'Backend Keywords',
    contentColumns: ['backend_keywords'],
  },
}

export function isPushField(x: unknown): x is PushField {
  return typeof x === 'string' && (PUSH_FIELDS as string[]).includes(x)
}

// ─── byte helpers (keywords are byte-capped; titles/bullets/desc are char-capped) ──
export function getByteLength(str: string): number {
  return new TextEncoder().encode(str).length
}

/** Truncate to a byte budget on a word boundary (used for the 250-byte keyword cap). */
export function capBytes(str: string, maxBytes = 250): string {
  if (getByteLength(str) <= maxBytes) return str
  let lo = 0, hi = str.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (getByteLength(str.slice(0, mid)) <= maxBytes) lo = mid
    else hi = mid - 1
  }
  const cut = str.slice(0, lo)
  const lastSpace = cut.lastIndexOf(' ')
  return (lastSpace > lo * 0.7 ? cut.slice(0, lastSpace) : cut).trim()
}

/**
 * Defensive per-field caps. Amazon's VALIDATION_PREVIEW is the real gate; these
 * just keep us from sending pathological payloads. Limits mirror common apparel
 * category maxes (item_name ~200 chars, product_description ~2000, each bullet ~500,
 * generic_keyword 250 bytes).
 */
export function capForField(field: PushField, value: string): string {
  switch (field) {
    case 'keywords':    return capBytes(value.trim(), 250)
    case 'title':       return value.trim().slice(0, 200)
    case 'description': return value.trim().slice(0, 2000)
    case 'bullets':     return value.trim().slice(0, 500) // applied per-bullet
    default:            return value.trim()
  }
}

// ─── value resolution ──────────────────────────────────────────────────────────

export interface RecRow {
  recommended_title?: string | null
  recommended_bullets?: string[] | null
  recommended_description?: string | null
}

/**
 * The proposed value for one SKU, capped and cleaned.
 * Broadcast fields ignore `sku` (same value for everyone). Keywords look it up
 * in `perChild`. Returns null when there's nothing to push for this SKU/field.
 */
export function resolveProposed(
  field: PushField,
  rec: RecRow,
  perChild: Map<string, string>,
  sku: string,
): string | string[] | null {
  switch (field) {
    case 'keywords': {
      const v = perChild.get(sku)
      return v == null ? null : capBytes(v.trim(), 250)
    }
    case 'title': {
      const t = capForField('title', rec.recommended_title ?? '')
      return t.length > 0 ? t : null
    }
    case 'description': {
      const d = capForField('description', rec.recommended_description ?? '')
      return d.length > 0 ? d : null
    }
    case 'bullets': {
      const arr = Array.isArray(rec.recommended_bullets) ? rec.recommended_bullets : []
      const bullets = arr
        .map((b) => (b ?? '').trim())
        .filter((b) => b.length > 0)
        .slice(0, 5)
        .map((b) => capForField('bullets', b))
      return bullets.length > 0 ? bullets : null
    }
    default:
      return null
  }
}

/** Read one content row's current value for `field`, normalized to a string. */
export function currentValue(field: PushField, row: Record<string, unknown>): string {
  if (field === 'bullets') {
    return [row.bullet_1, row.bullet_2, row.bullet_3, row.bullet_4, row.bullet_5]
      .map((b) => (typeof b === 'string' ? b.trim() : ''))
      .filter(Boolean)
      .join('\n')
  }
  const col = FIELD_CONFIG[field].contentColumns[0]
  const v = row[col]
  return typeof v === 'string' ? v.trim() : ''
}

/** Normalize a proposed value (string or string[]) to a comparable/displayable string. */
export function asCompare(value: string | string[] | null): string {
  if (value == null) return ''
  return Array.isArray(value)
    ? value.map((v) => (v ?? '').trim()).filter(Boolean).join('\n')
    : value.trim()
}

// ─── Amazon patch body ───────────────────────────────────────────────────────────

export interface PatchValueEntry { value: string; marketplace_id: string; language_tag: string }

/**
 * Build the `value` array for a patchListingsItem /attributes/<x> replace op.
 * Single fields → one entry; bullets → one entry per non-empty bullet (order preserved).
 */
export function buildPatchValue(
  value: string | string[],
  marketplaceId: string,
  languageTag = 'en_US',
): PatchValueEntry[] {
  const vals = Array.isArray(value) ? value : [value]
  return vals
    .filter((v) => typeof v === 'string' && v.trim().length > 0)
    .map((v) => ({ value: v, marketplace_id: marketplaceId, language_tag: languageTag }))
}

// ─── ASIN dedup (FBA+FBM SKUs share one child ASIN → push once, prefer -FBA) ──────

export function dedupByAsin<T extends { sku: string; asin: string }>(rows: T[]): T[] {
  const byAsin = new Map<string, T>()
  for (const r of rows) {
    const existing = byAsin.get(r.asin)
    if (!existing || r.sku.endsWith('-FBA')) byAsin.set(r.asin, r)
  }
  return [...byAsin.values()].sort((a, b) => a.sku.localeCompare(b.sku))
}

// ─── cache-sync payload (what to write back to listing_content after a live push) ──

/** Map a pushed value to the listing_content column update for that field. */
export function cacheUpdateFor(field: PushField, value: string | string[]): Record<string, string | null> {
  if (field === 'bullets') {
    const arr = Array.isArray(value) ? value : [value]
    const out: Record<string, string | null> = {}
    for (let i = 0; i < 5; i++) out[`bullet_${i + 1}`] = arr[i] ?? null
    return out
  }
  const col = FIELD_CONFIG[field].contentColumns[0]
  return { [col]: Array.isArray(value) ? value.join('\n') : value }
}
