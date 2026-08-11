/**
 * poGoldCorpus.ts — the seller's OWN titles as the council's few-shot corpus.
 *
 * PO 2026-08-10: "I gave you about 70 title recommendations in the last 2 months (all fixes were
 * pushed to repos) that should be a strong signal for the council/judge how to put these together."
 *
 * THE GAP THIS CLOSES. `PO_GOLD_TITLES` (listingPipeline.ts) is EIGHT hand-copied strings, and the
 * comment above it has promised since July that a "future auto-miner over listing_change_log title
 * edits" was the intended design. It was never built. So every title-quality problem has been chased
 * with another deterministic net, while dozens of worked examples of the answer sat in the database
 * and in commit history — including golds the seller had already ruled on.
 *
 * WHAT COUNTS AS A GOLD, and why this source is trustworthy. When the seller writes a title by hand
 * the pipeline stamps `listing_seo_recommendations.title_source = 'manual'` and stores their text in
 * `recommended_title` (migration 044). A manual row is therefore a gold BY DEFINITION: the seller's
 * own words, on their own product, deliberately locked against the AI. No heuristic, no scoring, no
 * guess about intent — the lock IS the endorsement.
 *
 * SELF-GROWING, which is the point. Because the corpus is READ at generation time rather than
 * hardcoded, every future correction the seller makes becomes training data automatically, with no
 * commit and no deploy. That is the standing "self-heal + self-learn IN the system" directive applied
 * to title quality instead of to error handling.
 *
 * FAIL-OPEN: any DB problem, or an empty table, returns the curated seed list. The council must never
 * lose its few-shots because a query failed.
 */
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * SEED GOLDS — the floor, used when the DB read fails or returns nothing.
 *
 * These three are the highest-confidence examples in the whole project: they are the most-cited
 * titles across the entire commit history AND the seller confirmed the signal directly
 * ("17/20 is good") when shown the citation counts. Everything else comes from the live table, so
 * this list stays deliberately tiny — a seed, not a second rulebook to drift out of date.
 */
export const SEED_GOLD_TITLES: readonly string[] = [
  'THE CEO See You Later Alligator Shirt | Long Sleeve Comfort Colors Shirt',      // 72 — cited x20
  'THE CEO 2026 World Soccer Cup Tee Shirt | USA Mexico Canada Football Tee',      // 72 — cited x17
  'THE CEO I Will Praise Him in Every Season Tee | Christian Shirts for Women',    // 74 — cited x14
] as const

/** How many golds the brief carries. Enough to teach the shape; small enough to leave prompt budget
 *  for the design's own context. Newest first — the seller's taste is allowed to move. */
export const GOLD_BRIEF_LIMIT = 12

export interface GoldShape {
  /** Median title length across the corpus — what the seller actually ships. */
  medianLen: number
  /** Median words LEFT of the pipe (brand + design + garment noun). */
  medianLeftWords: number
  /** Largest left-segment word count observed — the ceiling, not an invented cap. */
  maxLeftWords: number
  /** Share of golds that use a ` | ` pipe at all. */
  pipedShare: number
  count: number
  /** How many titles the LEFT-segment stats were measured over. Published because the piped subset
   *  is small (live corpus n=23 at pipedShare 0.30 ⇒ ~7 titles), and a ceiling quoted to the council
   *  as the seller's own number should carry its sample size rather than imply a firm law. */
  leftWordsFrom: number
}

const wc = (s: string) => s.trim().split(/\s+/).filter(Boolean).length
const leftOf = (t: string) => { const i = t.indexOf(' | '); return i >= 0 ? t.slice(0, i).trim() : t }
const median = (ns: number[]) => (ns.length ? [...ns].sort((a, b) => a - b)[Math.floor(ns.length / 2)] : 0)

/** PURE. Measures the shape of a corpus so the brief can quote the seller's OWN numbers rather than
 *  a figure someone inferred from one example — the 2026-08-10 lesson, where "6-7 words" was written
 *  into the profile from a single gold while the measured median across the corpus was 8. */
