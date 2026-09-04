/**
 * perDesignItemHighlights.ts — the per-DESIGN Item Highlight storage shape + the push-seam value
 * map (pure, no I/O, no pipeline import — safe for pushExecutor, the routes and the page).
 *
 * PO RULING 2026-08-21 (B0DQ5YZH38 BD/BM/DQ/RIACG/RK): a multi-design family gets an Item Highlight
 * PER DESIGN. ONE broadcast line composed from one design's identity ("Beast Mode Shirt, …") is
 * false on every other design. Titles/bullets/descriptions already fan out per design
 * (per_child_titles / per_child_bullets / per_child_descriptions, migrations 017 + 033); this is the
 * SAME model for the IH: `per_child_item_highlights` (migration 060) — a JSONB array of one entry per
 * SKU, each carrying its design's line (or '' + a named hold), labeled with designName/designKey.
 *
 * REFINED THE SAME DAY (PO 2026-08-21, "Strip the design for MULTI design that is in the NAME/title"):
 * the family ships ONE SHARED line — design names stripped, every phrase rated >= 2 under EVERY
 * design (theme_fit_by_design, migration 061, min over designs). The storage shape is unchanged: the
 * shared line is written to EVERY entry (identical by construction), so the per-SKU push seam below
 * still resolves each SKU's "own" line; `collapseSharedIhRows` folds identical rows for the UI and
 * per-design rows render only if they ever differ.
 *
 * PUSH SAFETY (the invariant every seam enforces):
 *  - the broadcast IH detail row on a per-design family carries NO line (recommended_value '' and
 *    `per_design: true`), so nothing can broadcast one design's line to all;
 *  - the push builds the per-SKU value map from THIS array only (`buildPerSkuItemHighlightMap`);
 *    a SKU whose design has no composed line is SKIPPED with reason 'no-line-for-design' — it is
 *    never handed another design's line, and never the broadcast value.
 */
import { CONTENT_CONTRACT } from './contentContract'

/** Why an Item Highlight is HELD (the composer returned null). Each names ONE PO action.
 *  MOVED HERE (2026-09-04, closing the SILENT-HOLD defect class) from listingPipeline.ts: this
 *  module is pure/client-safe (no OpenAI import), so the type + message map can be read by the
 *  listing page (client component) without pulling the whole server-only pipeline (`import OpenAI
 *  from 'openai'`) into the browser bundle. listingPipeline.ts re-exports both names for every
 *  existing importer — this is a relocation, not a behavior change. */
export type IhHoldReason = 'unrated-pool' | 'thin-candidates' | 'under-floor' | 'no-spec' | 'designs-unrated'
export const IH_HOLD_MESSAGES: Record<IhHoldReason, string> = {
  'unrated-pool': 'Held: pool is unrated — run research/theme rating first',
  'thin-candidates': 'Held: too few truthful ranking phrases in the pool — harvest more keywords for this family',
  'under-floor': `Held: truthful phrases + blank facts cannot reach the ${CONTENT_CONTRACT.itemHighlights.min}-char floor — harvest more keywords for this family`,
  'no-spec': 'Held: no blank spec resolved for this family — set its blank (child SKU style code or a family override)',
  // Multi-design only (PO 2026-08-21): the shared line is a judgment under EVERY design, so it never
  // composes from a partial one. The PO action: POST keyword-pool/rerate { parent_asin, per_design: true }.
  'designs-unrated': 'Held: the pool is not rated against every design — run the per-design theme rating (keyword-pool/rerate { per_design: true }) first',
}

/** One entry per SKU — mirrors per_child_titles' {sku, asin, <field>, designName?, designKey?}. */
export interface PerChildItemHighlight {
  sku: string
  asin: string
  /** The design's composed line; '' when the design HOLDS (see `hold`). */
  item_highlight: string
  designName?: string | null
  designKey?: string | null
  /** Why the design has no line (composer hold). null/undefined when `item_highlight` is set. */
  hold?: IhHoldReason | null
  /** Write-through mirror of the last ACCEPTED push of this design's line (the per-design
   *  "✓ On Amazon" signal — the broadcast row's current_value cannot carry N lines). */
  pushed_value?: string | null
}

export const NO_LINE_FOR_DESIGN = 'no-line-for-design' as const

/** A compact one-row-per-design view of the stored array (first SKU of each design is representative). */
export interface PerDesignIhRow {
  designKey: string
  designName: string
  line: string
  hold: IhHoldReason | null
  skuCount: number
  /** TRUE when every SKU of the design has pushed_value === line (non-empty). */
  onAmazon: boolean
}

export function perDesignIhRows(entries: PerChildItemHighlight[] | null | undefined): PerDesignIhRow[] {
  if (!Array.isArray(entries)) return []
  const order: string[] = []
  const byKey = new Map<string, PerDesignIhRow & { allPushed: boolean }>()
  for (const e of entries) {
    const key = e.designKey || e.designName || e.sku
    let row = byKey.get(key)
    if (!row) {
      row = { designKey: key, designName: e.designName || e.designKey || e.sku, line: e.item_highlight || '', hold: e.hold ?? null, skuCount: 0, onAmazon: false, allPushed: true }
      byKey.set(key, row); order.push(key)
    }
    row.skuCount++
    if (!(e.item_highlight && e.pushed_value === e.item_highlight)) row.allPushed = false
  }
  return order.map((k) => { const r = byKey.get(k)!; const { allPushed, ...rest } = r; return { ...rest, onAmazon: allPushed && !!rest.line } })
}

