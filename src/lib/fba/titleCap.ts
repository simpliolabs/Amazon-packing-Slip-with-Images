/**
 * The title cap — ONE implementation, in a PURE module.
 *
 * WHY THIS FILE EXISTS (the class, not the instance).
 *
 * `capTitle75` used to live inside `listingPipeline.ts`, a module with database leaves. Every pure
 * consumer that wanted the cap therefore could not import it, and copied it instead. That is not a
 * hypothetical: `truthBandHarness.ts` carried `capTitle75Like`, whose own docstring admitted it was
 * a "Twin of capTitle75 … MINUS the inclusive-audience-tail special-casing this fixture never
 * needs", with its own hardcoded 75. The acceptance harness for the truth+band door was therefore
 * measuring a DIFFERENT cap than production shipped — [[test-proves-the-mock-not-the-wire]] (#652)
 * with a comment explaining why it was fine.
 *
 * The moment the working ceiling moves (title-ceiling spec Phase 4), a stale copy silently
 * truncates to the OLD ceiling and the harness reports green on a change it reverted. Deleting the
 * copy is not enough — as long as the real function is unreachable from pure code, the next copy is
 * inevitable. So the function moves HERE, where anything can import it, and
 * `titleCapSingleSource.test.ts` fails if a second implementation appears.
 *
 * NOTHING in this module has side effects and it imports only the content contract (itself pure
 * data), so it is safe to import from fixtures, tests and harnesses.
 */
import { CONTENT_CONTRACT, ITEM_HIGHLIGHTS_TITLE_PRECONDITION } from './contentContract'

/**
 * May the Amazon-100476 auto-heal shorten a LIVE title to re-earn Item Highlights?
 *
 * Healing means CHOOSING Item Highlights over title length. While the working cap equals the
 * Item-Highlights precondition that choice is free, and the heal is pure benefit — it repairs SKUs
 * whose live title was never updated to our compliant one.
 *
 * The moment the cap is deliberately raised above the precondition, the choice has ALREADY been
 * made the other way, by the PO, in the contract. An automatic per-SKU heal would then overrule it
 * one listing at a time, soft-failing to a note nobody reads, to restore a field that renders only
 * in the browser tab. That is the class this codebase keeps hitting — a repair mechanism that
 * "restores" content converting a deliberate change into an invisible revert (the parent lock that
 * froze six child titles, the backend degrade gate, the Item-Highlights silent hold).
 *
 * DERIVED FROM THE CONTRACT, not from a flag someone has to remember to flip: raising the ceiling
 * disables the heal by construction, in the same edit, with no second place to update.
 */
export function ihHealAllowedByContract(cap: number = CONTENT_CONTRACT.title.hardCap): { allowed: boolean; why: string } {
  if (cap > ITEM_HIGHLIGHTS_TITLE_PRECONDITION) {
    return {
      allowed: false,
      why:
        `title ceiling is ${cap}, above the ${ITEM_HIGHLIGHTS_TITLE_PRECONDITION}-char Item Highlights ` +
        `precondition — shipping longer titles is a deliberate trade, so Item Highlights is forfeited ` +
        `by design and shortening the title to re-earn it would silently undo that decision`,
    }
  }
  return { allowed: true, why: '' }
}

/** Collapse an immediately-repeated 2- or 3-word phrase ("Tee Shirt Tee Shirt" → "Tee Shirt"). */
export function deduplicatePhrases(title: string): string {
  const words = title.split(/\s+/)
  for (let len = 3; len >= 2; len--) {
    for (let i = 0; i <= words.length - len * 2; i++) {
      const phrase = words.slice(i, i + len).join(' ').toLowerCase()
      const next = words.slice(i + len, i + len * 2).join(' ').toLowerCase()
      if (phrase === next) {
        words.splice(i + len, len)
        return words.join(' ')
      }
    }
  }
  return title
}

