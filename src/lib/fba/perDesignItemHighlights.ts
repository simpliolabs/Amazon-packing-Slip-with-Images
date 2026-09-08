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
// FIX WAVE 2 ROUND 2 (F1/F2, controller RULING, 2026-09-06): `classifyStoredIhLine` is the ONE
// classification of a stored line, used by BOTH the push seam (below) and the card's row builder
// (`perDesignIhRows`, below) — so the two can never disagree about which SKU is pushable. It lives
// in `productDetailAttrs.ts` (a leaf `page.tsx` already imports directly), NOT `itemHighlightComposer.ts`
// (the generation path — reaches `contentTruth` -> `blankSpecs` -> a lazy supabase client): this
// module is imported by the CLIENT page, so it must never import anything from the composer. No
// cycle either way: neither module imports the other.
import { classifyStoredIhLine } from './productDetailAttrs'

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
  // TASK 8 (2026-09-07, PO RULING "A: 2 - Sweatshirt/…"): the absolute rule now has ONE exception —
  // the garment head noun may repeat up to Amazon's own cap (`IH_MAX_WORD_REPEATS`, 2); every other
  // significant word is still limited to once. The message names the allowance instead of claiming
  // "never allowed" (still true for every other word, just no longer true of the garment noun).
  'under-floor-no-repeat': `Held: truthful phrases + blank facts reach the ${CONTENT_CONTRACT.itemHighlights.min}-char floor only by repeating a word beyond its allowance (the garment noun may appear twice; every other significant word once) — rate/harvest more keywords for this family`,
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
  /** R1 (finish-line-rulings.md, controller RULING, 2026-09-08): non-blocking. Set by
   *  `applyBlankBrandNetPerDesign`/`applyBlankBrandNetToDetails` (blankSpecs.ts) when the
   *  blank-brand waterfall net TRIED to insert the brand and abandoned the insertion because doing
   *  so would push the line under the floor/repeat cap — `item_highlight` still SHIPS (correct,
   *  ruled), unbranded. Reuses `IhHoldReason` + `IH_HOLD_MESSAGES` — never a parallel vocabulary —
   *  and is DISTINCT from `hold` (which means "no line at all" and disqualifies the design from
   *  shipping via `classifyIhEntry`; this field never does). null/undefined = the brand is either
   *  already carried, not owed, or was inserted successfully. */
  blankBrandAbandoned?: IhHoldReason | null
}

export const NO_LINE_FOR_DESIGN = 'no-line-for-design' as const
/** FIX WAVE 2 (I-2b, 2026-09-06, controller RULING): the ruling was enforced at GENERATION only
 *  (itemHighlightComposer.ts Task 6) — a line stored before it shipped, or written by any future
 *  producer bug or manual edit, could still carry a repeated significant word. `NO_LINE_FOR_DESIGN`
 *  names "no line exists"; this names the distinct case "a line exists but the push seam — the LAST
 *  pure function before Amazon — refuses to ship it". */
export const REPEAT_IN_STORED_LINE = 'repeat-in-stored-line' as const
/** IH TERMINAL NET PHASE 1 (2026-09-07, H13): a stored line that is non-empty and non-repeating but
 *  shorter than `CONTENT_CONTRACT.itemHighlights.min` — `classifyStoredIhLine`'s newest
 *  classification, given its own named seam-skip reason for the same reason `REPEAT_IN_STORED_LINE`
 *  got one (I-2b): "under the floor" is a distinct, nameable fact from "no line at all", and the PO
 *  must see WHICH of the two is true, not a collapsed generic skip. */
export const UNDER_FLOOR = 'under-floor' as const
// FIX ROUND 3 (I-1, controller RULING, phase-1-fix-round-3-findings.md): widened to include every
// `IhHoldReason` (not just 'under-floor') — `classifyIhEntry` below can now refuse an entry for ANY
// hold reason, and its own reason must travel through to the card/push report VERBATIM, never a
// second, parallel vocabulary invented for the seam. ('under-floor' is a member of both unions
// already; TS collapses the duplicate literal, no runtime effect.)
export type IhSkuSkipReason = typeof NO_LINE_FOR_DESIGN | typeof REPEAT_IN_STORED_LINE | IhHoldReason

