/**
 * itemHighlightWriter.ts — THE Item Highlight WRITER (docs/superpowers/specs/2026-09-10-item-
 * highlight-writer.md, §2 as amended by §2a and §2b; rulings
 * .superpowers/sdd/2026-09-10-ih-writer/phase-b-fix-rulings.md, W1-W10).
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
import { ihFoldWord, IH_GARMENT_HEAD_FOLDED } from '@/lib/fba/productDetailAttrs'
import { titleCasePhrase } from '@/lib/fba/titleBand'
import { CONTENT_CONTRACT } from '@/lib/fba/contentContract'
import { type ComposerResult } from '@/lib/fba/itemHighlightComposer'
import { getLlmClientForRequest } from '@/lib/fba/llmGateway'

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
   *  ONLY unit shape an arrangement's `number` field may target (rule (a), W1). */
  numberable: boolean
}

/** Does `text`'s LAST tokenized word fold to a garment head noun? Reuses the SAME derivation
 *  (`IH_GARMENT_HEAD_FOLDED`, itself derived from `GARMENT_HEAD_WORDS` via `ihFoldWord` —
 *  productDetailAttrs.ts) every other repeat-budget/garment-noun consumer in this codebase reads —
 *  never a second hand-written list. */
function lastWordMatch(text: string): { word: string; index: number } | null {
  const matches = [...text.matchAll(WORD_RE)]
  if (!matches.length) return null
  const last = matches[matches.length - 1]
  return { word: last[0], index: last.index ?? 0 }
}
function isNumberable(text: string): boolean {
  const last = lastWordMatch(text)
  return !!last && IH_GARMENT_HEAD_FOLDED.has(ihFoldWord(last.word))
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
  composed: Pick<ComposerResult, 'candidates' | 'specFacts' | 'brandPick' | 'wearFact'>,
  opts: { designName?: string | null; identityPhrases?: readonly string[]; truthCtx: PhraseTruthCtx },
): AdmittedUnit[] {
  const units: AdmittedUnit[] = []
  let n = 0
  const push = (text: string, kind: AdmittedUnitKind) => {
    units.push({ id: `u${n++}`, text, kind, numberable: isNumberable(text) })
  }

  const identityTexts = [opts.designName, ...(opts.identityPhrases ?? [])]
    .filter((s): s is string => !!s && !!s.trim())
    .map((s) => s.trim())
  const seenIdentity = new Set<string>()
  for (const text of identityTexts) {
    const key = text.toLowerCase()
    if (seenIdentity.has(key)) continue
    seenIdentity.add(key)
    if (phraseTruthVerdict(text, opts.truthCtx).ok) push(text, 'identity')
  }
  for (const text of composed.specFacts ?? []) push(text, 'spec-fact')
  if (composed.brandPick) push(composed.brandPick, 'brand')
  if (composed.wearFact) push(composed.wearFact, 'wear-fact')
  for (const text of composed.candidates ?? []) push(text, 'pool')

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

// ─── W1: THE CLOSED GLUE + PUNCTUATION SETS ───────────────────────────────────────────────────────

/** Function words that carry no product claim — ruling B2's literal starting list, unchanged by W1.
 *  An arrangement's `{"glue": "..."}` part must match one of these EXACTLY (case-sensitive — the
 *  model is instructed to use these exact lowercase spellings), or one of `GLUE_PUNCTUATION` below. */
const GLUE_WORDS_RAW = ['a', 'an', 'the', 'and', 'with', 'in', 'for', 'of', 'to', 'your', 'on', 'from', 'that', 'this'] as const
export const GLUE_WORDS: ReadonlySet<string> = new Set(GLUE_WORDS_RAW)
/** The FOLDED form of the same list — used only by readability's clause scan (B6.1/W7) on the
 *  RENDERED line, where casing/inflection may vary; arrangement validation (W1 rule (c)) uses the
 *  exact-string `GLUE_WORDS` above instead. */
const GLUE_WORDS_FOLDED: ReadonlySet<string> = new Set(GLUE_WORDS_RAW.map(ihFoldWord))

/** W1's closed punctuation set. Attaches to the word on its LEFT when rendered (no space before;
 *  the ordinary inter-token space still follows, via the render join). */
export const GLUE_PUNCTUATION: ReadonlySet<string> = new Set([',', '—', '|', '&'])

/** NEVER glue (ruling B2, verbatim, unchanged by W1): negations, quantifiers, purity words, gendered
 *  pronouns. Not consumed at runtime (they simply are never added to `GLUE_WORDS` above) — kept as
 *  data so a test can assert `GLUE_WORDS` never grows to include one of these AND that none of them
 *  (nor any glue word) matches an exported truth regex (the build-time collision guard, kept from B2
 *  per ruling W1: "Keep the glue-vs-lexicon disjointness test."). */
export const NEVER_GLUE_WORDS: readonly string[] = ['not', 'no', 'without', 'non', 'all', 'only', 'just', 'pure', 'entirely', 'nothing', 'her', 'his', 'him', 'she', 'he']

const WORD_RE = /[A-Za-z0-9]+(?:['’][A-Za-z]+)*/g

// ─── W1: THE SINGULAR/PLURAL TOGGLE (the ONLY permitted change inside a unit) ─────────────────────

/** Explicit singular/plural pairs for the closed `GARMENT_HEAD_WORDS` vocabulary (garmentNoun.ts) —
 *  hand-paired rather than a generic English inflector, because a generic rule mis-pluralizes
 *  irregular members of this exact list (e.g. "dress" → "dresss"). Adding a WORD here never adds new
 *  VOCABULARY (the fold-derivation `IH_GARMENT_HEAD_FOLDED` already gates which units are numberable
 *  at all) — it only teaches the renderer the other half of a pair already in that closed list. */
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

/**
 * W1 validation (pure, exported), rejecting with a NAMED violation for the retry:
 *   (a) a unit ID that does not exist;
 *   (b) a unit used twice;
 *   (c) a glue token outside the closed GLUE set or the closed punctuation set;
 *   (d) `number` on a unit whose LAST word is not a garment head noun.
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
      if (!GLUE_WORDS.has(p.glue) && !GLUE_PUNCTUATION.has(p.glue)) {
        return { ok: false, violation: `glue token '${p.glue}' is outside the closed glue/punctuation set` }
      }
      out.push({ glue: p.glue })
    } else {
      return { ok: false, violation: `part is neither {"unit":...} nor {"glue":...}: ${JSON.stringify(p)}` }
    }
  }
  return { ok: true, parts: out }
}

/** Renders a VALIDATED arrangement. Units appear verbatim (stored words, order, numbers and
 *  punctuation), glue joins with single spaces, and punctuation attaches to the word on its left
 *  (W1). Pure. Assumes `parts` already passed `validateArrangement` against the SAME `units`. */
export function renderArrangement(parts: readonly ArrangementPart[], units: readonly AdmittedUnit[]): string {
  const byId = new Map(units.map((u) => [u.id, u] as const))
  const out: string[] = []
  for (const p of parts) {
    let token: string
    if ('unit' in p) {
      const u = byId.get(p.unit)
      if (!u) continue // unreachable once validated against the same `units`
      token = p.number ? applyNumberToLastWord(u.text, p.number) : u.text
    } else {
      token = p.glue
    }
    if (GLUE_PUNCTUATION.has(token) && out.length > 0) {
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
/** W7: "A clause is the text between `,` `—` `|`." — narrower than the old provenance run-splitter
 *  (which also split on `– ; : &`); this is a rendered-line readability check, not a segmentation. */
const READABILITY_CLAUSE_SPLIT_RE = /[,—|]/
/** W7: "A keyword-shaped clause contains no glue word." — no length exemption for a short clause any
 *  more (the PO's own line's "Classic Fit"/"Graphic Crewneck" 2-word facts are exactly the
 *  keyword-shaped clauses this rule must count). */
function clauseIsKeywordShaped(clause: string): boolean {
  const words = clause.match(WORD_RE) ?? []
  return !words.some((w) => GLUE_WORDS_FOLDED.has(ihFoldWord(w)))
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
  const tail = ctx.runTail(line)
  if (!tail.value) {
    // RULING W4: surface the REAL reason (e.g. "material-lie"), never the coarser hold bucket, when
    // the tail's own gates named one.
    return { ok: false, violations: [`tail: refused (${tail.reason ?? tail.hold ?? 'refused'})`] }
  }
  const read = writerReadabilityVerdict(tail.value, units)
  if (!read.ok) return { ok: false, violations: [`readability: ${read.reason}`] }
  return { ok: true, value: tail.value }
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

/** W1: the prompt — the admitted units grouped by kind WITH THEIR IDS, the design name EXACTLY as
 *  stored (a misspelled seller name — "Billionare", "Definiton" — is reproduced verbatim), the
 *  closed glue/punctuation sets, and the arrangement contract itself. The literal word "json" appears
 *  (bullet/backend council convention, `bullet-pad-pool-exhaustion` memory) so `response_format:
 *  json_object` never 400s. The model NEVER writes prose — only unit IDs and glue tokens survive to
 *  the render step, so there is nothing for a provenance parser to be fooled by any more. */
function buildWriterPrompt(units: readonly AdmittedUnit[], designName: string | null, priorViolations: readonly string[]): { system: string; user: string } {
  const grouped = unitsByKind(units)
  const system = [
    'You arrange ONE Amazon Item Highlight line for a t-shirt/apparel listing out of ADMITTED UNITS — you do NOT write free text.',
    'Return JSON: {"parts": [...]} — an ORDERED list where each element is EITHER {"unit": "<id>"} (optionally {"unit": "<id>", "number": "singular"|"plural"}) OR {"glue": "<token>"}.',
    `Every "unit" id must be one of the ids given to you below. Each unit may be used AT MOST ONCE. Units render VERBATIM — their own exact words, order, numbers and punctuation. The ONLY change you may request is "number" (singular/plural), and ONLY on a unit whose id is listed as numberable below.`,
    `A "glue" token must be exactly one of these words: ${GLUE_WORDS_RAW.join(', ')} — or one of these punctuation marks: , — | &`,
    'Do not invent a unit id, a glue token, or any text — every word in the final line comes from a unit you chose.',
    'The rendered line must read as 2+ human phrases joined with a connecting word (not a bare comma-separated keyword dump), and if the design has an identity unit, the line must name or evoke it.',
    'If you cannot honestly build a good line from only the admitted units, still return your best attempt as {"parts": [...]} — do not apologize or explain, only the JSON.',
  ].join(' ')
  const numberableIds = units.filter((u) => u.numberable).map((u) => u.id)
  const user = [
    `DESIGN NAME (reproduce spelling EXACTLY, including any typo): ${JSON.stringify(designName ?? '')}`,
    `ADMITTED UNITS (json), grouped by kind, each {"id":"...","text":"..."} — arrange these ids, never their text:`,
    JSON.stringify(grouped),
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
