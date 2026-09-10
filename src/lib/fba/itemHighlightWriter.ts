/**
 * itemHighlightWriter.ts — THE Item Highlight WRITER (docs/superpowers/specs/2026-09-10-item-
 * highlight-writer.md, §2 as amended by §2a-§2d; rulings across fix rounds B2 (W1-W10), B3
 * (G1-G10) and B4 (`.superpowers/sdd/2026-09-10-ih-writer/phase-b4-rulings.md`, K1-K11 — the
 * writer meets every contract through its OWNER's predicate: the push seam's OWN repeat/pushability
 * classifier, the composer's OWN brand-carry test, and a prompt GENERATED from one rule registry).
 *
 * WHY A LEAF, NOT WIRED INTO listingPipeline.ts DIRECTLY. This module owns the admitted set (B1/W1),
 * the arrangement contract (W1), readability (B6/W7), the client + prompt (B5/B10) and the bounded
 * retry loop (B7/B8/W8) — everything the writer needs to judge and produce ONE candidate line. It
 * has ZERO import of `listingPipeline.ts`: the post-compose TAIL (`runIhTail` — repeat budget + line
 * truth net + floor door) is handed in as a CALLBACK (`runTail`) by the caller. `listingPipeline.ts`
 * imports FROM this module — never the other way — so the dependency graph stays acyclic (this
 * module sits beside `contentTruth.ts`/`productDetailAttrs.ts` as a leaf).
 *
 * THE DESIGN CORRECTION THIS ROUND MAKES (spec §2b, ruling W1). Every new lie the phase-b-review
 * built (N1, N3-N11, N15, N16) came from ONE place: a parser that read the writer's free TEXT back
 * into admitted units, and could always be fooled by reordering, inserted/substituted glue, a
 * partial use that drops a negation/hedge/relation, or a number moved inside a unit. Tightening that
 * parser rule by rule is the treadmill the spec amendment exists to end.
 *
 * So the writer does not return text. It returns an ARRANGEMENT — an ordered list of admitted UNIT
 * IDS and closed GLUE tokens (`{"parts":[{"unit":"u3"},{"glue":"with"},{"unit":"u7"}]}`). Code
 * renders it: every unit appears with its OWN stored words, order, numbers and punctuation — the
 * only permitted change is the singular/plural form of a unit's trailing GARMENT HEAD NOUN. A unit
 * is used at most once. There is no model TEXT for a provenance parser to read, so the whole class of
 * recombination defect cannot recur BY CONSTRUCTION — there is nothing left to parse.
 *
 * THE BOUND (spec §2b "Bound"). A lie can reach the line only if it is itself an admitted unit — the
 * identical phrase the picker would ship with the flag off. The writer's safety equals the picker's;
 * closing the picker's own admission gaps is the separately-FILED admission-oracle programme.
 */
import type OpenAI from 'openai'
import {
  phraseTruthVerdict, garmentNounConstraint, LEAN_FEM_CORE, LEAN_MASC_CORE,
  KIDS_AUDIENCE_RE, ADULT_AUDIENCE_RE, FIT_CLAIM_RE, PURITY_ADJACENT_RE, FIBER_RE,
  type PhraseTruthCtx,
} from '@/lib/fba/contentTruth'
import { PERFORMANCE_CLAIM_RE } from '@/lib/fba/blankSpecs'
import {
  ihFoldWord, IH_GARMENT_HEAD_FOLDED, lineHasSignificantRepeat, classifyStoredIhLine,
  significantFolded, ihRepeatBudget,
} from '@/lib/fba/productDetailAttrs'
import { titleCasePhrase } from '@/lib/fba/titleBand'
import { CONTENT_CONTRACT } from '@/lib/fba/contentContract'
import { type ComposerResult, lineCarriesBrand } from '@/lib/fba/itemHighlightComposer'
import { getLlmClientForRequest } from '@/lib/fba/llmGateway'
import { GARMENT_HEAD_WORDS } from '@/lib/fba/garmentNoun'
import { scrubTrademarks } from '@/lib/fba/trademarkGuard'
import { hasCelebrityName, scrubCelebrityNames } from '@/lib/fba/celebrityGuard'

// ─── B9: THE FLAG ──────────────────────────────────────────────────────────────────────────────

export type IhWriterMode = 'off' | 'shadow' | 'on'

/** IH_WRITER = off | shadow | on, default OFF (unset or unrecognized). Unlike CONTENT_RECONCILE_
 *  ENABLED's shadow default, a raw null here is the TRUTH — off is the code default — so `/api/health`
 *  can echo the raw env value with no effective-mode wrapper. */
export function ihWriterMode(raw: string | undefined = process.env.IH_WRITER): IhWriterMode {
  const v = (raw ?? '').trim().toLowerCase()
  if (v === 'on') return 'on'
  if (v === 'shadow') return 'shadow'
  return 'off'
}

/** IH_WRITER_MODEL, default 'gpt-4.1' (B5). */
export function ihWriterModel(raw: string | undefined = process.env.IH_WRITER_MODEL): string {
  return (raw && raw.trim()) || 'gpt-4.1'
}

/** RULING W8 (F7, F9): the PER-REGEN call budget, counted ACROSS designs — distinct from
 *  `IH_WRITER_RETRY_CAP` below (the per-DESIGN retry cap, 1+2). Default 18. Echoed in `/api/health`
 *  so the bound is readable from outside the container, same convention as every other model/count
 *  pin in that route. */
export function ihWriterMaxCallsBudget(raw: string | undefined = process.env.IH_WRITER_MAX_CALLS): number {
  const n = Number.parseInt((raw ?? '').trim(), 10)
  return Number.isFinite(n) && n > 0 ? n : 18
}

/** RULING K10 (fix round B4, wire Important I2): a REGEN-LEVEL wall-time deadline for the
 *  per-design writer loop, across every design in the family — distinct from the per-call
 *  `timeout: 20_000` on one OpenAI request and from `IH_WRITER_RETRY_CAP`/`ihWriterMaxCallsBudget`
 *  (which bound CALLS, not TIME). Default 45000ms. The wire lens measured a dead/slow gateway
 *  costing 120s for a 6-design family (two waves of 3x20s) against `llmGateway.ts`'s documented
 *  ~100s Cloudflare edge timeout — the regen route awaits the writer before responding, so a slow
 *  gateway can turn the whole POST into an edge error and the shadow readout is lost with it. Once
 *  the deadline passes, every design still pending gets the composer's own result — never worse
 *  than off, same fail-closed doctrine as the retry cap. */
export function ihWriterDeadlineMs(raw: string | undefined = process.env.IH_WRITER_DEADLINE_MS): number {
  const n = Number.parseInt((raw ?? '').trim(), 10)
  return Number.isFinite(n) && n > 0 ? n : 45_000
}

// ─── W1: ADMITTED UNITS (stable IDs; no atomic/pool split any more — every unit renders WHOLE) ───

export type AdmittedUnitKind = 'identity' | 'spec-fact' | 'brand' | 'wear-fact' | 'pool' | 'garment-head'

export interface AdmittedUnit {
  /** Stable within ONE writer run (one `buildAdmittedUnits` call, reused across every retry for
   *  that design) — "u0", "u1", ... in construction order. */
  id: string
  /** Stored words, order, numbers and punctuation, exactly as the composer/identity/spec source
   *  carries them — rendered VERBATIM, never re-worded, never split. */
  text: string
  kind: AdmittedUnitKind
  /** True iff this unit's LAST word folds to a member of `GARMENT_HEAD_WORDS` (garmentNoun.ts) — the
   *  ONLY unit shape an arrangement's `number` field may target (rule (a), W1). RULING K3: never
   *  true for an `identity` unit (T18 "Over the Tops") — a design name is never renumbered, even
   *  when its own last word happens to fold to a garment noun. */
  numberable: boolean
  /** RULING K2 (fix round B4): true for the ONE unit that carries the composer's mandatory brand,
   *  REGARDLESS of its grammar `kind` — a pool-sourced brand still carries this even though its
   *  `kind` is `'pool'` (list-join only), never `'brand'` (which is reserved for the deterministic
   *  spec-phrase origin, relation-joinable). `validateArrangement`'s mandatory-brand rule (G4) keys
   *  off THIS flag, never off `kind === 'brand'`. */
  isBrand?: boolean
}