export function measureGoldShape(titles: readonly string[]): GoldShape {
  const list = titles.filter((t) => t.trim().length > 0)
  const piped = list.filter((t) => t.includes(' | '))
  // LEFT-SEGMENT STATS COME FROM THE PIPED SUBSET ONLY. An unpiped title HAS no left segment —
  // `leftOf` returns the whole string — so including one contributes its FULL word count as though
  // it were a left segment, inflating the ceiling the brief then quotes as the seller's own law.
  // This is not hypothetical: the live corpus is ~70% unpiped (pipedShare 0.30, n=23), so the
  // inflated population is the MAJORITY. `/api/fba/title-golds` (route.ts:102-104) already measures
  // it this way; this brings the brief's copy into line with the analysis endpoint's.
  //
  // FALLBACK TO THE WHOLE LIST, NEVER TO ZERO. `loadPoGoldTitles` takes only the newest 12 manual
  // rows, so an all-unpiped window is genuinely reachable — and a zero shape would make
  // `goldBriefBlock` instruct the council "never more than 0 words before the separator".
  const measured = piped.length > 0 ? piped : list
  const lefts = measured.map((t) => wc(leftOf(t)))
  return {
    medianLen: median(list.map((t) => t.length)),
    medianLeftWords: median(lefts),
    maxLeftWords: lefts.length ? Math.max(...lefts) : 0,
    pipedShare: list.length ? +(piped.length / list.length).toFixed(2) : 0,
    count: list.length,
    leftWordsFrom: measured.length,
  }
}

/**
 * Load the seller's locked titles, newest first, deduped. Falls back to SEED_GOLD_TITLES.
 *
 * `supabase` is passed IN and must be a plain service client — never the cookies()-bound one, which
 * throws outside a request scope and would make this silently return the seed list inside a
 * streaming continuation (the failure mode recorded in cookies-scoped-client-in-streams).
 */
export async function loadPoGoldTitles(
  supabase: SupabaseClient | null | undefined,
  limit = GOLD_BRIEF_LIMIT,
): Promise<{ titles: string[]; shape: GoldShape; source: 'db' | 'seed' }> {
  const seed = () => ({ titles: [...SEED_GOLD_TITLES], shape: measureGoldShape(SEED_GOLD_TITLES), source: 'seed' as const })
  if (!supabase) return seed()
  try {
    const { data, error } = await supabase
      .from('listing_seo_recommendations')
      .select('recommended_title, generated_at')
      .eq('title_source', 'manual')
      .order('generated_at', { ascending: false })
      .limit(400)
    if (error || !data) return seed()

    const seen = new Set<string>()
    const titles: string[] = []
    for (const r of data as { recommended_title: string | null }[]) {
      const t = (r.recommended_title ?? '').trim()
      // A gold must look like a shipped title: brand-front and inside the band. A truncated or
      // placeholder row would teach the council a shape the seller never chose.
      if (t.length < 40 || t.length > 80) continue
      const k = t.toLowerCase()
      if (seen.has(k)) continue          // one gold locked across many children is ONE example
      seen.add(k)
      titles.push(t)
      if (titles.length >= limit) break
    }
    if (titles.length === 0) return seed()
    // Union with the seed: the three highest-confidence examples always survive, even if the newest
    // locks happen to be atypical. Dedupe keeps them from appearing twice.
    for (const s of SEED_GOLD_TITLES) if (!seen.has(s.toLowerCase())) titles.push(s)
    return { titles, shape: measureGoldShape(titles), source: 'db' }
  } catch {
    return seed()
  }
}

/** The few-shot block for the council brief. Quotes the MEASURED shape, so the instruction and the
 *  examples can never disagree — and so a number in the brief is always the seller's, not ours. */
export function goldBriefBlock(titles: readonly string[], shape: GoldShape): string {
  if (titles.length === 0) return ''
  return [
    `SELLER-APPROVED TITLES (${shape.count}) — these are titles THIS seller wrote or locked themselves.`,
    'Match their SHAPE, not their words. Measured across them:',
    `  • typical length ${shape.medianLen} chars`,
    `  • ${shape.medianLeftWords} words before the separator (never more than ${shape.maxLeftWords}; measured over ${shape.leftWordsFrom})`,
    `  • ${Math.round(shape.pipedShare * 100)}% use a " | " separator — a comma or plain join is equally acceptable`,
    'The segment before the separator is BRAND + DESIGN + garment noun and stays SHORT. Everything after',
    'it is the MONEY position: the phrase shoppers actually search. A spec fact there (Crew Neck, Classic',
    'Fit, Unisex) is waste — those belong in Item Highlights.',
    '',
    ...titles.map((t) => `  ${t}`),
  ].join('\n')
}
