/* ─────────────────────────────────────────────────────────────────────────────────────────────────
 * THE TITLE REFEREE — deterministic half (P2, offline, no LLM, no credits).
 *
 * THE SELLER'S GOVERNING RULE (2026-08-12, SELLER_PROFILE §3), in their selection of two of four
 * offered rules:
 *   1. EVERY CHARACTER MUST BUY A SEARCH TERM.
 *   2. THE IDENTITY MUST NAME A SPECIFIC SUBJECT, NOT ITS CATEGORY.
 *
 * Rule 1 has TWO halves and they land on OPPOSITE sides of the architecture's line
 * (handoff/TITLE_ARCHITECTURE.md §3 — code owns facts, the LLM owns meaning):
 *
 *   (a) A REPEATED word buys nothing. DECIDABLE BY CODE — token equality against the identity, with
 *       an external oracle (the shared `coverageTokens` predicate). This module owns it.
 *   (b) An UNSEARCHED word buys nothing. NOT decidable by code — "would a shopper type this" has no
 *       table we can consult, because a phrase can be in the keyword pool and still be filler. The
 *       LLM referee owns it.
 *
 * WHY (a) MATTERS — it is not hypothetical. The live 2026-08-12 regen on B0GVV3XL4T shipped a money
 * position the deterministic judge scored 100/100 with an EMPTY problems array:
 *
 *      identity : THE CEO 2026 World Soccer Cup Tee Shirt
 *      money    : Futbol Cup 2026 Soccer T-Shirt
 *                        ^^^  ^^^^ ^^^^^^        all three already in the identity
 *
 * Four of six words were echoes. Thirty characters of the highest-value real estate bought ONE new
 * search term. `moneyNovelty` below returns 0.25 for that string and 1.00 for the seller's own gold
 * — a separation no length rule, vocabulary list or regex produced in ~1,234 commits of trying.
 *
 * NO NEW TOKENIZER. `coverageTokens` (keyword-engine/coverage-core.ts) is the ONE coverage predicate
 * this repo has — the cure for the seven-disagreeing-definitions defect. It folds plurals, folds
 * every garment noun to `shirt`, and drops stopwords, so "Tee Shirt" in the identity and "T-Shirt"
 * in the money position are correctly seen as the same token.
 * ────────────────────────────────────────────────────────────────────────────────────────────── */
import { coverageTokens, foldGarment } from '@/lib/keyword-engine/coverage-core'
import { GARMENT_NOUNS, SEED_GOLD_TITLES } from './poGoldCorpus'

export type SeparatorClass = 'pipe' | 'comma' | 'plain'

export interface TitleSegments {
  identity: string
  money: string
  separator: SeparatorClass
}

const GARMENT_TOKEN = 'shirt'   // what foldGarment collapses every garment noun to

const isGarmentWord = (w: string): boolean =>
  GARMENT_NOUNS.has(w.toLowerCase().replace(/[^a-z0-9-]/g, '')) ||
  GARMENT_NOUNS.has(w.toLowerCase().replace(/[^a-z0-9]/g, ''))

/**
 * Resolve the identity/money boundary from ANY separator.
 *
 * FOUR of the seller's nine golds have no pipe (2 comma-joined, 2 plain), so a resolver keyed on
 * ` | ` is blind to 44% of their own corpus — which is exactly the measured defect M2: three of five
 * shape checks in `titleQualityJudge` are reachable only via `indexOf(' | ')`, so deleting the
 * separator RAISES a rejected title's score by up to +44. Nothing here may require the pipe.
 *
 * PLAIN JOIN: the boundary is the END OF THE FIRST GARMENT-NOUN RUN. That is how the seller's own
 * unpiped golds read — "THE CEO Espana Championship Tee Shirt | 2026 Spain Jersey Football Soccer
 * Cup" is the same title with the separator drawn in.
 */
export function resolveSegments(title: string): TitleSegments {
  const t = (title || '').trim()
  if (!t) return { identity: '', money: '', separator: 'plain' }

  const pipe = t.indexOf(' | ')
  if (pipe >= 0) return { identity: t.slice(0, pipe).trim(), money: t.slice(pipe + 3).trim(), separator: 'pipe' }

  const comma = t.indexOf(', ')
  if (comma >= 0) return { identity: t.slice(0, comma).trim(), money: t.slice(comma + 2).trim(), separator: 'comma' }

  const toks = t.split(/\s+/)
  let runStart = -1
  for (let i = 0; i < toks.length; i++) {
    if (isGarmentWord(toks[i])) { if (runStart < 0) runStart = i }
    else if (runStart >= 0) {
      // A garment run closed at i-1. Everything up to and including it is the identity.
      return { identity: toks.slice(0, i).join(' '), money: toks.slice(i).join(' '), separator: 'plain' }
    }
  }
  return { identity: t, money: '', separator: 'plain' }
}

export interface MoneyNovelty {
  /** Fraction of the money position's NON-GARMENT content tokens that are absent from the identity.
   *  1.0 = every word earns its space. 0.0 = the money position is a restatement of the identity. */
  novelty: number
  /** The tokens that buy nothing because the identity already carries them. */
  echoed: string[]
  /** The tokens that genuinely add a new search term. */
  fresh: string[]
}

/**
 * Rule 1(a), mechanically. The GARMENT noun is deliberately EXCLUDED from the echo penalty: the
 * seller's own "noun x2 with variety" rule (§3) REQUIRES the garment to appear on both sides
 * ("Tee Shirt … Tshirt"), so counting it as an echo would penalise every one of the nine golds.
 * A title with no money position returns novelty 1 — there is nothing there to be redundant, and
 * the too-short case is owned by the PO's "floor refuses, never pads" ruling, not by this metric.
 */