/** Does `text`'s LAST tokenized word LITERALLY (case-insensitive) belong to `GARMENT_HEAD_WORDS`
 *  (garmentNoun.ts)? FIX ROUND B3 (RULING G3, closing review B2's criterion-2 FAIL): the PRIOR
 *  check folded the word first (`IH_GARMENT_HEAD_FOLDED`/`ihFoldWord`), and the fold strips a
 *  trailing "s" — so "Tight" (identity unit "Hold On Tight") folds to "tight", which collides with
 *  the PLURAL-only set member "tights" and was wrongly admitted as numberable, letting `{"number":
 *  "plural"}` render "Hold On Tights" (a garment noun for a DIFFERENT product on a tee — X13). The
 *  fold is the right tool for READABILITY's clause scan (rendered text, casing/inflection varies —
 *  untouched below) but wrong for THIS gate: rule (a)/(d) must ask "is this word ITSELF one of the
 *  literal spellings this codebase already recognizes as naming a garment", never "does some OTHER
 *  spelling fold to the same stem". Literal membership is intentionally asymmetric (`GARMENT_HEAD_
 *  WORDS` carries some singulars without their plural, and vice versa, per its own docstring) — that
 *  asymmetry is accepted rather than patched with a second list, per the ruling's own words ("never
 *  from ihFoldWord"). */
function lastWordMatch(text: string): { word: string; index: number } | null {
  const matches = [...text.matchAll(WORD_RE)]
  if (!matches.length) return null
  const last = matches[matches.length - 1]
  return { word: last[0], index: last.index ?? 0 }
}
function isNumberable(text: string): boolean {
  const last = lastWordMatch(text)
  return !!last && GARMENT_HEAD_WORDS.has(last.word.toLowerCase())
}

/** W1: builds the writer's admitted set FROM the composer's own additively-exposed fields
 *  (`ComposerResult.candidates`/`specFacts`/`brandPick`/`wearFact`) plus the design's own identity,
 *  PLUS the family's own garment head noun(s) (so an arrangement can NAME the garment even when the
 *  pool carries no bare garment-noun phrase) — never re-implements the composer's filtering. Identity
 *  units (the design name as stored, plus the group's vision `identityPhrases`) are admitted only
 *  when `phraseTruthVerdict` passes them against the design's own truthCtx — a design whose own name
 *  asserts something the blank does not back is not laundered into an admitted fact just because it
 *  is the design's own vocabulary. Garment-head units are derived from `garmentNounConstraint` (the
 *  SAME truth-derived allowed-noun table `phraseTruthVerdict`'s own wrong-garment-noun rule gates
 *  with) — filtered to single-word forms recognized by `GARMENT_HEAD_WORDS`, so every one passes
 *  rule (a) [numberable] BY CONSTRUCTION (pinned in the test file). */
export function buildAdmittedUnits(
  composed: Pick<ComposerResult, 'candidates' | 'specFacts' | 'brandPick' | 'brandOrigin' | 'wearFact'>,
  opts: { designName?: string | null; identityPhrases?: readonly string[]; truthCtx: PhraseTruthCtx },
): AdmittedUnit[] {
  const units: AdmittedUnit[] = []
  let n = 0
  const push = (text: string, kind: AdmittedUnitKind, extra?: { isBrand?: boolean }) => {
    // RULING K3 (fix round B4, truth Important T18): `number` never applies to an identity unit —
    // computed false unconditionally for that kind, even when the design name's own last word folds
    // to a garment noun ("Over the Tops" -> "Top"/"Tops").
    units.push({ id: `u${n++}`, text, kind, numberable: kind !== 'identity' && isNumberable(text), ...extra })
  }

  // RULING G2 (§2c rule 5, F10): identity admission also passes the composer's OWN trademark and
  // celebrity doors (`scrubTrademarks` — compare, never rewrite, same discipline as `itemHighlight-
  // Composer.ts:433`'s candidate filter; `hasCelebrityName` — the pipeline's own pool-side predicate,
  // itemHighlightComposer.ts's final-line scrub sits downstream of where identity used to never
  // reach at all). EVERY dropped identity unit is logged (`IH_WRITER_IDENTITY_DROPPED`), not only the
  // trademark/celebrity ones — this also closes F10's SILENT drop on the single-design path, where an
  // untrue identity phrase used to disappear with no trace.
  // RULING K3 (fix round B4, truth Important "the vision channel"; supersedes G2's vision-phrase
  // half): identity units are the design name AS STORED, and ONLY the design name.
  // `opts.identityPhrases` (the design's VISION phrases) is no longer admitted here — a vision
  // phrase describes the ARTWORK and reads as a product claim (T09 "100% Organic", T12 "Made in
  // America", T15 "Embroidered Floral Patch"); the pool never feeds it, so admitting it as identity
  // opened a channel the composer's own truth-filtered candidate list does not gate. A vision phrase
  // can still reach the line, but ONLY as a composer POOL candidate (`composed.candidates`, already
  // truth-filtered and title-novelty-checked) — never a second, unfiltered admission path. The
  // `identityPhrases` parameter stays on the options type for source compatibility with every
  // existing caller (`produceItemHighlights`/`produceItemHighlightsPerDesign` thread it straight
  // through); it is simply never read for identity any more.
  const designNameText = (opts.designName ?? '').trim() || null
  const identityTexts = designNameText ? [designNameText] : []
  const seenIdentity = new Set<string>()
  for (const text of identityTexts) {
    const key = text.toLowerCase()
    if (seenIdentity.has(key)) continue
    seenIdentity.add(key)
    const reason = !phraseTruthVerdict(text, opts.truthCtx).ok ? 'untrue'
      : scrubTrademarks(text) !== text ? 'trademark'
        : hasCelebrityName(text) ? 'celebrity'
          : null
    if (reason) {
      console.warn(JSON.stringify({ tag: 'IH_WRITER_IDENTITY_DROPPED', phrase: text, reason }))
      continue
    }
    push(text, 'identity')
  }
  // RULING K4 (fix round B4, value Important "under-floor and unit lengths"): the "Unisex Fit"
  // spec-fact is not even OFFERED as an admitted unit when this design's own resolved lean is
  // gendered (`women`/`men`, the normalized form of the seller's lean_female/lean_male/female/male
  // enum — see `normalizeAudienceLean`, contentTruth.ts). Structural on the lean already threaded
  // into every caller (never a new source) — B6.2's readability check (gender word beside "Unisex")
  // stays wired as defense in depth, but a model that never SEES the unit cannot burn a call
  // discovering the collision the hard way.
  const genderedLean = opts.truthCtx.audienceLean === 'women' || opts.truthCtx.audienceLean === 'men'
  for (const text of composed.specFacts ?? []) {
    if (genderedLean && /\bunisex\b/i.test(text)) continue
    push(text, 'spec-fact')
  }
  // RULING K2 (fix round B4, compliance B1/B2): the brand unit's grammar CLASS follows its ORIGIN,
  // never its text. A pool-sourced `brandPick` (the composer picked an ordinary pool phrase that
  // happens to carry the brand) is admitted as an ordinary `'pool'` unit — list-join only, never
  // after "with"/"in" or an article, so it can never launder a relation onto unvetted pool text
  // (truth B1's X7/X5 reopening). The deterministic spec phrase (no pool candidate carried the
  // brand) stays `'brand'` (SPEC-class, relation-joinable — it is a true fact of the product: this
  // blank's own brand). EITHER WAY `isBrand: true` marks it as the mandatory unit (G4), so the
  // required-brand rule never depends on which grammar class won.
  if (composed.brandPick) {
    push(composed.brandPick, composed.brandOrigin === 'pool' ? 'pool' : 'brand', { isBrand: true })
  }
  if (composed.wearFact) push(composed.wearFact, 'wear-fact')
  for (const text of composed.candidates ?? []) {
    // RULING K2 (compliance Minor, "the brand twin"): drop the pool-sourced brand's OWN twin from
    // the ordinary pool units — it was already admitted once, above, as the (now pool-classed)
    // brand unit. Without this, the SAME text existed as two different unit ids, and an arrangement
    // using the pool-twin id was wrongly rejected as "missing required brand" even though the line
    // it rendered carried the brand text byte-for-byte.
    if (composed.brandOrigin === 'pool' && text === composed.brandPick) continue
    push(text, 'pool')
  }

  // W1: "Units are as in B1, PLUS the family's garment head noun(s) for this blank as single-word
  // units, so an arrangement can name the garment. They pass rule (a) by construction."
  const { allowed } = garmentNounConstraint(opts.truthCtx)
  const seenHead = new Set<string>()
  for (const word of allowed) {
    if (/\s/.test(word)) continue // single-word forms only
    const folded = ihFoldWord(word)
    if (!IH_GARMENT_HEAD_FOLDED.has(folded) || seenHead.has(folded)) continue
    seenHead.add(folded)
    push(titleCasePhrase(word), 'garment-head')
  }
  return units
}

