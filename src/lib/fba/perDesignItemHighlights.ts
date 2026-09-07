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
 * REFINED (PO ruling 2026-09-06, replacing the 2026-08-21 "one shared line" model — Minor #10/#11,
 * final fix wave): the family ships ONE LINE PER DESIGN — each design composes against its OWN
 * theme-fit rating (theme_fit_by_design, migration 061), never a minimum over siblings, and every
 * OTHER design's name/identity is foreign to it, never its own. The storage shape is unchanged: one
 * entry per SKU, each carrying ITS OWN design's line (no longer identical by construction); the
 * per-SKU push seam below still resolves each SKU's "own" line; `collapseSharedIhRows` folds rows
 * whose (line, hold) happen to be byte-identical for the UI — ordinarily every design differs, so
 * rows render separately; the degenerate case (a single-group family, or every design held) still
 * collapses to one row.
 *
 * PUSH SAFETY (the invariant every seam enforces):
 *  - the broadcast IH detail row on a per-design family carries NO line (recommended_value '' and
 *    `per_design: true`), so nothing can broadcast one design's line to all;
 *  - the push builds the per-SKU value map from THIS array only (`buildPerSkuItemHighlightMap`);
 *    a SKU whose design has no composed line is SKIPPED with reason 'no-line-for-design' — it is
 *    never handed another design's line, and never the broadcast value.
 */
import { CONTENT_CONTRACT } from './contentContract'
// FIX WAVE 2 (I-2b, 2026-09-06): the composer's OWN fold/repeat check — reused verbatim at the push
// seam rather than a second tokenizer (coherence INVARIANT 1). No cycle: itemHighlightComposer.ts
// never imports this module.
import { lineHasSignificantRepeat } from './itemHighlightComposer'

/** Why an Item Highlight is HELD (the composer returned null). Each names ONE PO action.
 *  MOVED HERE (2026-09-04, closing the SILENT-HOLD defect class) from listingPipeline.ts: this
 *  module is pure/client-safe (no OpenAI import), so the type + message map can be read by the
 *  listing page (client component) without pulling the whole server-only pipeline (`import OpenAI
 *  from 'openai'`) into the browser bundle. listingPipeline.ts re-exports both names for every
 *  existing importer — this is a relocation, not a behavior change. */
