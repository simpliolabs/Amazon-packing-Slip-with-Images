/**
 * seasonalTerms.ts — the ONE definition of "is this keyword seasonal, and is it OUR season?".
 * ────────────────────────────────────────────────────────────────────────────────────────────
 * Extracted from listingPipeline.ts (where SEASONAL_TERMS was a module-private `const` at :244,
 * unreachable by any other module) so the keyword SELECTOR and the seven COPY GENERATORS cannot
 * drift apart.
 *
 * WHY THE OFF-SEASON DISTINCTION EXISTS (PO, 2026-07-23). Six of seven generators historically
 * hard-stripped every SEASONAL_TERM from customer-facing copy. That rule was written for the
 * "a Golf Widow tee that happens to mention Christmas" case, and it is right there: a shopper
 * searching a holiday we are not about is off-theme traffic, and a holiday phrase the copy must
 * never contain is a scoring dock no regenerate can clear.
 *
 * But it MISFIRES on a design whose OWN theme is the holiday. On B0GF49RLDL — a Valentine Cupid
 * tee — 8 of 22 pooled keywords are seasonal, and they are the design's actual subject. Blanket
 * stripping meant "valentine shirt women" (33,800/mo) could never enter the title, the bullets or
 * the description, which is exactly the gap the PO reported ("Valentine Not being in Descriptions").
 *
 * So the question is not "is this word seasonal" but "is this keyword's season OUR season":
 *   ON-SEASON  → the design's own occasion. Treated like any other on-theme keyword; generators
 *                may and should place it.
 *   OFF-SEASON → a DIFFERENT holiday than this design's. Backend-only, exactly as before.
 *   NOT-SEASONAL → no holiday signal at all.
 *
 * Leaf module: ZERO imports, so anything may depend on it without a cycle.
 */

/** The historical list, verbatim from listingPipeline.ts:244-252. Order is not significant. */
export const SEASONAL_TERMS: readonly string[] = [
  'christmas', 'xmas', 'halloween', 'valentines', 'valentine', 'easter',
  'thanksgiving', 'mothers day', 'mother day', 'fathers day', 'father day',
  'back to school', 'last day of school', 'schools out', 'school out',
  'independence day', '4th of july', 'fourth of july', 'july 4th',
  'st patrick', 'new year', 'new years', 'memorial day', 'labor day',
  'spring break', 'summer break', 'winter break', 'black friday',
  'cyber monday', 'prime day', 'hanukkah',
]

/**
 * Surface variants → ONE canonical occasion. Without this, "valentine" and "valentines" look like
 * two different seasons and a Valentine design would treat half its own keywords as off-season.
 * Longest-first ordering matters: "mothers day" must be tested before "mother day" would otherwise
 * be reached by a substring scan, and "new years" before "new year".
 */
const SEASON_FAMILIES: readonly { canonical: string; surfaces: readonly string[] }[] = [
  { canonical: 'christmas',     surfaces: ['christmas', 'xmas'] },
  { canonical: 'halloween',     surfaces: ['halloween'] },
  { canonical: 'valentine',     surfaces: ['valentines', 'valentine'] },
  { canonical: 'easter',        surfaces: ['easter'] },
  { canonical: 'thanksgiving',  surfaces: ['thanksgiving'] },
  { canonical: 'mothers-day',   surfaces: ['mothers day', 'mother day'] },
  { canonical: 'fathers-day',   surfaces: ['fathers day', 'father day'] },
  { canonical: 'back-to-school', surfaces: ['back to school', 'last day of school', 'schools out', 'school out'] },
  { canonical: 'july-4',        surfaces: ['independence day', '4th of july', 'fourth of july', 'july 4th'] },
  { canonical: 'st-patrick',    surfaces: ['st patrick'] },
  { canonical: 'new-year',      surfaces: ['new years', 'new year'] },
  { canonical: 'memorial-day',  surfaces: ['memorial day'] },
  { canonical: 'labor-day',     surfaces: ['labor day'] },
  { canonical: 'spring-break',  surfaces: ['spring break'] },
  { canonical: 'summer-break',  surfaces: ['summer break'] },
  { canonical: 'winter-break',  surfaces: ['winter break'] },
  { canonical: 'black-friday',  surfaces: ['black friday'] },
  { canonical: 'cyber-monday',  surfaces: ['cyber monday'] },
  { canonical: 'prime-day',     surfaces: ['prime day'] },
  { canonical: 'hanukkah',      surfaces: ['hanukkah'] },
]