// ─── FIX ROUND B3 (spec §2c, rulings G1/G9): THE CLOSED GRAMMAR's glue/punctuation ────────────────
//
// Review B2 proved that §2b's closed glue LIST was not enough: GLUE and ADJACENCY between admitted
// units create relations no unit itself carries ("with Deep Pockets" invents a feature; "in Pink
// Lemonade" invents a colour; "for Little Man"/"for Girls" invent an audience). The cure is not a
// bigger blocklist of banned glue words — it is a smaller, CLASSIFIED glue set, so every join has a
// grammatical ROLE the validator can check against the unit CLASSES on either side (below), instead
// of trusting any word that merely carries "no product claim on its own".
//
// `for`/`of`/`to`/`your`/`on`/`from`/`that`/`this`/`the` are REMOVED outright (§2c rule 4) — every
// one of them was the exact mechanism a review adversary used to invent a feature/colour/audience/
// material relation (X5/X6/X7/X8/X9/X10/X11). What remains is classified into three grammatical
// roles:
//   LIST joins  (`,` `and` `&` `—` `|`)      — §2c rule 2: assert nothing between their items; the
//                                               picker's own comma-list shape. May join ANY two units.
//   RELATION joins (`with` `in`)              — §2c rule 3: may introduce ONLY a spec-class unit (a
//                                               blank spec fact, the brand phrase, or the sanctioned
//                                               wear fact) — so a relation can only ever attach a
//                                               TRUE fact of this product.
//   ARTICLE  (`a` `an`)                       — never a joiner on its own; legal only directly before
//                                               a spec-class unit (G9), typically riding a relation
//                                               join ("with a Classic Fit") or a list join ("and a
//                                               Classic Fit" — the spec's own readability-ceiling
//                                               example, §2c).
/** An arrangement's `{"glue": "..."}` part must match one of these EXACTLY (case-sensitive — the
 *  model is instructed to use these exact lowercase spellings), or one of `GLUE_PUNCTUATION` below. */
const GLUE_WORDS_RAW = ['a', 'an', 'and', 'with', 'in'] as const
export const GLUE_WORDS: ReadonlySet<string> = new Set(GLUE_WORDS_RAW)
// RULING K7 (fix round B4, value Important I1) DELETED the FIX-ROUND-B3-era `READABILITY_
// CONNECTING_WORDS_RAW`/`GLUE_WORDS_FOLDED` pair that used to live here: that wider "connecting
// word" list let a bare `and`-chain ("Tee and Crewneck and Sweatshirt") count as non-keyword-shaped,
// which is exactly the class of keyword-dump the readability check exists to catch. Readability's
// own `clauseIsKeywordShaped` (below) now reads the NARROWER `RELATION_WORDS_FOLDED` (`with`/`in`
// only) instead.

/** The closed punctuation set (unchanged by §2c — these were never the recombination mechanism).
 *  Rendering (G9) differs by member: `,` attaches to the word on its LEFT (no space before); `&`
 *  `|` `—` are space-padded on BOTH sides (they read as list joins between whole phrases, not
 *  trailing marks) — see `PUNCTUATION_ATTACH_LEFT`/`renderArrangement` below. */
export const GLUE_PUNCTUATION: ReadonlySet<string> = new Set([',', '—', '|', '&'])
/** The one punctuation mark that attaches LEFT when rendered; every other member of
 *  `GLUE_PUNCTUATION` is space-padded on both sides (G9). */
const PUNCTUATION_ATTACH_LEFT: ReadonlySet<string> = new Set([','])

/** §2c's classification of each glue role, for the grammar walk in `validateArrangement` below. */
const LIST_GLUE: ReadonlySet<string> = new Set(['and', ',', '—', '|', '&'])
const RELATION_GLUE: ReadonlySet<string> = new Set(['with', 'in'])
const ARTICLE_GLUE: ReadonlySet<string> = new Set(['a', 'an'])

/** §2c's unit classes. `SPEC` unions the three "true fact of this product" kinds a relation join
 *  may introduce (a blank spec fact, the brand phrase, the sanctioned wear fact) — `GARMENT` is
 *  `garment-head` alone (rule 1's "garment noun"); every other kind (`identity`, `pool`) is neither. */
const SPEC_KINDS: ReadonlySet<AdmittedUnitKind> = new Set(['spec-fact', 'brand', 'wear-fact'])

/** NEVER glue (ruling B2, verbatim, unchanged by W1/§2c): negations, quantifiers, purity words,
 *  gendered pronouns. Not consumed at runtime (they simply are never added to `GLUE_WORDS` above) —
 *  kept as data so a test can assert `GLUE_WORDS` never grows to include one of these AND that none
 *  of them (nor any glue word) matches an exported truth regex (the build-time collision guard, kept
 *  from B2 per ruling W1: "Keep the glue-vs-lexicon disjointness test."). */
export const NEVER_GLUE_WORDS: readonly string[] = ['not', 'no', 'without', 'non', 'all', 'only', 'just', 'pure', 'entirely', 'nothing', 'her', 'his', 'him', 'she', 'he']