export type IhHoldReason = 'unrated-pool' | 'thin-candidates' | 'under-floor' | 'no-spec' | 'designs-unrated' | 'under-floor-no-repeat'
export const IH_HOLD_MESSAGES: Record<IhHoldReason, string> = {
  'unrated-pool': 'Held: pool is unrated — run research/theme rating first',
  'thin-candidates': 'Held: too few truthful ranking phrases in the pool — harvest more keywords for this family',
  'under-floor': `Held: truthful phrases + blank facts cannot reach the ${CONTENT_CONTRACT.itemHighlights.min}-char floor — harvest more keywords for this family`,
  'no-spec': 'Held: no blank spec resolved for this family — set its blank (child SKU style code or a family override)',
  // Multi-design only (PO ruling 2026-09-06, replacing the 2026-08-21 "one shared line" model —
  // Minor #10/#11, final fix wave): each design composes against its OWN rated share; a design
  // whose OWN column is thin HOLDS in isolation — siblings with a healthy rating compose
  // independently, never blocked by this one. The PO action is unchanged: POST keyword-pool/rerate
  // { parent_asin, per_design: true } (it rates every design's column at once, so it also clears any
  // sibling that was separately unrated).
  'designs-unrated': 'Held: this design\'s own rating share is too thin — run the per-design theme rating (keyword-pool/rerate { per_design: true }) first',
  // TASK 6 (2026-09-06, PO verbatim "2. No Repeat as per Amazon Ruules"): distinct from `under-floor`
  // — a repeat WOULD reach the floor here, but the PO's ruling forbids composing one absolutely
  // (stricter than Amazon's own ≤2 cap), so the composer never tries. Never a silently shortened line
  // and never a repeat to reach the floor — the design HOLDS and names the same PO action as
  // `under-floor` (more/varied keywords let Tier A alone reach the floor).
  // FIX ROUND 1 (#1, 2026-09-06): the ORIGINAL wiring named this stage the moment a Tier-B candidate
  // merely fit the remaining character budget — not when a repeat would truly have crossed the floor
  // (reproduced: a 4-phrase pool whose best repeat-permitting reach was 53 chars, far under 107,
  // still got this exact message). `itemHighlightComposer.ts`'s `shadowRepeatReachesFloor` gates this
  // stage on a deterministic check that a repeat-permitting selection actually reaches
  // `CONTENT_CONTRACT.itemHighlights.min` before this reason (and this message) can be returned.
  // FIX WAVE 2 (I-1, 2026-09-06 final whole-branch review #2): that shadow check was still an
  // APPROXIMATION — it ignored Amazon's own ≤2-per-word cap and the composer's 7-pick cap, so it
  // could answer "reachable" using a repeat-permitting combination the real selection loop, even
  // with repeats allowed, could never actually admit (reproduced: the `summer` pool and the 8-phrase
  // pick-cap pool in itemHighlightComposer.test.ts). The shadow now calls `admitCandidate` — the
  // real loop's OWN per-candidate admission gate (tier, pick cap, budget, ≤2 cap, brand-once), with
  // `allowRepeat: true` — so it inherits every one of those rules BY CONSTRUCTION, not as a second,
  // separately-maintained model of them. The claim below is now guaranteed true (the one thing still
  // not modeled, garment-surface-variety ordering, only ever affects WHICH phrases compose, never
  // whether the floor is reachable at all — see the comment on `admitCandidate`).
  'under-floor-no-repeat': `Held: truthful phrases + blank facts reach the ${CONTENT_CONTRACT.itemHighlights.min}-char floor only by repeating a significant word, which is never allowed (PO ruling 2026-09-06) — rate/harvest more keywords for this family`,
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
/** FIX WAVE 2 (I-2b, 2026-09-06, controller RULING): the ruling was enforced at GENERATION only
 *  (itemHighlightComposer.ts Task 6) — a line stored before it shipped, or written by any future
 *  producer bug or manual edit, could still carry a repeated significant word. `NO_LINE_FOR_DESIGN`
 *  names "no line exists"; this names the distinct case "a line exists but the push seam — the LAST
 *  pure function before Amazon — refuses to ship it". */
export const REPEAT_IN_STORED_LINE = 'repeat-in-stored-line' as const
export type IhSkuSkipReason = typeof NO_LINE_FOR_DESIGN | typeof REPEAT_IN_STORED_LINE

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
 *
 * FIX WAVE 2 (I-2b, 2026-09-06): a resolved line that repeats a folded significant word is ALSO
 * refused — 'repeat-in-stored-line' — before it reaches `values`. This is the terminal net on the
 * SHIPPED bytes: it catches a pre-ruling stored line, a manual DB edit, or a future producer bug,
 * not just what the current composer would produce today. Amazon's own ≤2-per-word cap
 * (`capItemHighlightRepeats`) still runs downstream as defence in depth for the legacy/broadcast
 * path — this refusal is STRICTER (any repeat, not just a 3rd+ mention) and runs first.
 */
export function buildPerSkuItemHighlightMap(
  entries: PerChildItemHighlight[] | null | undefined,
  targets: { sku: string; asin: string }[],
  parentAsin?: string | null,
): { values: Map<string, string>; skipped: { sku: string; asin: string; reason: IhSkuSkipReason }[] } {
  const bySku = new Map<string, string>()
  const byAsin = new Map<string, string>()
  for (const e of Array.isArray(entries) ? entries : []) {
    const line = (e.item_highlight || '').trim()
    if (!line) continue                          // a HELD design contributes nothing — not even ''
    if (e.sku) bySku.set(e.sku, line)
    if (e.asin && !byAsin.has(e.asin)) byAsin.set(e.asin, line)
  }
  const values = new Map<string, string>()
  const skipped: { sku: string; asin: string; reason: IhSkuSkipReason }[] = []
  for (const t of targets) {
    const isHub = !!parentAsin && t.asin === parentAsin && !bySku.has(t.sku)
    const line = isHub ? undefined : (bySku.get(t.sku) ?? (t.asin ? byAsin.get(t.asin) : undefined))
    if (!line) { skipped.push({ sku: t.sku, asin: t.asin, reason: NO_LINE_FOR_DESIGN }); continue }
    if (lineHasSignificantRepeat(line)) { skipped.push({ sku: t.sku, asin: t.asin, reason: REPEAT_IN_STORED_LINE }); continue }
    values.set(t.sku, line)
  }
  return { values, skipped }
}

/** FIX WAVE 2 (I-2, 2026-09-06, controller RULING): the ONE predicate for "does this per-design
 *  entry contribute a pushable line" — non-empty AND not refused by the terminal repeat net above.
 *  `pushExecutor.loadDetailContext`'s "every design held" gate consults THIS (not a hand-rolled
 *  `.trim()` filter) so a family whose remaining lines would ALL be refused at the seam is treated
 *  exactly as unpushable as a family that composed nothing — `perDesignLines.length > 0` alone can
 *  no longer make a stale family look pushable one layer up from the seam that actually refuses it. */
export function pushableDesignLines(entries: PerChildItemHighlight[] | null | undefined): PerChildItemHighlight[] {
  return (Array.isArray(entries) ? entries : []).filter((e) => {
    const line = (e.item_highlight || '').trim()
    return !!line && !lineHasSignificantRepeat(line)
  })
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