/**
 * FIX ROUND 3 (I-1, controller RULING): "A HOLD IS RECORDED BUT NEVER ENFORCED" — before this, the
 * push seam (`buildPerSkuItemHighlightMap`) and the card's row builder (`perDesignIhRows`) each
 * decided shippability from `classifyStoredIhLine(e.item_highlight)` ALONE, never looking at
 * `e.hold`. An entry can carry BOTH a recorded hold AND a stored line that, taken on its own,
 * classifies `ok` (e.g. `listingPipeline.ts`'s per-child persist keeps the composed line and stamps
 * a hold on refusal — BLOCKING 2's own fix). Reproduced live (fix round 3 probe): such an entry was
 * mapped by `buildPerSkuItemHighlightMap`, survived `pushableDesignLines`, and `buildDetailPatchValue`
 * produced a real, shippable patch — a HELD design shipped.
 *
 * THE ONE PREDICATE: a non-null `hold` is disqualifying, full stop — the line's own classification
 * is consulted ONLY when there is no hold. The hold's OWN `IhHoldReason` travels through as the
 * returned reason (never a new, parallel name for the same fact) — `IhSkuSkipReason` above already
 * widened to accept it.
 */
export function classifyIhEntry(
  entry: { item_highlight?: string | null; hold?: IhHoldReason | null } | null | undefined,
): 'ok' | IhSkuSkipReason {
  if (entry?.hold) return entry.hold
  return classifyStoredIhLine(entry?.item_highlight)
}

/**
 * FIX ROUND 3 (I-2, controller RULING): the ONE mapper from a skip reason to seller-facing text —
 * every site that renders a skip reason to the seller (pushExecutor.ts's single-push details branch,
 * its "Nothing to push" summary, its held-SKU surfacing pass, `executeBulkDetailsPush`'s per-SKU
 * skip, and the card) calls THIS instead of hand-rolling its own ternary. A new reason can then never
 * reach a seller mislabeled: every hold reason (including any added in the future) reuses its OWN
 * `IH_HOLD_MESSAGES` text automatically (the `default` branch below never enumerates hold reasons by
 * name), and the two non-hold seam classifications get their own accurate fragment. Returns a
 * FRAGMENT (no "Skipped — " prefix, no trailing period) — callers compose their own surrounding
 * sentence/prefix (some name the SKU, some the design, some just summarize a count) around it. */
export function ihSkipReasonText(reason: IhSkuSkipReason): string {
  switch (reason) {
    case 'no-line-for-design':
      return "this design has no composed Item Highlight (held); it is never given another design's line"
    case 'repeat-in-stored-line':
      return "this design's stored Item Highlight repeats a significant word (never allowed, PO ruling 2026-09-06); re-run ↻ Regen or a full audit to recompose it"
    default:
      return IH_HOLD_MESSAGES[reason]
  }
}

/** A compact one-row-per-design view of the stored array (first SKU of each design is representative). */
export interface PerDesignIhRow {
  designKey: string
  designName: string
  line: string
  hold: IhHoldReason | null
  skuCount: number
  /** TRUE when every SKU of the design has pushed_value === line (non-empty). */
  onAmazon: boolean
  /** FIX WAVE 2 ROUND 2 (F2, controller RULING): the PRE-FLIGHT classification of the WHOLE entry
   *  via the SAME `classifyIhEntry` predicate the push seam (`buildPerSkuItemHighlightMap`) applies
   *  (FIX ROUND 3, I-1: widened from the line-only `classifyStoredIhLine` to also consult `hold`,
   *  hold-first) — null when the entry is non-empty, unheld, and pushable ('ok'); otherwise the
   *  exact reason the seam would refuse it. The card derives this from HERE, never a second decision
   *  in the page: a stale line that repeats a significant word shows `repeat-in-stored-line` before
   *  any push is attempted, and a HELD entry shows its own hold reason even when its line alone would
   *  read as compliant — not only after a push report says so. */
  skipReason: IhSkuSkipReason | null
  /** R1 (finish-line-rulings.md, controller RULING, 2026-09-08): non-blocking — carried straight
   *  through from the entry's own `blankBrandAbandoned` (set by `applyBlankBrandNetPerDesign`).
   *  Independent of `skipReason`/`hold`: a design can be perfectly pushable (`skipReason: null`)
   *  and STILL carry this note (its line ships, just without the blank brand it is owed). */
  blankBrandAbandoned: IhHoldReason | null
}