const WORD_RE = /[A-Za-z0-9]+(?:['’][A-Za-z]+)*/g

// ─── W1: THE SINGULAR/PLURAL TOGGLE (the ONLY permitted change inside a unit) ─────────────────────

/** Explicit singular/plural pairs for the closed `GARMENT_HEAD_WORDS` vocabulary (garmentNoun.ts) —
 *  hand-paired rather than a generic English inflector, because a generic rule mis-pluralizes
 *  irregular members of this exact list (e.g. "dress" → "dresss"). Adding a WORD here never adds new
 *  VOCABULARY — `isNumberable`'s literal `GARMENT_HEAD_WORDS` membership check (RULING G3) already
 *  gates which units are numberable at all; this table only teaches the renderer the other half of
 *  a pair for a word already admitted through that gate. */
const GARMENT_NUMBER_PAIRS: readonly [string, string][] = [
  ['shirt', 'shirts'], ['t-shirt', 't-shirts'], ['tshirt', 'tshirts'], ['tee', 'tees'],
  ['hat', 'hats'], ['cap', 'caps'], ['snapback', 'snapbacks'], ['beanie', 'beanies'], ['visor', 'visors'],
  ['hoodie', 'hoodies'], ['sweatshirt', 'sweatshirts'], ['crewneck', 'crewnecks'], ['pullover', 'pullovers'],
  ['polo', 'polos'], ['tank', 'tanks'], ['top', 'tops'], ['jersey', 'jerseys'],
  ['dress', 'dresses'], ['sundress', 'sundresses'], ['legging', 'leggings'], ['tight', 'tights'], ['sock', 'socks'],
  ['jacket', 'jackets'], ['coat', 'coats'], ['windbreaker', 'windbreakers'], ['pajama', 'pajamas'], ['apron', 'aprons'],
]
const SINGULAR_OF = new Map<string, string>()
const PLURAL_OF = new Map<string, string>()
for (const [s, p] of GARMENT_NUMBER_PAIRS) {
  SINGULAR_OF.set(s, s); SINGULAR_OF.set(p, s)
  PLURAL_OF.set(s, p); PLURAL_OF.set(p, p)
}

function applyCasingLike(sample: string, word: string): string {
  if (sample.length > 1 && sample === sample.toUpperCase()) return word.toUpperCase()
  if (sample[0] && sample[0] === sample[0].toUpperCase()) return word.charAt(0).toUpperCase() + word.slice(1)
  return word
}

/** Renders one unit's text with its trailing garment-head word toggled to `number` — every other
 *  word, every space, every piece of punctuation in `text` is untouched. A word with no known pair
 *  (should not happen for a `numberable` unit, since the pair table is a superset of
 *  `GARMENT_HEAD_WORDS`'s toggleable members — but fails SAFE, never invents a form) is a no-op. */
function applyNumberToLastWord(text: string, number: 'singular' | 'plural'): string {
  const last = lastWordMatch(text)
  if (!last) return text
  const target = number === 'plural' ? PLURAL_OF.get(last.word.toLowerCase()) : SINGULAR_OF.get(last.word.toLowerCase())
  if (!target) return text
  const rendered = applyCasingLike(last.word, target)
  return text.slice(0, last.index) + rendered + text.slice(last.index + last.word.length)
}

// ─── W1: THE ARRANGEMENT — validate, then render VERBATIM ─────────────────────────────────────────

export interface ArrangementUnitPart { unit: string; number?: 'singular' | 'plural' }
export interface ArrangementGluePart { glue: string }
export type ArrangementPart = ArrangementUnitPart | ArrangementGluePart

/** Human-readable class name for a violation message ("pool unit" / "identity unit" / ...). */
function unitClassName(kind: AdmittedUnitKind): string {
  return kind === 'spec-fact' ? 'spec-fact' : kind === 'garment-head' ? 'garment-head' : kind
}

/** §2c's glue-role classifier over an ALREADY-VALIDATED part (unit / list-join / relation-join /
 *  article) — used only by the grammar walk below, never by the structural checks above it. */
type GlueRole = 'unit' | 'list' | 'relation' | 'article'
function glueRole(part: ArrangementPart): GlueRole {
  if ('unit' in part) return 'unit'
  if (LIST_GLUE.has(part.glue)) return 'list'
  if (RELATION_GLUE.has(part.glue)) return 'relation'
  return 'article' // the only remaining closed-glue words are 'a'/'an' (ARTICLE_GLUE)
}

/**
 * FIX ROUND B3 (RULING G1, spec §2c rules 1-4) — the CLOSED ARRANGEMENT GRAMMAR, walked over an
 * already unit/glue-validated `parts` sequence. Two units may sit next to each other in exactly two
 * shapes:
 *   ABUTMENT (no glue between them) — rule 1: legal ONLY when the RIGHT-hand unit is `garment-head`
 *     ("<design name> Sweatshirt", "<pool phrase> Tee"). Any other abutment (a pool/identity/spec
 *     unit on the right) is a NAMED violation — this alone kills X1/X2/X3/X4/X13's "abut a bare
 *     identity/pool phrase onto another" mechanism.
 *   ONE OR TWO glue tokens between them:
 *     - a single LIST join (`,` `and` `&` `—` `|`) — rule 2: legal between ANY two units.
 *     - a single RELATION join (`with`/`in`) — rule 3: legal ONLY when the RIGHT-hand unit is
 *       SPEC-class (`spec-fact`/`brand`/`wear-fact`). This is what kills X5 ("with Deep Pockets",
 *       a pool unit), X7 ("in Pink Lemonade", an identity unit), and would kill X8/X9/X10/X11's
 *       "for"/"from" relations even before this rule runs, because `for`/`from` are no longer in
 *       the closed glue set at all (rule 4 — see the `GLUE_WORDS_RAW` block comment).
 *     - a RELATION join immediately followed by an ARTICLE (`a`/`an`) — the optional article rule
 *       3 names — legal under the SAME right-hand-unit-is-SPEC condition; likewise a LIST join
 *       immediately followed by an article (the spec's own readability-ceiling example, "and a
 *       Classic Fit") — G9's restatement, "an article may appear only immediately before a spec
 *       unit", is the general form of both.
 *     - anything else (three or more glue tokens in a row; an article NOT immediately followed by a
 *       unit; a bare article with no preceding join; two consecutive list joins) is a NAMED
 *       violation — rule 4's "no other glue exists between units" plus G9's hygiene rules.
 * No glue or punctuation may open or close the line (rule 4 / G9).
 */
/** RULING K6 (fix round B4, truth Minor "bare article"; value Minor "a/an"): an article is legal
 *  only immediately before a spec-class unit whose PAD-BANK DESCRIPTOR is `fit` or `neck` — the two
 *  descriptors this ruling names, read structurally off the unit's own last word (the pad bank's
 *  own templates append exactly the words "Fit"/"Neck" — see `ihSpecFactFillers`/`IH_PAD_SUFFIX_FIT`
 *  in productDetailAttrs.ts) rather than a growing lexicon. Neither "with 100% Ring-Spun Cotton" nor
 *  "with Comfort Colors" nor "with Can be worn as Oversized" ever needs an article — this is why
 *  the RELATION rule (below) stays keyed on the wider `SPEC_KINDS`, while the ARTICLE rule narrows
 *  further. */
const ARTICLE_ELIGIBLE_LAST_WORDS: ReadonlySet<string> = new Set(['fit', 'neck'])
function isArticleEligibleSpecUnit(u: AdmittedUnit): boolean {
  if (!SPEC_KINDS.has(u.kind)) return false
  const last = lastWordMatch(u.text)
  return !!last && ARTICLE_ELIGIBLE_LAST_WORDS.has(last.word.toLowerCase())
}

function validateGrammar(parts: readonly ArrangementPart[], byId: ReadonlyMap<string, AdmittedUnit>): string | null {
  if (glueRole(parts[0]) !== 'unit') return 'no glue or punctuation may open the line'
  if (glueRole(parts[parts.length - 1]) !== 'unit') return 'no glue or punctuation may close the line'
  const unitAt = (p: ArrangementPart): AdmittedUnit => byId.get((p as ArrangementUnitPart).unit)!
  let i = 0
  while (i < parts.length) {
    if (glueRole(parts[i]) === 'unit') { i++; continue }
    let j = i
    while (j < parts.length && glueRole(parts[j]) !== 'unit') j++
    // `i > 0` and `j < parts.length` are guaranteed by the start/end checks above.
    const left = unitAt(parts[i - 1])
    const right = unitAt(parts[j])
    const run = parts.slice(i, j) as ArrangementGluePart[]
    const roles = run.map(glueRole)
    if (run.length > 2) {
      return `too many glue tokens in a row ('${run.map((g) => g.glue).join(' ')}') between '${left.text}' and '${right.text}'`
    }
    if (run.length === 2) {
      if (roles[1] !== 'article' || roles[0] === 'article') {
        return `'${run[0].glue} ${run[1].glue}' is not a legal join between '${left.text}' and '${right.text}' — only a join followed by 'a'/'an' is`
      }
      // RULING K6: narrowed from "any SPEC_KINDS unit" to "a fit/neck spec-fact" — see the doc above
      // `isArticleEligibleSpecUnit`.
      if (!isArticleEligibleSpecUnit(right)) {
        return `article '${run[1].glue}' may only introduce a "Fit" or "Neck" spec fact; '${right.text}' is a ${unitClassName(right.kind)} unit`
      }
      i = j
      continue
    }
    // run.length === 1
    const role = roles[0]
    if (role === 'relation' && !SPEC_KINDS.has(right.kind)) {
      return `relation '${run[0].glue}' must introduce a spec fact; '${right.text}' is a ${unitClassName(right.kind)} unit`
    }
    // RULING K6 (truth Minor "bare article"): a LONE article with no preceding list/relation join is
    // NEVER legal, regardless of the right-hand unit's kind — `validateGrammar`'s docstring already
    // named this rule (§2c rule 4); this branch used to silently accept it whenever the right-hand
    // unit happened to be SPEC_KINDS.
    if (role === 'article') {
      return `a bare article ('${run[0].glue}') with no preceding join is not legal; put a list or relation join immediately before it`
    }
    // list join: legal between any two units (rule 2).
    i = j
  }
  // Abutment pass (rule 1): re-walk for any adjacent unit/unit pair with no glue in between.
  for (let k = 0; k < parts.length - 1; k++) {
    if (glueRole(parts[k]) !== 'unit' || glueRole(parts[k + 1]) !== 'unit') continue
    const left = unitAt(parts[k])
    const right = unitAt(parts[k + 1])
    if (right.kind !== 'garment-head') {
      return `'${left.text}' and '${right.text}' abut with no join; only a garment noun may follow another unit directly`
    }
    // RULING K3 (fix round B4, truth Important T19): a garment-head unit may abut only after an
    // IDENTITY or POOL unit ("<design name> Sweatshirt", "<pool phrase> Tee") — never after another
    // garment-head unit (chaining "Shirt Tee Top"), and never after a spec-fact/brand/wear-fact
    // unit either (a true fact never directly precedes a bare garment noun with no join).
    if (left.kind !== 'identity' && left.kind !== 'pool') {
      return `'${left.text}' and '${right.text}' abut with no join; a garment noun may only follow an identity or pool unit, not a ${unitClassName(left.kind)} unit`
    }
  }
  return null
}

/**
 * W1 validation (pure, exported), rejecting with a NAMED violation for the retry:
 *   (a) a unit ID that does not exist;
 *   (b) a unit used twice;
 *   (c) a glue token outside the closed GLUE set or the closed punctuation set;
 *   (d) `number` on a unit whose LAST word is not a garment head noun;
 *   (e) [RULING G9] an unknown key on a part;
 *   (f) [RULING G1, spec §2c] the closed arrangement GRAMMAR (`validateGrammar` above) — abutment,
 *       list joins and relation joins must each attach a legal unit class;
 *   (g) [RULING G4] the composer's mandatory brand unit, when one exists in `units`, must appear.
 * Anything else malformed (not `{"parts":[...]}`, an empty array, a part that is neither
 * `{"unit":...}` nor `{"glue":...}`) is its own named violation.
 */
export function validateArrangement(
  raw: unknown,
  units: readonly AdmittedUnit[],
): { ok: true; parts: ArrangementPart[] } | { ok: false; violation: string } {
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { parts?: unknown }).parts)) {
    return { ok: false, violation: 'malformed: expected {"parts": [...]}' }
  }
  const rawParts = (raw as { parts: unknown[] }).parts
  if (rawParts.length === 0) return { ok: false, violation: 'empty arrangement: parts must be non-empty' }
  const byId = new Map(units.map((u) => [u.id, u] as const))
  const seen = new Set<string>()
  const out: ArrangementPart[] = []
  for (const item of rawParts) {
    if (!item || typeof item !== 'object') return { ok: false, violation: `malformed part: ${JSON.stringify(item)}` }
    const p = item as Record<string, unknown>
    if (typeof p.unit === 'string') {
      // RULING G9 (F8): an unknown key on a unit part is a NAMED violation, never silently dropped.
      const extra = Object.keys(p).filter((k) => k !== 'unit' && k !== 'number')
      if (extra.length) return { ok: false, violation: `unit part carries unknown key(s): ${extra.join(', ')}` }
      const unit = byId.get(p.unit)
      if (!unit) return { ok: false, violation: `unit id '${p.unit}' does not exist` }
      if (seen.has(p.unit)) return { ok: false, violation: `unit '${p.unit}' used more than once` }
      seen.add(p.unit)
      let number: 'singular' | 'plural' | undefined
      if (p.number !== undefined) {
        if (p.number !== 'singular' && p.number !== 'plural') {
          return { ok: false, violation: `invalid number '${String(p.number)}' on unit '${p.unit}' (must be "singular" or "plural")` }
        }
        if (!unit.numberable) {
          return { ok: false, violation: `unit '${p.unit}' cannot take a number — its last word is not a garment head noun` }
        }
        number = p.number
      }
      out.push(number ? { unit: p.unit, number } : { unit: p.unit })
    } else if (typeof p.glue === 'string') {
      // RULING G9 (F8): same unknown-key discipline for a glue part.
      const extra = Object.keys(p).filter((k) => k !== 'glue')
      if (extra.length) return { ok: false, violation: `glue part carries unknown key(s): ${extra.join(', ')}` }
      if (!GLUE_WORDS.has(p.glue) && !GLUE_PUNCTUATION.has(p.glue)) {
        return { ok: false, violation: `glue token '${p.glue}' is outside the closed glue/punctuation set` }
      }
      out.push({ glue: p.glue })
    } else {
      return { ok: false, violation: `part is neither {"unit":...} nor {"glue":...}: ${JSON.stringify(p)}` }
    }
  }
  const grammarViolation = validateGrammar(out, byId)
  if (grammarViolation) return { ok: false, violation: grammarViolation }
  // RULING G4 (F3), keyed per RULING K2 on `isBrand` (never `kind === 'brand'` — a pool-sourced
  // brand unit is `kind: 'pool'` but still mandatory): when the composer's brand unit exists in the
  // admitted set, the arrangement MUST carry it — an arrangement that omits it ships unbranded even
  // though the composer's own line would have carried the brand waterfall (X17).
  const brandUnit = units.find((u) => u.isBrand)
  if (brandUnit && !seen.has(brandUnit.id)) {
    return { ok: false, violation: `missing required brand unit '${brandUnit.text}' — the composer's brand is mandatory for this family` }
  }
  return { ok: true, parts: out }
}

