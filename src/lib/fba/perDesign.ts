// Hoisted to src/lib/fba/designName.ts so the listingPipeline content-anchor loop and the
// PerDesignCard share ONE garment-color test + designKey→label derivation. Re-exported here so
// existing callers (#291) import them from this module unchanged.
import { BASIC_COLOR_RE, commonDesignPrefix, titleCaseToken, deriveDesignLabel, isGarmentColor } from './designName'
export { commonDesignPrefix, titleCaseToken, deriveDesignLabel, isGarmentColor }

export interface PerDesignGroup {
  designKey: string; designName: string; skus: string[]
  title: string; bullets: string[]; description: string
}
type TitleE = { sku: string; asin: string; title: string; designName?: string | null; designKey?: string | null }
type BulletE = { sku: string; asin: string; bullets: string[]; designKey?: string | null }
type DescE  = { sku: string; asin: string; description: string; designKey?: string | null }

// ── Per-design LABEL derivation (pure, no I/O) — see ./designName ──────────
/** Trust a resolved designName ONLY when it is a REAL resolution (not the key fallback), not a bare
 *  garment color, and distinct within the family — otherwise the designKey-derived label is better. */
function resolvedUsable(name: string, key: string, familyResolved: string[]): boolean {
  const n = (name || '').trim()
  if (!n || n === key) return false               // empty, or the e.designName||key fallback below
  if (BASIC_COLOR_RE.test(n)) return false        // 'Black' etc. = literal shirt color, useless label
  const lc = n.toLowerCase()
  return familyResolved.filter((x) => (x || '').trim().toLowerCase() === lc).length === 1 // distinct
}

/** Multi-DESIGN iff >=2 distinct designKeys among per-child titles. (designName can resolve empty
 *  for a real group, so it is NOT a reliable discriminator — capacity families have no designKey.) */
export function isMultiDesign(titles?: TitleE[] | null): boolean {
  if (!Array.isArray(titles)) return false
  return new Set(titles.filter((t) => t.designKey).map((t) => t.designKey as string)).size >= 2
}

/** Resolve whether a family is multi-design FOR GATING PURPOSES (e.g. the style-leak push gate). The
 *  seller's manual "Multi Design" override is AUTHORITATIVE over the SKU auto-detector, in BOTH directions:
 *  true = force multi, false = force single (consistent with how force-single already broadcasts every
 *  other parent-shared attribute), falling back to the per_child_titles heuristic when the override is
 *  unset (null/undefined). Single source of truth so the per-row menu, the bulk set, and the server gate
 *  agree by construction. NOTE: this is the GATE question ("what did the seller declare?"), distinct from
 *  the DISPLAY question ("does per-design content exist yet?", which stays isMultiDesign(per_child_titles)
 *  because there is nothing to show until the next regen rewrites the titles). */
export function resolveMultiDesign(titles: TitleE[] | null | undefined, override: boolean | null | undefined): boolean {
  if (override === true) return true
  if (override === false) return false
  return isMultiDesign(titles)
}

/**
 * Build a per-SKU value resolver for a per_child_* array (titles / bullets / descriptions).
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * This is the ONE model that must drive every READ surface (VARIANT COHESION counts, the EDIT-ONCE
 * label, the per-design verify chip) so they agree with the SHIP ENGINE, which already resolves each
 * SKU's own value via `resolveProposed`'s per_child preference (pushFields.ts). Returns `null` when the
 * family is not per-child (≤1 row) so the caller falls back to the broadcast value — i.e. single-design
 * families keep the exact old broadcast behavior. Non-null for BOTH capacity families (per-child GB) and
 * multi-design families (per-design copy). Includes an ASIN fallback because per_child_* is built from
 * the FBA `listing_content`, so an FBM twin SKU is absent from `bySku` but shares its sibling's ASIN —
 * the same twin resolution the push applies. Returns `undefined` for a SKU with no per-child match so the
 * caller can `?? broadcast`.
 */