export function perDesignIhRows(entries: PerChildItemHighlight[] | null | undefined): PerDesignIhRow[] {
  if (!Array.isArray(entries)) return []
  const order: string[] = []
  const byKey = new Map<string, PerDesignIhRow & { allPushed: boolean }>()
  for (const e of entries) {
    const key = e.designKey || e.designName || e.sku
    let row = byKey.get(key)
    if (!row) {
      const line = e.item_highlight || ''
      // FIX ROUND 3 (I-1, controller RULING): classifyIhEntry (hold-first) — "the hold's own reason
      // travels to the card", not a second decision that only ever looks at the line.
      const classification = classifyIhEntry(e)
      row = {
        designKey: key,
        designName: e.designName || e.designKey || e.sku,
        line,
        hold: e.hold ?? null,
        skuCount: 0,
        onAmazon: false,
        skipReason: classification === 'ok' ? null : classification,
        blankBrandAbandoned: e.blankBrandAbandoned ?? null,
        allPushed: true,
      }
      byKey.set(key, row); order.push(key)
    }
    row.skuCount++
    if (!(e.item_highlight && e.pushed_value === e.item_highlight)) row.allPushed = false
  }
  return order.map((k) => { const r = byKey.get(k)!; const { allPushed, ...rest } = r; return { ...rest, onAmazon: allPushed && !!rest.line } })
}

/** A collapsed view: designs whose (line, hold, blankBrandAbandoned) are IDENTICAL share one row.
 *  Under the shared-line ruling (PO 2026-08-21) every multi-design family collapses to ONE row
 *  "shared across N designs"; the per-design capability stays — rows that ever differ render
 *  separately. `skipReason` is carried through from the group's own rows (guaranteed identical
 *  within a group — the collapse key includes it via `hold`/`line`, and `skipReason` (FIX ROUND 3:
 *  via `classifyIhEntry`) is a pure function of exactly that pair, so it can never disagree within
 *  one collapsed group). `blankBrandAbandoned` is now PART OF the collapse key (R1) so two designs
 *  whose line/hold happen to match but whose blank-brand outcome differs never merge into one row
 *  reporting only one of their reasons. */
export interface SharedIhRow {
  line: string
  hold: IhHoldReason | null
  designs: PerDesignIhRow[]
  skuCount: number
  /** TRUE when every SKU of every design in the row has the line on Amazon. */
  onAmazon: boolean
  skipReason: IhSkuSkipReason | null
  blankBrandAbandoned: IhHoldReason | null
}