/** Renders a VALIDATED arrangement. Units appear verbatim (stored words, order, numbers and
 *  punctuation). Glue WORDS join with single spaces. Punctuation (RULING G9): `,` attaches to the
 *  word on its LEFT (no space before); `&`/`|`/`—` are space-padded on BOTH sides instead — they
 *  read as a join BETWEEN two whole phrases, not a trailing mark on the first one ("Tee & Vintage
 *  Beach Vibes", not "Tee& Vintage Beach Vibes"). Pure. Assumes `parts` already passed
 *  `validateArrangement` against the SAME `units`. */
export function renderArrangement(parts: readonly ArrangementPart[], units: readonly AdmittedUnit[]): string {
  const byId = new Map(units.map((u) => [u.id, u] as const))
  const renderUnitPart = (p: ArrangementUnitPart): string | null => {
    const u = byId.get(p.unit)
    if (!u) return null // unreachable once validated against the same `units`
    return p.number ? applyNumberToLastWord(u.text, p.number) : u.text
  }
  const out: string[] = []
  for (let idx = 0; idx < parts.length; idx++) {
    const p = parts[idx]
    let token: string
    if ('unit' in p) {
      const rendered = renderUnitPart(p)
      if (rendered === null) continue
      token = rendered
    } else if (p.glue === 'a' || p.glue === 'an') {
      // RULING K6 (fix round B4, value Minor "a/an"): the RENDERER chooses the correct spelling from
      // the NEXT unit's first letter — the model's own vowel choice is normalized, never trusted
      // (measured: the model wrote "with an Classic Fit"). Peeking ahead for the next unit part is
      // safe here — `validateArrangement`'s grammar walk already guarantees an article sits
      // immediately before a unit (K6's bare-article/two-glue rules).
      let nextText: string | null = null
      for (let j = idx + 1; j < parts.length; j++) {
        const np = parts[j]
        if ('unit' in np) { nextText = renderUnitPart(np); break }
      }
      token = /^[aeiou]/i.test((nextText ?? '').trim()) ? 'an' : 'a'
    } else {
      token = p.glue
    }
    if (PUNCTUATION_ATTACH_LEFT.has(token) && out.length > 0) {
      out[out.length - 1] = out[out.length - 1] + token
    } else {
      out.push(token)
    }
  }
  return out.join(' ')
}

// ─── B6/W7: READABILITY ────────────────────────────────────────────────────────────────────────

const LEAN_FEM_RE = new RegExp(`\\b(?:${LEAN_FEM_CORE})\\b`, 'i')
const LEAN_MASC_RE = new RegExp(`\\b(?:${LEAN_MASC_CORE})\\b`, 'i')
/** RULING K7 (fix round B4, value Important I1): "A clause is the text between `,` `—` `|` `&`." —
 *  `&` now splits too (was omitted, so "Tee & Crewneck & Cute Crewnecks & Sweatshirt" read as ONE
 *  clause and never tripped the keyword-list check at all). */
const READABILITY_CLAUSE_SPLIT_RE = /[,—|&]/
/** RULING K7: "A clause is keyword-shaped UNLESS it contains a RELATION join (`with`/`in`)." A
 *  LIST join (`and`, or the punctuation marks) no longer counts as "has a connecting word" — value
 *  I1 measured that a model chained bare phrases with `and` alone ("Tee and Crewneck, Cute
 *  Crewnecks and Positive Quote Sweatshirt") and every clause still read as a keyword dump despite
 *  "passing" the old, wider glue-word check. Only `with`/`in` — the words that actually attach a
 *  fact TO something, i.e. make the clause read as a sentence fragment rather than a list — count. */
const RELATION_WORDS_FOLDED: ReadonlySet<string> = new Set(['with', 'in'].map(ihFoldWord))
function clauseIsKeywordShaped(clause: string): boolean {
  const words = clause.match(WORD_RE) ?? []
  return !words.some((w) => RELATION_WORDS_FOLDED.has(ihFoldWord(w)))
}
function foldedContentWords(text: string): Set<string> {
  const s = new Set<string>()
  for (const w of text.match(WORD_RE) ?? []) { const f = ihFoldWord(w); if (f) s.add(f) }
  return s
}