/** Lowercase and drop apostrophes so "Valentine's Day" matches the surface "valentines".
 *  Without this a theme card reading "Valentine's Day cupid…" would carry the season "valentine"
 *  but not "valentines", and half the design's own keywords would read as off-season. */
function normalizeSeasonText(s: string): string {
  return (s || '').toLowerCase().replace(/['’]/g, '')
}

/** Every canonical occasion named anywhere in `text`. Empty array = no seasonal signal. */
export function seasonsIn(text: string): string[] {
  const t = normalizeSeasonText(text)
  if (!t) return []
  const found: string[] = []
  for (const fam of SEASON_FAMILIES) {
    if (fam.surfaces.some((s) => t.includes(s))) found.push(fam.canonical)
  }
  return found
}

/** Back-compat with the historical predicate: does this keyword name ANY holiday?
 *  NOT byte-identical to the historical rule — `seasonsIn` normalises apostrophes, so this matches
 *  STRICTLY MORE ("mother's day gift shirt": historical false, this true). Use
 *  `isSeasonalKeywordLegacy` on any path that must stay byte-identical at KEYWORD_TARGET_SET=off. */
export function isSeasonalKeyword(keyword: string): boolean {
  return seasonsIn(keyword).length > 0
}

/** The EXACT historical predicate — `SEASONAL_TERMS.some((t) => kw.toLowerCase().includes(t))`, as
 *  it stood at listingPipeline.ts:1271 and syncListingContent.ts:726. No apostrophe normalisation,
 *  no canonicalisation. This is what `off` and `shadow` must run so a flag that is supposed to
 *  change nothing genuinely changes nothing; the apostrophe delta is surfaced in the shadow log as
 *  `newlyStrippedUnderNew` so flipping is a decision rather than a surprise. */
export function isSeasonalKeywordLegacy(keyword: string): boolean {
  const lc = (keyword || '').toLowerCase()
  if (!lc) return false
  return SEASONAL_TERMS.some((t) => lc.includes(t))
}

export type SeasonRelation = 'not-seasonal' | 'on-season' | 'off-season'

/**
 * How does this keyword's season relate to the DESIGN's own season(s)?
 *
 * @param designSeasons canonical occasions from the design's theme card / design name — use
 *        `seasonsIn(themeCard)`. An EMPTY array means the design has no seasonal theme, in which
 *        case every seasonal keyword is OFF-season (the historical behaviour, preserved exactly).
 */
export function seasonRelation(keyword: string, designSeasons: readonly string[]): SeasonRelation {
  const kwSeasons = seasonsIn(keyword)
  if (kwSeasons.length === 0) return 'not-seasonal'
  // TOTALITY: `designSeasons` is a required field at the type level, but types are erased at
  // runtime and this value reaches us from routes and JSON payloads. An `undefined` here would
  // throw and take the whole selector down — the same reasoning that makes `num()` coerce the
  // numeric columns. Absent seasons ⇒ every holiday is somebody else's, the historical behaviour.
  const own = new Set(designSeasons ?? [])
  if (own.size === 0) return 'off-season'
  // ANY overlap makes it ours: "valentines day gift for her christmas" on a Valentine design is
  // still fundamentally a Valentine search, and stripping it would cost the design its own subject.
  return kwSeasons.some((s) => own.has(s)) ? 'on-season' : 'off-season'
}

// NOTE: there is exactly ONE off-season predicate — `isOffSeasonKeyword` above, and it is
// null-safe. A second exported name with an identical body was briefly added here and removed:
// two names for one predicate is precisely the shape that grew SEVEN disagreeing definitions of
// "covered" in this codebase. If you need a variant, add a PARAMETER, never a second function.

/**
 * THE predicate the copy generators should use in place of the old blanket
 * `SEASONAL_TERMS.some(...)` strip. Strip a keyword from customer-facing copy only when it names a
 * holiday that is NOT this design's own.
 *
 * Passing `[]` for designSeasons reproduces the historical blanket strip exactly, so every call
 * site can be migrated safely one at a time.
 */
export function isOffSeasonKeyword(
  keyword: string,
  designSeasons: readonly string[] | null | undefined,
): boolean {
  return seasonRelation(keyword, designSeasons ?? []) === 'off-season'
}