export function moneyNovelty(title: string): MoneyNovelty {
  const { identity, money } = resolveSegments(title)
  if (!money.trim()) return { novelty: 1, echoed: [], fresh: [] }

  const idTokens = new Set(coverageTokens(identity))
  const seen = new Set<string>()
  const echoed: string[] = []
  const fresh: string[] = []
  for (const tok of coverageTokens(money)) {
    if (tok === GARMENT_TOKEN || foldGarment(tok) === GARMENT_TOKEN) continue   // noun x2 is the seller's rule
    if (seen.has(tok)) { echoed.push(tok); continue }                            // a repeat inside the tail buys nothing either
    seen.add(tok)
    if (idTokens.has(tok)) echoed.push(tok)
    else fresh.push(tok)
  }
  const total = echoed.length + fresh.length
  return { novelty: total === 0 ? 1 : fresh.length / total, echoed, fresh }
}

/* ── NEAREST-GOLD RETRIEVAL ────────────────────────────────────────────────────────────────────────
 * Rank the corpus by SITUATIONAL similarity so the writer and the referee are anchored on the gold
 * that matches THIS design, rather than on all nine at once. Retrieved demonstrations beat random
 * ones, with the largest gains on generation (Liu et al., DeeLIO/ACL 2022, arXiv:2101.06804).
 *
 * This is the step that would have pointed the World Cup design at the ESPANA gold — an event, a
 * plain join, a proper-noun cluster — instead of at the piped apparel golds that all five failing
 * drafts imitated. At N=9 it is a scoring function, not a vector index.
 *
 * Every feature is DERIVED, never hand-typed, so a new seller lock joins the corpus with no commit.
 */
export interface GoldSituation {
  title: string
  identity: string
  money: string
  separator: SeparatorClass
  /** Contains a 4-digit year → the design is pinned to an EVENT. */
  isEvent: boolean
  /** First-person pronoun in the identity → the design is a STATEMENT the wearer makes. */
  isStatement: boolean
  /** A capitalised non-initial, non-garment word → the design names a SPECIFIC subject (rule 2). */
  hasProperSubject: boolean
  /** 'women' | 'men' | 'none' — the audience the title commits to. */
  audience: 'women' | 'men' | 'none'
  /** The garment family word as written (tee/cap/hat/…), lowercased. */
  garment: string
}

const FIRST_PERSON = /\b(i|i'm|im|my|me|we|our)\b/i

export function goldSituation(title: string): GoldSituation {
  const { identity, money, separator } = resolveSegments(title)
  const words = identity.split(/\s+/).slice(2)   // skip the two brand words ("THE CEO")
  const lower = title.toLowerCase()
  const garmentWord = title.split(/\s+/).find(isGarmentWord) ?? ''
  return {
    title,
    identity,
    money,
    separator,
    isEvent: /\b(19|20)\d{2}\b/.test(title),
    isStatement: FIRST_PERSON.test(identity),
    hasProperSubject: words.some((w) => /^[A-Z]/.test(w) && !isGarmentWord(w) && !/^(the|a|an|of|in|for|and)$/i.test(w)),
    audience: /\bfor women\b/i.test(lower) ? 'women' : /\bfor (men|mens)\b/i.test(lower) || /\bmens\b/i.test(lower) ? 'men' : 'none',
    garment: garmentWord.toLowerCase().replace(/[^a-z-]/g, ''),
  }
}

export interface TargetSituation {
  isEvent: boolean
  isStatement: boolean
  hasProperSubject: boolean
  audience: 'women' | 'men' | 'none'
  garment: string
}

/** Situational similarity, 0-5. Deliberately a plain weighted count: at N=9 anything cleverer is
 *  unfalsifiable, and this one can be read off by a human reviewing a retrieval decision. */
export function situationScore(target: TargetSituation, gold: GoldSituation): number {
  let s = 0
  if (target.isEvent === gold.isEvent) s += 2            // strongest signal: an event title reads unlike a statement
  if (target.isStatement === gold.isStatement) s += 1
  if (target.hasProperSubject === gold.hasProperSubject) s += 1
  if (target.audience === gold.audience) s += 0.5
  if (target.garment && gold.garment && foldGarment(target.garment) === foldGarment(gold.garment)) s += 0.5
  return s
}

/** The k golds most like this design's situation, best first. Ties break on corpus order so the
 *  result is deterministic and reproducible — a referee verdict must be explainable. */
export function nearestGolds(
  target: TargetSituation,
  golds: readonly string[] = SEED_GOLD_TITLES,
  k = 3,
): GoldSituation[] {
  return golds
    .map((t, i) => ({ sit: goldSituation(t), i }))
    .map((x) => ({ ...x, score: situationScore(target, x.sit) }))
    .sort((a, b) => (b.score - a.score) || (a.i - b.i))
    .slice(0, k)
    .map((x) => x.sit)
}

/** Derive the target situation from what the pipeline already knows about a design — so retrieval
 *  needs no new input and no new DB column. */
export function targetFromDesign(opts: {
  designPhrase: string
  garmentNoun?: string | null
  lean?: 'male' | 'female' | 'unisex' | null
}): TargetSituation {
  const d = opts.designPhrase || ''
  return {
    isEvent: /\b(19|20)\d{2}\b/.test(d),
    isStatement: FIRST_PERSON.test(d),
    hasProperSubject: d.split(/\s+/).some((w) => /^[A-Z]/.test(w) && !isGarmentWord(w)),
    audience: opts.lean === 'female' ? 'women' : opts.lean === 'male' ? 'men' : 'none',
    garment: (opts.garmentNoun || '').toLowerCase().replace(/[^a-z-]/g, ''),
  }
}