/** A collapsed view: designs whose (line, hold) are IDENTICAL share one row. Under the shared-line
 *  ruling (PO 2026-08-21) every multi-design family collapses to ONE row "shared across N designs";
 *  the per-design capability stays — rows that ever differ render separately. */
export interface SharedIhRow {
  line: string
  hold: IhHoldReason | null
  designs: PerDesignIhRow[]
  skuCount: number
  /** TRUE when every SKU of every design in the row has the line on Amazon. */
  onAmazon: boolean
}

export function collapseSharedIhRows(rows: PerDesignIhRow[]): SharedIhRow[] {
  const order: string[] = []
  const byKey = new Map<string, SharedIhRow>()
  for (const r of rows) {
    const k = `${r.hold ?? ''}|${r.line}`
    let row = byKey.get(k)
    if (!row) { row = { line: r.line, hold: r.hold, designs: [], skuCount: 0, onAmazon: true }; byKey.set(k, row); order.push(k) }
    row.designs.push(r)
    row.skuCount += r.skuCount
    if (!(r.line && r.onAmazon)) row.onAmazon = false
  }
  return order.map((k) => byKey.get(k)!)
}

/** TRUE when the stored IH detail row is the per-design marker (no broadcast line by construction). */
export function isPerDesignIhRow(row: { per_design?: unknown } | null | undefined): boolean {
  return row?.per_design === true
}

/**
 * THE push-seam map: SKU → its OWN design's line. Resolution mirrors perChildValueResolver
 * (perDesign.ts): exact SKU first, then the ASIN (per_child_* is built from the FBA listing_content
 * rows, so an FBM twin SKU is absent by name but shares its sibling's ASIN — the same twin
 * resolution every other per-child push applies). A SKU whose design holds ('' line) or that
 * matches no entry is SKIPPED with 'no-line-for-design' — NEVER given another design's line.
 * The variation PARENT hub (asin === parentAsin) is skipped the same way: a hub has no design.
 */
export function buildPerSkuItemHighlightMap(
  entries: PerChildItemHighlight[] | null | undefined,
  targets: { sku: string; asin: string }[],
  parentAsin?: string | null,
): { values: Map<string, string>; skipped: { sku: string; asin: string; reason: typeof NO_LINE_FOR_DESIGN }[] } {
  const bySku = new Map<string, string>()
  const byAsin = new Map<string, string>()
  for (const e of Array.isArray(entries) ? entries : []) {
    const line = (e.item_highlight || '').trim()
    if (!line) continue                          // a HELD design contributes nothing — not even ''
    if (e.sku) bySku.set(e.sku, line)
    if (e.asin && !byAsin.has(e.asin)) byAsin.set(e.asin, line)
  }
  const values = new Map<string, string>()
  const skipped: { sku: string; asin: string; reason: typeof NO_LINE_FOR_DESIGN }[] = []
  for (const t of targets) {
    const isHub = !!parentAsin && t.asin === parentAsin && !bySku.has(t.sku)
    const line = isHub ? undefined : (bySku.get(t.sku) ?? (t.asin ? byAsin.get(t.asin) : undefined))
    if (line) values.set(t.sku, line)
    else skipped.push({ sku: t.sku, asin: t.asin, reason: NO_LINE_FOR_DESIGN })
  }
  return { values, skipped }
}

/** Stamp the write-through mirror on the entries whose SKU (or ASIN twin) just had `line` ACCEPTED. */
export function markPushedItemHighlights(
  entries: PerChildItemHighlight[] | null | undefined,
  accepted: { sku: string; asin?: string | null; value: string }[],
): { entries: PerChildItemHighlight[]; changed: boolean } {
  const arr = Array.isArray(entries) ? entries : []
  if (arr.length === 0 || accepted.length === 0) return { entries: arr, changed: false }
  const bySku = new Map(accepted.map((a) => [a.sku, a.value]))
  const byAsin = new Map<string, string>()
  for (const a of accepted) if (a.asin && !byAsin.has(a.asin)) byAsin.set(a.asin, a.value)
  let changed = false
  const out = arr.map((e) => {
    const v = bySku.get(e.sku) ?? (e.asin ? byAsin.get(e.asin) : undefined)
    if (!v || v !== (e.item_highlight || '').trim() || e.pushed_value === v) return e
    changed = true
    return { ...e, pushed_value: v }
  })
  return { entries: out, changed }
}

/**
 * The per-design MARKER row's `current_value` mirror. The Features scorer counts a detail row as a
 * gap while `current_value` is empty (syncListingContent.productDetailsGaps) and the marker row can
 * never carry a line — so once EVERY composed design's line is on Amazon the marker carries this
 * non-line status text (the gap closes); while any composed design is still unpushed it is null
 * (the gap stays open). Never a design line; never mistaken for one (no comma phrases).
 */
export function perDesignMarkerCurrent(entries: PerChildItemHighlight[] | null | undefined): string | null {
  const rows = perDesignIhRows(entries).filter((r) => !!r.line)
  if (rows.length === 0) return null
  return rows.every((r) => r.onAmazon) ? `per-design: ${rows.length}/${rows.length} design lines on Amazon` : null
}