export interface TitleCapResult {
  /** The capped title. */
  title: string
  /** TRUE when the cap actually removed characters — the signal that used to be invisible. */
  cut: boolean
  /** Length before capping (after whitespace-collapse + phrase dedupe). */
  fromLen: number
  /** Length after. */
  toLen: number
  /** The ceiling applied, so a log line can never be ambiguous about WHICH cap ran. */
  cap: number
}

/**
 * Deterministic last line of defence. Cuts at a word boundary from the END (brand, design name and
 * money keyword are all front-loaded, so the tail holds the lowest-value supporting keyphrases),
 * tidies dangling connectors/punctuation, and — rather than silently narrowing the audience —
 * DROPS a truncation-mangled "for Men"/"for Women" fragment when the full title said
 * "for Men and Women".
 *
 * Returns a REPORT, not just a string. A truncation nobody can observe is the #643 class: a title
 * that changed silently is indistinguishable from a gate that never ran. Callers that genuinely do
 * not care use `capTitle` below.
 */
export function capTitleReport(title: string, cap: number = CONTENT_CONTRACT.title.hardCap): TitleCapResult {
  let t = (title || '').replace(/\s{2,}/g, ' ').trim()
  t = deduplicatePhrases(t)
  const fromLen = t.length
  if (t.length <= cap) return { title: t, cut: false, fromLen, toLen: t.length, cap }
  // Every inclusive-audience form the pipeline can emit: "for Men and Women", "Men's and
  // Women's" (the widen-guard's possessive swap), and "&" variants.
  const hadInclusiveAudience = /\bfor Men (?:and|&) Women\b|\bMen['’]s (?:and|&) Women['’]s\b/i.test(t)
  let cut = t.slice(0, cap + 1)
  const lastSpace = cut.lastIndexOf(' ')
  cut = (lastSpace > 0 ? cut.slice(0, lastSpace) : cut.slice(0, cap)).trim()
  // Strip trailing punctuation + dangling FUNCTION words left by the cut ("... Tee for" → "... Tee").
  // A dangling content word from a split keyphrase can survive — acceptable for a last-line backstop;
  // the agent's prompts + retries keep real titles under the cap in the normal path.
  for (let guard = 0; guard < 6; guard++) {
    const tidied = cut.replace(/[\s,;:&|\-–—]+$/g, '').replace(/\s(?:for|and|with|in|of|to|a|an|the|or|by)$/i, '').trim()
    if (tidied === cut) break
    cut = tidied
  }
  if (hadInclusiveAudience && /\s*\b(?:for\s+)?(?:Men|Women)[‘’]?s?(?:\s(?:and|&))?$/i.test(cut)) {
    cut = cut.replace(/\s*\b(?:for\s+)?(?:Men|Women)[‘’]?s?(?:\s(?:and|&))?$/i, '').trim().replace(/[\s,;:&\-–—]+$/g, '')
  }
  // Strip dangling garment fragments from truncation
  cut = cut.replace(/\s+(?:Men[‘’]?s?|Women[‘’]?s?)\s+(?:Short|Long)$/i, '').trim().replace(/[\s,;:&\-–—]+$/g, '')
  return { title: cut, cut: true, fromLen, toLen: cut.length, cap }
}

/**
 * String-only form, for the many call sites that just want the capped title.
 *
 * The cap DEFAULTS to `CONTENT_CONTRACT.title.hardCap` rather than a literal 75 — that default is
 * the whole point. When the working ceiling moves, every call site moves with it, including the
 * acceptance harness. Three raw `75` literals previously made that impossible.
 */
export function capTitle(title: string, cap: number = CONTENT_CONTRACT.title.hardCap): string {
  return capTitleReport(title, cap).title
}

/**
 * BACKWARD-COMPATIBLE NAME. Kept because ~20 call sites and several tests import `capTitle75`, and
 * renaming them is churn unrelated to the defect. It is a thin alias for `capTitle` and follows the
 * contract — despite the "75" in the name, it does NOT hardcode 75. When the ceiling moves this
 * name becomes actively misleading and should be retired in the same change.
 */
export function capTitle75(title: string): string {
  return capTitle(title)
}