export function writerReadabilityVerdict(line: string, units: readonly AdmittedUnit[]): { ok: true } | { ok: false; reason: string } {
  // W7 (B6.1 fix): FAIL when MORE THAN ONE clause is keyword-shaped — not only when every clause is
  // (the bug that let the PO's own "THIS READS AWFUL" line and the DQG line both pass).
  const clauses = line.split(READABILITY_CLAUSE_SPLIT_RE).map((s) => s.trim()).filter(Boolean)
  const keywordShaped = clauses.filter(clauseIsKeywordShaped).length
  if (keywordShaped > 1) {
    return { ok: false, reason: `reads as a keyword list (${keywordShaped} of ${clauses.length} clauses have no connecting word — more than one is not allowed)` }
  }
  // B6.2 — no gender-audience word beside "Unisex" (reuse the LEAN cores, no new list).
  if (/\bunisex\b/i.test(line) && (LEAN_FEM_RE.test(line) || LEAN_MASC_RE.test(line))) {
    return { ok: false, reason: 'states a gender audience beside "Unisex"' }
  }
  // B6.3 — names or evokes the design whenever an identity unit exists.
  const identityUnits = units.filter((u) => u.kind === 'identity')
  if (identityUnits.length > 0) {
    const lineFold = foldedContentWords(line)
    const namesDesign = identityUnits.some((u) => {
      const uWords = [...foldedContentWords(u.text)]
      return uWords.length > 0 && uWords.every((w) => lineFold.has(w))
    })
    if (!namesDesign) return { ok: false, reason: 'does not name or evoke the design' }
  }
  return { ok: true }
}

// ─── B4 point 2/3, B7: THE ONE JUDGE (validate -> render -> tail -> readability), idempotent ─────

export interface JudgeWriterLineCtx {
  truthCtx: PhraseTruthCtx
  /** The SAME post-compose tail the composer's own line runs through (`runIhTail` in
   *  listingPipeline.ts) — injected so this module never imports that file (see the header).
   *  RULING W4: `reason` additively carries the REAL refusal (e.g. `material-lie`), not only the
   *  coarser `hold` bucket every non-repeat refusal used to collapse onto (`under-floor`). */
  runTail: (line: string) => { value: string; hold: string | null; reason?: string | null }
}

export type JudgeWriterLineResult = { ok: true; value: string } | { ok: false; violations: string[] }

/** THE ONE sync judge (B4 point 2): validate the arrangement, render it VERBATIM, then the SAME
 *  deterministic tail the composer's own line runs (repeat budget, moved content rules, line truth
 *  net, floor door), then readability. Idempotent (B4 point 3): re-judging an arrangement that
 *  renders to an already-accepted composer line passes, because that line already satisfies every
 *  one of these gates by construction — nothing here re-parses the RENDERED text, so idempotence
 *  needs no special case. */
export function judgeWriterArrangement(raw: unknown, units: readonly AdmittedUnit[], ctx: JudgeWriterLineCtx): JudgeWriterLineResult {
  const v = validateArrangement(raw, units)
  if (!v.ok) return { ok: false, violations: [`arrangement: ${v.violation}`] }
  const line = renderArrangement(v.parts, units).trim()
  if (!line) return { ok: false, violations: ['arrangement: rendered to an empty line'] }
  // RULING G5 (F4): DEFENSIVE fail-closed, in front of the tail. Every one of these doors is
  // already an admission-time gate for identity units (G2, `buildAdmittedUnits`) — this is defense
  // in depth for anything that reaches the RENDERED line by another route (a pool/spec unit the
  // composer's own admission missed, or a combination effect). COMPARE, never rewrite (X19/X20):
  // a line `scrubTrademarks`/`scrubCelebrityNames` would change is a named rejection, not a silent
  // substitution — a silent substitution is exactly the push-boundary amputation review I2 found
  // ("World Cup Champs..." -> "World Futbol Cup Champs...", changing the CLAIM, not removing it).
  if (scrubTrademarks(line) !== line) {
    return { ok: false, violations: ['trademark: rendered line carries a protected mark'] }
  }
  if (scrubCelebrityNames(line, 'ih-writer') !== line || hasCelebrityName(line)) {
    return { ok: false, violations: ['celebrity: rendered line carries a celebrity name'] }
  }
  // RULING K5 (fix round B4, truth Important T39/non-monotone): judge every ADJACENT UNIT PAIR, as
  // rendered ("A join B"), with `phraseTruthVerdict` — not only the whole comma-clause the tail
  // judges. A cross-clause truth check is non-monotone: "Always Give 100% and Soft Cotton Feel" is
  // `material-lie` in isolation, but ships when the SAME comma clause also carries the true blend
  // fact ("... with 52% Cotton / 48% Polyester"), because the clause-level check sees two fibres and
  // reads "blend". Judging the tighter 2-unit span structurally (no lexicon: it is the SAME
  // `phraseTruthVerdict` every pool candidate already passes) catches the lie regardless of what
  // sits elsewhere in the clause.
  const unitPartIndices: number[] = []
  v.parts.forEach((p, idx) => { if ('unit' in p) unitPartIndices.push(idx) })
  for (let k = 0; k < unitPartIndices.length - 1; k++) {
    const span = renderArrangement(v.parts.slice(unitPartIndices[k], unitPartIndices[k + 1] + 1), units).trim()
    const spanVerdict = phraseTruthVerdict(span, ctx.truthCtx)
    if (!spanVerdict.ok) {
      return { ok: false, violations: [`join: '${span}' — ${spanVerdict.reason}`] }
    }
  }
  // RULING K1 (fix round B4, compliance B1; value B3): the judge's own band/repeat gates now check
  // the SAME predicates the push seam enforces, IMPORTED — never a copy — and run BEFORE the tail so
  // the retry message is precise. `lineHasSignificantRepeat` is the PO's absolute no-repeat rule
  // (each significant word once, a garment head noun up to twice) — Amazon's flat cap of 2 alone
  // (`ihRepeatViolations`) is not enough: a line that slips the composer's own stricter budget must
  // never ship from the writer either, or the writer becomes worse than the composer it replaces.
  if (line.length < CONTENT_CONTRACT.itemHighlights.min) {
    return { ok: false, violations: [`rendered ${line.length} chars, min ${CONTENT_CONTRACT.itemHighlights.min}`] }
  }
  if (line.length > CONTENT_CONTRACT.itemHighlights.max) {
    return { ok: false, violations: [`rendered ${line.length} chars, max ${CONTENT_CONTRACT.itemHighlights.max}`] }
  }
  if (lineHasSignificantRepeat(line)) {
    const word = findFirstSignificantRepeat(line)
    return { ok: false, violations: [`'${word ?? '?'}' used twice (only garment words may repeat, at most twice)`] }
  }
  const tail = ctx.runTail(line)
  if (!tail.value) {
    // Band/repeat are already clear above — a tail refusal here is always the tail's OWN
    // content/truth/floor gate (RULING W4: surface the REAL reason, e.g. "material-lie", never the
    // coarser hold bucket).
    return { ok: false, violations: [`tail: refused (${tail.reason ?? tail.hold ?? 'refused'})`] }
  }
  // RULING K1 (compliance B1; value I2): the tail must return the rendered bytes UNCHANGED. Any
  // edit — a dropped phrase (a repeat/length amputation the checks above did not anticipate) or an
  // inserted one (`ensureBlankBrandInHighlights`'s own brand prefix) — is a named rejection, never a
  // silent edit the model never chose (spec §2d rule 1: "It passes through the tail byte-identical").
  if (tail.value !== line) {
    return { ok: false, violations: [`the tail changed the line: ${tail.reason ?? 'edited by the post-compose net'}`] }
  }
  const read = writerReadabilityVerdict(tail.value, units)
  if (!read.ok) return { ok: false, violations: [`readability: ${read.reason}`] }
  // RULING K1 (compliance B1): the accepted line must ALSO be pushable by the push seam's OWN
  // classifier (`classifyStoredIhLine`, imported — never a copy) — "accepted" and "pushable" are the
  // SAME question from here on, never two.
  const pushClass = classifyStoredIhLine(tail.value)
  if (pushClass !== 'ok') {
    return { ok: false, violations: [`push-seam: ${pushClass}`] }
  }
  // RULING K2 (compliance B2, defense in depth): when this family's brand is mandatory, the FINAL
  // bytes must carry it through the composer's OWN carries-brand test (imported, never a copy) —
  // `validateArrangement`'s G4 rule already requires the brand UNIT's id in the arrangement; this
  // catches the residual case where the unit was present but the rendered/tailed bytes somehow do
  // not carry the brand text (a future tail edit, or a unit whose text itself does not literally
  // carry the brand — should not happen by construction, but this is defense in depth, not trust).
  const brandUnit = units.find((u) => u.isBrand)
  if (brandUnit && ctx.truthCtx.allowedBrand && !lineCarriesBrand(tail.value, ctx.truthCtx.allowedBrand)) {
    return { ok: false, violations: ['brand: rendered line does not carry the required brand'] }
  }
  return { ok: true, value: tail.value }
}

