/**
 * coverage-core.ts — THE single source of truth for "does this listing cover this keyword?".
 * ─────────────────────────────────────────────────────────────────────────────
 * Coherence Invariant 1 (fba-optimizer-coherence): exactly ONE coverage predicate feeds the
 * score cards, the RANK TOP panel, and the Intelligence "Present In" tab. This file IS that
 * predicate. It is `bulletTokens` (the previous scorer/generator primitive) plus one extra
 * pure per-token MAP: garment unification (tee ≡ tees ≡ tshirt ≡ t-shirt ≡ shirt ≡ shirts).
 *
 * DEPENDENCY-FREE ON PURPOSE: imported by the scorer (syncListingContent), the RANK judge
 * (rankAnalysis), the presence engine (checkPresence), and the generator (via the bulletCoverage
 * shim) — a single leaf module with no I/O avoids any import cycle.
 *
 * TWO tokenizers live here, and they are NOT interchangeable:
 *   • bulletTokens(s)     — the GENERATOR primitive. UNCHANGED byte-for-byte from bulletCoverage.ts.
 *                           Fill/dedupe/coherence in listingPipeline depend on its exact behavior
 *                           (Invariant 4: the fill MUST still be able to emit "tee"). DO NOT garment-fold it.
 *   • coverageTokens(s)   — the REPORT predicate. bulletTokens + garment map. Use for coverage ONLY.
 *
 * Garment unification and foldPlural are applied as canonical MAPS (replace-token), never as
 * additive tokens — this is what guarantees coverageTokens-coverage is a strict superset of
 * bulletTokens-coverage. A many-to-one canonical map can only ever MERGE keyword tokens onto
 * haystack tokens, so every pair the old predicate marked covered stays covered, and some
 * previously-missed garment pairs become covered. (No score can regress downward.)
 */

/** Coverage stopwords. Byte-identical to the previous bulletCoverage.BKW_STOP — kept identical so the
 *  GENERATOR primitive `bulletTokens` behaves exactly as before ('&' is stripped by the punctuation
 *  pass before the stopword filter ever runs anyway, so it is intentionally omitted here). */
export const BKW_STOP = new Set([
  'for', 'the', 'a', 'an', 'and', 'with', 'of', 'to', 'in', 'on', 'your', 'you', 'that', 'this',
])

/** Naive plural fold — applied to BOTH keyword and haystack symmetrically. Guards: >3 chars,
 *  not "...ss"/"...us"/"...is" (dress, walrus, tennis). UNCHANGED from bulletCoverage.foldPlural. */
export const foldPlural = (t: string): string =>
  t.length > 3 && t.endsWith('s') && !/(?:ss|us|is)$/.test(t) ? t.slice(0, -1) : t

/** GARMENT UNIFICATION (Invariant 4). After foldPlural, every apparel-noun spelling collapses to a
 *  single canonical token "shirt", so a title carrying "Shirt"/"TShirt" satisfies "tshirt", "tee",
 *  "shirts for women", "graphic tees for women", etc. Members cover BOTH the post-foldPlural singular
 *  forms (tee, tshirt, shirt) and their plurals (belt-and-suspenders for callers that fold garment
 *  WITHOUT foldPlural first — e.g. the fill's echo gate).
 *
 *  EXPORTED so the backend fill (listingPipeline) can apply the SAME fold LOCALLY at its echo gates
 *  (Step 4) — the fill imports this helper rather than re-implementing it, and rather than us
 *  garment-folding the shared `bulletTokens` (which would break Invariant 4: the fill must still be
 *  able to emit "tee" when a title genuinely lacks any product-type word). This map lives ONLY in
 *  `coverageTokens` (the report predicate), never inside `bulletTokens` (the generator primitive). */
const GARMENT_CANON = new Set(['tee', 'tshirt', 'shirt', 'tshirts', 'tees', 'shirts'])
export const foldGarment = (t: string): string => (GARMENT_CANON.has(t) ? 'shirt' : t)