export function perChildValueResolver<T extends { sku: string; asin?: string | null }>(
  rows: T[] | null | undefined,
  pick: (r: T) => string,
): ((sku: string, asin?: string | null) => string | undefined) | null {
  if (!Array.isArray(rows) || rows.length <= 1) return null
  const bySku = new Map<string, string>()
  const byAsin = new Map<string, string>()
  for (const r of rows) {
    const v = pick(r)
    if (r.sku) bySku.set(r.sku, v)
    if (r.asin && !byAsin.has(r.asin)) byAsin.set(r.asin, v)
  }
  return (sku, asin) => bySku.get(sku) ?? (asin ? byAsin.get(asin) : undefined)
}

/** Distinct per-DESIGN entries from a per_child_* array (one row per designKey — the first SKU of each
 *  group is representative), for a compact "one per design" display instead of one row per SKU. Falls
 *  back to the sku when a row has no designName. */
export function perDesignEntries<T extends { sku: string; designKey?: string | null; designName?: string | null }>(
  rows: T[] | null | undefined,
  pick: (r: T) => string,
): { label: string; sku: string; value: string }[] {
  if (!Array.isArray(rows)) return []
  const seen = new Set<string>()
  const out: { label: string; sku: string; value: string }[] = []
  for (const r of rows) {
    const key = r.designKey || r.sku
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ label: r.designName || r.designKey || r.sku, sku: r.sku, value: pick(r) })
  }
  return out
}

/** Cluster SKU-keyed entries into one group per designKey. All SKUs of a design share content,
 *  so the first entry is representative. designName falls back to designKey when empty so a
 *  name-resolution miss never hides a real design. bullets/description may be empty (absent set);
 *  the caller falls back to the broadcast recommended_* in that case. */
export function groupByDesign(titles?: TitleE[] | null, bullets?: BulletE[] | null, descriptions?: DescE[] | null, overridesByKey?: Record<string, string>): PerDesignGroup[] {
  const t = Array.isArray(titles) ? titles : []
  const bulletsBySku = new Map((Array.isArray(bullets) ? bullets : []).map((x) => [x.sku, x.bullets]))
  const descBySku = new Map((Array.isArray(descriptions) ? descriptions : []).map((x) => [x.sku, x.description]))
  const order: string[] = []
  const groups = new Map<string, PerDesignGroup>()
  for (const e of t) {
    const key = e.designKey || ''
    if (!key) continue // capacity/single/broadcast entry — no design
    let g = groups.get(key)
    if (!g) {
      g = { designKey: key, designName: e.designName || key, skus: [], title: e.title, bullets: bulletsBySku.get(e.sku) ?? [], description: descBySku.get(e.sku) ?? '' }
      groups.set(key, g); order.push(key)
    }
    g.skus.push(e.sku)
  }
  const built = order.map((k) => groups.get(k)!)
  // Family-wide LABEL pass: decide ONCE for the whole family so one design's color-collision can't
  // mix 'Argentina' with 'Black'. Keep the resolved designName ONLY when EVERY group's resolved name
  // is usable (real, non-color, distinct) — preserving good names like 'Only Fins'/'Fish Hard Or Stay
  // Home'. Otherwise derive every label from the designKey (FIFA: resolved collapses to the garment
  // color 'Black' -> 'Argentina'/'Brazil' from the key). designKey-derived is opaque only for
  // separator-less codes (FHOSH -> 'Fhosh'); a per-design user override (Part 2) covers those.
  const allKeys = built.map((g) => g.designKey)
  const familyResolved = built.map((g) => g.designName) // resolved-or-key from the loop above
  const allResolvedUsable = built.length > 0 && built.every((g) => resolvedUsable(g.designName, g.designKey, familyResolved))
  for (const g of built) {
    g.designName = allResolvedUsable
      ? g.designName
      : (deriveDesignLabel(g.designKey, allKeys) || g.designName || g.designKey)
  }
  // Per-design SELLER override (migration 034) is the HIGHEST-priority label — it wins over both the
  // resolved name and the designKey-derived label, so the card relabels instantly with the seller's
  // chosen name. Absent param / empty value → keep the derived label above (no behavior change).
  if (overridesByKey) {
    for (const g of built) {
      const ov = overridesByKey[g.designKey]
      if (ov && ov.trim()) g.designName = ov.trim()
    }
  }
  return built
}