/** RULING K1: which significant word first exceeds its repeat budget in `line` — used only to name
 *  the word in the retry message; the GATE itself is `lineHasSignificantRepeat` above (imported from
 *  productDetailAttrs.ts, never re-implemented here). */
function findFirstSignificantRepeat(line: string): string | null {
  const counts = new Map<string, number>()
  for (const w of significantFolded(line)) {
    const c = (counts.get(w) ?? 0) + 1
    counts.set(w, c)
    if (c > ihRepeatBudget(w)) return w
  }
  return null
}

// ─── B5/B10: THE CLIENT + PROMPT (arrangement contract) ────────────────────────────────────────

/** Loose JSON extraction — local, tiny copy of this repo's own `parseJsonLoose` idiom
 *  (listingPipeline.ts), not imported: importing FROM listingPipeline.ts would cycle back into it
 *  (see this file's header). Strips a fenced code block if the model wrapped its JSON in one. */
function parseJsonLoose<T>(raw: string): T {
  const trimmed = (raw || '').trim()
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const body = fenced ? fenced[1] : trimmed
  try { return JSON.parse(body) as T } catch { return {} as T }
}

function unitsByKind(units: readonly AdmittedUnit[]): Record<AdmittedUnitKind, { id: string; text: string }[]> {
  const out: Record<AdmittedUnitKind, { id: string; text: string }[]> = {
    identity: [], 'spec-fact': [], brand: [], 'wear-fact': [], pool: [], 'garment-head': [],
  }
  for (const u of units) out[u.kind].push({ id: u.id, text: u.text })
  return out
}

/** RULING K4 (fix round B4, value B1/B2/Important): ONE rule registry — each writer rule the
 *  validator/judge/readability check can EMIT a violation for gets an id and a plain-English
 *  sentence here, and `buildWriterPrompt`'s system message is RENDERED from this list (never a
 *  second, hand-typed prose block that can drift out of sync with what actually gets enforced). The
 *  value lens measured that TWO enforced rules were never taught at all — the sentence-shape "at
 *  least one comma" rule (B1) and the "no gendered word beside Unisex" rule (B2) — so a model
 *  following the prompt literally still failed on the first call. `id` is referenced by
 *  `itemHighlightWriterRuleRegistry.test.ts`'s completeness pin: every id here must appear in the
 *  rendered prompt, so a rule can never be enforced without being taught. */
export interface WriterRuleSpec { id: string; sentence: string }
export const WRITER_RULE_REGISTRY: readonly WriterRuleSpec[] = [
  { id: 'shape', sentence: 'You arrange ONE Amazon Item Highlight line for a t-shirt/apparel listing out of ADMITTED UNITS — you do NOT write free text.' },
  { id: 'json-shape', sentence: 'Return JSON: {"parts": [...]} — an ORDERED list where each element is EITHER {"unit": "<id>"} (optionally {"unit": "<id>", "number": "singular"|"plural"}) OR {"glue": "<token>"}.' },
  { id: 'unit-verbatim', sentence: 'Every "unit" id must be one of the ids given to you below. Each unit may be used AT MOST ONCE. Units render VERBATIM — their own exact words, order, numbers and punctuation. The ONLY change you may request is "number" (singular/plural), and ONLY on a unit whose id is listed as numberable below.' },
  { id: 'closed-glue', sentence: `A "glue" token must be exactly one of these words: ${GLUE_WORDS_RAW.join(', ')} — or one of these punctuation marks: , — | &` },
  { id: 'no-invention', sentence: 'Do not invent a unit id, a glue token, or any text — every word in the final line comes from a unit you chose.' },
  {
    id: 'grammar',
    sentence: 'THE GRAMMAR (the only legal ways two units may sit next to each other): (1) two units may touch with NO glue between them ONLY when the RIGHT-hand one is a garment-head unit AND the LEFT-hand one is an identity or pool unit (e.g. "<design name> Sweatshirt", "<pool phrase> Tee") — never any other pairing, and never two garment-head units chained together. (2) "," "and" "&" "—" "|" are LIST joins and may join ANY two units — they assert nothing between the items, exactly like a plain list. (3) "with" and "in" are RELATION joins and may ONLY introduce a spec-fact, brand, or wear-fact unit — never a pool or identity unit (a relation must only ever attach a TRUE fact of this product; "with Deep Pockets" or "in Pink Lemonade" invent a feature/colour that is not a unit, which is exactly what this rule forbids). (4) No other glue word exists — do not use "for", "of", "to", "your", "on", "from", "that", "this" or "the"; they are not in the closed set above. No glue or punctuation may open or close the line, and no two glue tokens may sit next to each other except exactly one join immediately followed by "a"/"an".',
  },
  { id: 'article', sentence: '"a"/"an" may appear ONLY directly after a list or relation join, AND directly before a spec-fact unit whose own last word is "Fit" or "Neck" (e.g. "with a Classic Fit", "and a Crew Neck") — never before a pool/identity unit, never before a different kind of spec/brand/wear-fact unit, and NEVER standing alone with no join immediately before it. Write "a"/"an" as you see fit; the correct spelling for the following word is chosen for you automatically.' },
  { id: 'band', sentence: `The rendered line must be ${CONTENT_CONTRACT.itemHighlights.min}-${CONTENT_CONTRACT.itemHighlights.max} characters.` },
  { id: 'repeat', sentence: 'Repeat rule: each significant word may appear at most once, EXCEPT a garment head noun (shirt/tee/sweatshirt/hoodie/etc.), which may appear up to twice.' },
  { id: 'brand', sentence: 'When a "brand" unit is listed below, it is REQUIRED — your arrangement must use it somewhere, or it will be rejected.' },
  { id: 'sentence-shape', sentence: 'The arrangement must contain AT LEAST ONE "," (comma) glue token somewhere between two units — "—", "|" and "&" alone do NOT satisfy this, and an arrangement with zero commas will be rejected even if it otherwise reads well.' },
  { id: 'unisex-gender', sentence: 'Never put a gendered audience word (e.g. "Women", "Men", "Ladies") in the same line as a "Unisex" unit — the two contradict each other and will be rejected.' },
  { id: 'names-design', sentence: 'The rendered line must read as 2+ human phrases joined with a connecting word (not a bare comma-separated keyword dump), and if the design has an identity unit, the line must name or evoke it.' },
  { id: 'closing', sentence: 'If you cannot honestly build a good line from only the admitted units, still return your best attempt as {"parts": [...]} — do not apologize or explain, only the JSON.' },
]

/** Every id in `WRITER_RULE_REGISTRY` whose sentence should render UNCONDITIONALLY — the two
 *  exceptions (`brand`, gated on whether a brand unit exists) are rendered separately below. */
const CONDITIONAL_RULE_IDS: ReadonlySet<string> = new Set(['brand'])

/** W1: the prompt — the admitted units grouped by kind WITH THEIR IDS, the design name EXACTLY as
 *  stored (a misspelled seller name — "Billionare", "Definiton" — is reproduced verbatim), the
 *  closed glue/punctuation sets, and the arrangement contract itself, RENDERED from
 *  `WRITER_RULE_REGISTRY` (RULING K4) — a rule can never be enforced without being taught. The
 *  literal word "json" appears (bullet/backend council convention, `bullet-pad-pool-exhaustion`
 *  memory) so `response_format: json_object` never 400s. The model NEVER writes prose — only unit
 *  IDs and glue tokens survive to the render step, so there is nothing for a provenance parser to be
 *  fooled by any more. */