export function collapseSharedIhRows(rows: PerDesignIhRow[]): SharedIhRow[] {
  const order: string[] = []
  const byKey = new Map<string, SharedIhRow>()
  for (const r of rows) {
    const k = `${r.hold ?? ''}|${r.line}|${r.blankBrandAbandoned ?? ''}`
    let row = byKey.get(k)
    if (!row) { row = { line: r.line, hold: r.hold, designs: [], skuCount: 0, onAmazon: true, skipReason: r.skipReason, blankBrandAbandoned: r.blankBrandAbandoned }; byKey.set(k, row); order.push(k) }
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
 *
 * FIX ROUND 3 (I-1, controller RULING): an entry's own `hold` is now consulted TOO, via
 * `classifyIhEntry` — a non-null hold is disqualifying regardless of what the line alone would
 * classify as (the gap the ruling closes: a design can carry a recorded hold AND a stored line that,
 * read in isolation, is perfectly in-band — that entry must still be SKIPPED, with the hold's own
 * reason, never mapped into `values`).
 */
export function buildPerSkuItemHighlightMap(
  entries: PerChildItemHighlight[] | null | undefined,
  targets: { sku: string; asin: string }[],
  parentAsin?: string | null,
): { values: Map<string, string>; skipped: { sku: string; asin: string; reason: IhSkuSkipReason }[] } {
  const bySku = new Map<string, PerChildItemHighlight>()
  const byAsin = new Map<string, PerChildItemHighlight>()
  // FIX ROUND 3 (I-1, controller RULING — F2 PARITY regression caught by itemHighlightPushSeam.test.ts's
  // own parity suite): this loop used to `continue` past any entry whose line was empty, so a
  // HELD-EMPTY entry (item_highlight:'', hold:'designs-unrated', say) was never registered here at
  // all — the main loop below then resolved `entry` to `undefined` and `classifyIhEntry(undefined)`
  // fell through to `classifyStoredIhLine(undefined)`, always reporting the GENERIC
  // 'no-line-for-design' regardless of the entry's own, more specific hold. `perDesignIhRows` (the
  // card) calls `classifyIhEntry` on the RAW entry directly and so already reported the specific
  // reason — the two disagreed on WHICH reason a held-empty SKU gets (never on whether it ships;
  // both always refuse it). Registering every entry here, empty line or not, lets `classifyIhEntry`
  // decide uniformly for BOTH functions from the exact same data — it already treats an empty,
  // unheld line as 'no-line-for-design' via `classifyStoredIhLine`, so this changes nothing for an
  // entry with no hold.
  for (const e of Array.isArray(entries) ? entries : []) {
    if (e.sku) bySku.set(e.sku, e)
    if (e.asin && !byAsin.has(e.asin)) byAsin.set(e.asin, e)
  }
  const values = new Map<string, string>()
  const skipped: { sku: string; asin: string; reason: IhSkuSkipReason }[] = []
  for (const t of targets) {
    const isHub = !!parentAsin && t.asin === parentAsin && !bySku.has(t.sku)
    const entry = isHub ? undefined : (bySku.get(t.sku) ?? (t.asin ? byAsin.get(t.asin) : undefined))
    // FIX ROUND 3 (I-1, controller RULING): classifyIhEntry consults the WHOLE entry — a non-null
    // `hold` disqualifies it here, full stop, BEFORE the line's own classification is ever
    // consulted. Previously this called `classifyStoredIhLine(line)` directly, which is exactly why
    // an entry carrying a recorded hold alongside an in-band ('ok') line was mapped into `values`
    // and shipped (reproduced: fix round 3 probe, buildPerSkuItemHighlightMap on a
    // `{item_highlight: <123-char compliant line>, hold: 'under-floor'}` entry mapped the SKU).
    const classification = classifyIhEntry(entry)
    // IH TERMINAL NET PHASE 1 (H13): an under-floor stored line used to fall through to this
    // `values.set` below (classifyStoredIhLine only ever returned 'ok' for a non-empty,
    // non-repeating line, regardless of length) — the exact gap the spec's H13 reproduction names.
    if (classification !== 'ok') { skipped.push({ sku: t.sku, asin: t.asin, reason: classification }); continue }
    values.set(t.sku, (entry!.item_highlight || '').trim())
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
  // FIX ROUND 3 (I-1, controller RULING): classifyIhEntry (hold-first), not classifyStoredIhLine
  // alone — a held-but-in-band entry must not survive this filter (see buildPerSkuItemHighlightMap's
  // matching fix above; both are the SAME predicate now, by construction).
  return (Array.isArray(entries) ? entries : []).filter((e) => classifyIhEntry(e) === 'ok')
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