/** GENERATOR PRIMITIVE — UNCHANGED from bulletCoverage.bulletTokens. Fill/dedupe/coherence depend on
 *  this exact output; do not add garment folding here (Invariant 4). lowercase → delete apostrophes →
 *  strip punct → split → digit-letter split → foldPlural → drop 1-char + stopwords. */
export const bulletTokens = (s: string): string[] =>
  (s || '').toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
    .flatMap((t) => {
      const m = t.match(/^(\d+)([a-z]+)$/) || t.match(/^([a-z]+)(\d+)$/)
      return m ? [m[1], m[2]] : [t]
    })
    .map(foldPlural)
    .filter((t) => t.length > 1 && !BKW_STOP.has(t))

/** THE COVERAGE PREDICATE'S TOKENIZER. bulletTokens composed with the garment canonical map.
 *  Because foldGarment is a total idempotent per-token map, coverageTokens-coverage is a strict
 *  superset of bulletTokens-coverage (never regresses a bullet_score dock; only ADDS garment cases). */
export const coverageTokens = (s: string): string[] => bulletTokens(s).map(foldGarment)

/** Field-agnostic coverage: every significant token of the keyword appears somewhere in the haystack.
 *  A keyword with zero significant tokens (e.g. all-stopword) is NEVER covered — matches the old
 *  makeCoverageChecker/missingBulletKeywords "0 tokens ⇒ missing" convention. */
export function isCovered(keyword: string, haystack: string): boolean {
  const kw = coverageTokens(keyword)
  if (kw.length === 0) return false
  const hay = new Set(coverageTokens(haystack))
  return kw.every((t) => hay.has(t))
}

/** Bound form for hot loops that check many keywords against one haystack (scorer, RANK). */
export function makeCoverageChecker(haystack: string): (kw: string) => boolean {
  const hay = new Set(coverageTokens(haystack))
  return (kw: string): boolean => {
    const t = coverageTokens(kw)
    return t.length > 0 && t.every((x) => hay.has(x))
  }
}

/** A listing_content row shape (structurally compatible with checkPresence.ListingContent and the
 *  loadListingRowsForPresence rows) — declared locally to keep coverage-core dependency-free. */
export interface CoverageRow {
  title?: string | null
  bullet_1?: string | null; bullet_2?: string | null; bullet_3?: string | null
  bullet_4?: string | null; bullet_5?: string | null
  description?: string | null
  backend_keywords?: string | null
}

export interface RowCoverage {
  /** FIELD-AGNOSTIC decision (Invariant 2): covered when the keyword's tokens appear ANYWHERE across
   *  title ∪ bullets ∪ description ∪ backend — true even if the tokens are split across fields. */
  covered: boolean
  /** Per-field flags for DISPLAY only (which field carries the whole phrase). A cross-field keyword can
   *  be `covered:true` with every per-field flag false — that is correct, not a bug. */
  inTitle: boolean; inBullets: boolean; inDescription: boolean; inBackend: boolean
  coveredIn: string[]
}

/** THE single field+union coverage function (Invariant 1 + 2 + 6). Every READ screen — the RANK panel
 *  and the Intelligence "Present In" tab — decides coverage HERE, over the resolved child's own twin
 *  rows, so they can never disagree with each other or with the scorer's field-agnostic isCovered. */
export function coverageAcrossRows(keyword: string, rows: CoverageRow[]): RowCoverage {
  const join = (sel: (r: CoverageRow) => (string | null | undefined)[]): string =>
    rows.map((r) => sel(r).filter(Boolean).join(' ')).join(' ')
  const titleHay = join((r) => [r.title])
  const bulletsHay = join((r) => [r.bullet_1, r.bullet_2, r.bullet_3, r.bullet_4, r.bullet_5])
  const descHay = join((r) => [r.description])
  const backHay = join((r) => [r.backend_keywords])
  const inTitle = isCovered(keyword, titleHay)
  const inBullets = isCovered(keyword, bulletsHay)
  const inDescription = isCovered(keyword, descHay)
  const inBackend = isCovered(keyword, backHay)
  const covered = isCovered(keyword, [titleHay, bulletsHay, descHay, backHay].join(' '))
  const coveredIn = ([inTitle && 'title', inBullets && 'bullets', inDescription && 'description', inBackend && 'backend'].filter(Boolean)) as string[]
  return { covered, inTitle, inBullets, inDescription, inBackend, coveredIn }
}