// Exported (RULING K4) so a test can assert the rendered prompt against `WRITER_RULE_REGISTRY`
// without making a live model call — `askWriter` is the only production caller.
export function buildWriterPrompt(units: readonly AdmittedUnit[], designName: string | null, priorViolations: readonly string[]): { system: string; user: string } {
  const grouped = unitsByKind(units)
  const hasBrand = units.some((u) => u.isBrand)
  const system = WRITER_RULE_REGISTRY
    .filter((r) => !CONDITIONAL_RULE_IDS.has(r.id) || (r.id === 'brand' && hasBrand))
    .map((r) => r.sentence)
    .join(' ')
  const numberableIds = units.filter((u) => u.numberable).map((u) => u.id)
  // RULING K4 (value I3): each unit's character length and the join costs, so the model can COUNT
  // toward the band instead of guessing — the value lens measured the commonest failure
  // (under-floor) carried no way for the model to know how close it was.
  const lengths = units.map((u) => `${u.id}=${u.text.length}c`).join(', ')
  const joinCosts = '", " = 2 chars, " and "/" with "/" in " = 5-7 chars, " — "/" | "/" & " = 3 chars, "a "/"an " = 2-3 chars'
  const user = [
    `DESIGN NAME (reproduce spelling EXACTLY, including any typo): ${JSON.stringify(designName ?? '')}`,
    `ADMITTED UNITS (json), grouped by kind, each {"id":"...","text":"..."} — arrange these ids, never their text:`,
    JSON.stringify(grouped),
    `Unit character lengths (to help you count toward the ${CONTENT_CONTRACT.itemHighlights.min}-${CONTENT_CONTRACT.itemHighlights.max} band): ${lengths}`,
    `Join costs (added between units, roughly): ${joinCosts}`,
    `Numberable unit ids (the only ones "number" may target): ${JSON.stringify(numberableIds)}`,
    priorViolations.length
      ? `Your previous attempt was REJECTED for: ${priorViolations.join('; ')}. Fix these specific problems by choosing a DIFFERENT arrangement — do not repeat the same rejected parts.`
      : '',
  ].filter(Boolean).join('\n')
  return { system, user }
}

/** B5/B10: one writer call. `maxRetries: 0` (this repo's LOAD-BEARING gateway policy), per-call
 *  EMPTY + finish_reason + model logging (the #176 lesson). Never reads an env file directly and
 *  never logs the API key — the client comes from `getLlmClientForRequest` (llmGateway.ts), which
 *  resolves it exactly as every other production caller does. Returns the PARSED JSON (or `{}` on any
 *  parse/call failure) — never a text `line`; `judgeWriterArrangement` validates the shape. */
async function askWriter(openai: OpenAI, model: string, units: readonly AdmittedUnit[], designName: string | null, priorViolations: readonly string[]): Promise<unknown> {
  const { system, user } = buildWriterPrompt(units, designName, priorViolations)
  try {
    const isGpt5 = /^(gpt-5|o\d)/.test(model)
    const messages = [{ role: 'system' as const, content: system }, { role: 'user' as const, content: user }]
    const r = await openai.chat.completions.create(
      isGpt5
        ? { model, messages, max_completion_tokens: 400, reasoning_effort: 'low' as const, response_format: { type: 'json_object' as const } }
        : { model, messages, temperature: 0.4, max_tokens: 250, response_format: { type: 'json_object' as const } },
      { timeout: 20_000, maxRetries: 0 },
    )
    const content = r.choices[0]?.message?.content || ''
    if (!content.trim()) console.warn(`[ih-writer] ${model} returned EMPTY content — finish_reason=${r.choices[0]?.finish_reason ?? '?'}`)
    return parseJsonLoose<unknown>(content || '{}')
  } catch (e) {
    console.warn(`[ih-writer] ${model} call FAILED: ${e instanceof Error ? e.message : String(e)}`)
    return {}
  }
}

// ─── B7/B8/W8: BOUNDED, FAIL-CLOSED RUN FOR ONE DESIGN ─────────────────────────────────────────

/** B7: 1 + 2 retries PER DESIGN. Distinct from `ihWriterMaxCallsBudget()` above (the PER-REGEN
 *  budget across every design, W8) — renamed from the pre-W8 export `IH_WRITER_MAX_CALLS` to avoid
 *  colliding with that new, differently-scoped env-var name. */
export const IH_WRITER_RETRY_CAP = 3

export interface WriterRunResult {
  accepted: boolean
  value: string
  reasons: string[]
  calls: number
}

export interface WriterDeps {
  openai?: OpenAI | null
}

/** B7/B8/W8: runs the bounded writer loop for ONE design and returns whether an accepted line
 *  resulted. Eligibility (B8, extended by W8): no call for `unrated-pool`, zero admitted pool
 *  candidates, a non-apparel family (`garmentFamily === 'none'`), fewer than 2 admitted units total,
 *  or an admitted set whose units — each used once, joined with single separators — cannot reach the
 *  contract's floor. Fail-closed (B7): after `IH_WRITER_RETRY_CAP` attempts, `accepted: false` — the
 *  caller falls back to the composer's OWN vetted result, never an empty string over stored content. */
export async function runWriterForDesign(args: {
  composed: Pick<ComposerResult, 'candidates' | 'specFacts' | 'brandPick' | 'wearFact'>
  fallbackHold: string | null
  designName: string | null
  identityPhrases?: readonly string[]
  truthCtx: PhraseTruthCtx
  runTail: (line: string) => { value: string; hold: string | null; reason?: string | null }
  deps?: WriterDeps
  model?: string
}): Promise<WriterRunResult> {
  // B8 eligibility.
  if (args.fallbackHold === 'unrated-pool') return { accepted: false, value: '', reasons: ['skip: unrated-pool'], calls: 0 }
  const pool = args.composed.candidates ?? []
  if (pool.length === 0) return { accepted: false, value: '', reasons: ['skip: zero admitted pool units'], calls: 0 }
  // W8: non-apparel families never write (the field composes no garment vocabulary for them either).
  if (args.truthCtx.garmentFamily === 'none') return { accepted: false, value: '', reasons: ['skip: non-apparel family'], calls: 0 }

  const units = buildAdmittedUnits(args.composed, { designName: args.designName, identityPhrases: args.identityPhrases, truthCtx: args.truthCtx })
  // W8: fewer than 2 admitted units, or the best possible join of every unit (no writer could ever
  // beat the composer's own attempt) cannot reach the floor — skip before spending a call.
  if (units.length < 2) return { accepted: false, value: '', reasons: ['skip: fewer than 2 admitted units'], calls: 0 }
  const maxPossibleLine = units.map((u) => u.text).join(', ')
  if (maxPossibleLine.length < CONTENT_CONTRACT.itemHighlights.min) {
    return { accepted: false, value: '', reasons: [`skip: admitted units cannot reach the floor (best case ${maxPossibleLine.length}c < ${CONTENT_CONTRACT.itemHighlights.min}c)`], calls: 0 }
  }

  const openai = args.deps?.openai ?? (await getLlmClientForRequest().catch(() => null))
  if (!openai) return { accepted: false, value: '', reasons: ['skip: no LLM client available'], calls: 0 }

  const model = args.model ?? ihWriterModel()
  const reasonsAll: string[] = []
  let priorViolations: string[] = []
  for (let call = 1; call <= IH_WRITER_RETRY_CAP; call++) {
    const draft = await askWriter(openai, model, units, args.designName, priorViolations)
    const verdict = judgeWriterArrangement(draft, units, { truthCtx: args.truthCtx, runTail: args.runTail })
    if (verdict.ok) return { accepted: true, value: verdict.value, reasons: reasonsAll, calls: call }
    reasonsAll.push(...verdict.violations)
    priorViolations = verdict.violations
  }
  return { accepted: false, value: '', reasons: reasonsAll, calls: IH_WRITER_RETRY_CAP }
}

// Re-exported so a caller/test can reference the exact regex set the build-time collision guard
// checks against, without reaching back into contentTruth.ts's own module-private names.
export const WRITER_TRUTH_REGEXES: Readonly<Record<string, RegExp>> = {
  audienceKids: KIDS_AUDIENCE_RE,
  audienceAdult: ADULT_AUDIENCE_RE,
  fit: FIT_CLAIM_RE,
  purity: PURITY_ADJACENT_RE,
  fibre: FIBER_RE,
  capability: PERFORMANCE_CLAIM_RE,
}