/** UNIFIED "which of these keywords are NOT covered by the joined text". This is the garment-aware
 *  replacement for the scorer/report call sites. GENERATOR call sites keep the LEGACY export
 *  `missingBulletKeywordsLegacy` (below) so the fill can still emit garment tokens (Invariant 4). */
export function missingCoverage(texts: string[], keywords: string[]): string[] {
  const hay = new Set(coverageTokens(texts.join(' ')))
  return keywords.filter((k) => {
    const t = coverageTokens(k)
    return t.length === 0 || !t.every((x) => hay.has(x))
  })
}

/** LEGACY missing-check on the raw generator primitive (NO garment fold). Byte-for-byte identical to
 *  the old bulletCoverage.missingBulletKeywords. Re-exported by bulletCoverage.ts as
 *  `missingBulletKeywords` so every existing importer (listingPipeline fill/dedupe/floors, page.tsx
 *  drafted chip) keeps its exact current behavior in Step 0-2. */
export function missingBulletKeywordsLegacy(bullets: string[], oppKw: string[]): string[] {
  const have = new Set(bulletTokens(bullets.join(' ')))
  return oppKw.filter((k) => {
    const t = bulletTokens(k)
    return t.length === 0 || !t.every((x) => have.has(x))
  })
}

/* ── SHADOW / FLAG PLUMBING ──────────────────────────────────────────────────────────────────── */

export type CoverageMode = 'off' | 'shadow' | 'on'

/** Read the COVERAGE_CORE env flag at CALL TIME (server-side) so a Coolify env change + restart flips
 *  behavior with no rebuild. Unknown/unset ⇒ 'off' (prod byte-identical to today). */
export function coverageMode(): CoverageMode {
  const v = (process.env.COVERAGE_CORE || 'off').toLowerCase()
  return v === 'on' || v === 'shadow' ? v : 'off'
}

/** Shadow-safe coverage verdict. `legacy` is the site's CURRENT production verdict (passed in so each
 *  site keeps its own today-baseline). Logs a structured diff line when the two disagree; returns the
 *  new verdict only when COVERAGE_CORE=on. Zero UI/DB effect at 'off'/'shadow' — logging only. */
export function coveredVerdict(
  keyword: string, haystack: string, legacy: boolean, site: string, asin: string,
): boolean {
  const mode = coverageMode()
  if (mode === 'off') return legacy
  const next = isCovered(keyword, haystack)
  if (next !== legacy) {
    console.log(`[COVERAGE_DIFF] site=${site} asin=${asin} kw=${JSON.stringify(keyword)} old=${legacy} new=${next}`)
  }
  return mode === 'on' ? next : legacy
}

/** Shadow-safe MISSING-LIST selector for the scorer docks (bullet dock, description dock, cohesion).
 *  At 'off' returns the legacy list unchanged; at 'shadow' returns legacy but logs which keywords the
 *  garment-aware predicate would newly credit; at 'on' returns the garment-aware list. */
export function missingVerdict(
  texts: string[], keywords: string[], legacyMissing: string[], site: string, asin: string,
): string[] {
  const mode = coverageMode()
  if (mode === 'off') return legacyMissing
  const next = missingCoverage(texts, keywords)
  if (mode === 'shadow') {
    const nextSet = new Set(next)
    const newlyCovered = legacyMissing.filter((k) => !nextSet.has(k))
    if (newlyCovered.length) {
      console.log(`[COVERAGE_DIFF] site=${site} asin=${asin} newlyCovered=${JSON.stringify(newlyCovered)}`)
    }
    return legacyMissing
  }
  return next
}
