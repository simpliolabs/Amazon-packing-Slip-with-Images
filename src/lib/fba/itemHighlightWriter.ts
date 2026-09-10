/**
 * itemHighlightWriter.ts — THE Item Highlight WRITER (docs/superpowers/specs/2026-09-10-item-
 * highlight-writer.md, §2 as AMENDED by §2a; rulings
 * .superpowers/sdd/2026-09-10-ih-writer/phase-a3-and-b-rulings.md PART 2, B1-B10).
 *
 * WHY A LEAF, NOT WIRED INTO listingPipeline.ts DIRECTLY. This module owns provenance (B2),
 * readability (B6), the client + prompt (B5/B10) and the bounded retry loop (B7/B8) — everything the
 * writer needs to judge and produce ONE candidate line. It has ZERO import of `listingPipeline.ts`:
 * every place this module would otherwise need that file's own logic (the post-compose TAIL —
 * `runIhTail`, repeat budget + line truth net + floor door) is instead handed in as a CALLBACK
 * (`runTail`) by the caller. `listingPipeline.ts` imports FROM this module (the async
 * `produceItemHighlights`/`produceItemHighlightsPerDesign` wrappers live there, next to the sync
 * builders and `runIhTail` they already own) — never the other way — so the dependency graph stays
 * acyclic (this module sits beside `contentTruth.ts`/`productDetailAttrs.ts` as a leaf).
 *
 * THE LOAD-BEARING IDEA (spec §2a): admission is a set of UNITS, not a bag of words. A unit is used
 * WHOLE (atomic: design identity, spec facts, the brand phrase, the wear fact, and any unit carrying
 * a digit or "%") or IN PART (a pool phrase only — dropping words from a shopper phrase). A PARTIAL
 * segment is re-judged by `phraseTruthVerdict` WITHOUT the design-own-word exemption, because that
 * exemption justifies a word only inside the phrase that carried it — that is what rejects "Girls"
 * pulled out of "Girl Dad Tee for Girls" (`designTokens: ['Girl Dad']`), the exact case token-level
 * provenance admits (every token folds back to the design name) and §2a exists to close.
 */
import type OpenAI from 'openai'
import {
  phraseTruthVerdict, LEAN_FEM_CORE, LEAN_MASC_CORE,
  KIDS_AUDIENCE_RE, ADULT_AUDIENCE_RE, FIT_CLAIM_RE, PURITY_ADJACENT_RE, FIBER_RE,
  type PhraseTruthCtx, type PhraseTruthReason,
} from '@/lib/fba/contentTruth'
import { PERFORMANCE_CLAIM_RE } from '@/lib/fba/blankSpecs'
import { ihFoldWord } from '@/lib/fba/productDetailAttrs'
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

// ─── B2: ADMITTED UNITS ────────────────────────────────────────────────────────────────────────

export type AdmittedUnitKind = 'identity' | 'spec-fact' | 'brand' | 'wear-fact' | 'pool'

export interface AdmittedUnit {
  text: string
  kind: AdmittedUnitKind
  /** ATOMIC units (identity, spec facts, brand, wear fact, and any unit carrying a digit or "%")
   *  must be used WHOLE — reordering/inflection allowed, nothing may be dropped. A non-atomic (pool)
   *  unit may also be used IN PART. */
  atomic: boolean
}

/** B1: builds the writer's admitted set FROM the composer's own additively-exposed fields
 *  (`ComposerResult.candidates`/`specFacts`/`brandPick`/`wearFact`) plus the design's own identity —
 *  never re-implements the composer's filtering. Identity units (the design name as stored, plus the
 *  group's vision `identityPhrases`) are admitted only when `phraseTruthVerdict` passes them against
 *  the design's own truthCtx — a design whose own name asserts something the blank does not back
 *  (a garment lie, a capability claim) is not laundered into an admitted fact just because it is the
 *  design's own vocabulary. */
export function buildAdmittedUnits(
  composed: Pick<ComposerResult, 'candidates' | 'specFacts' | 'brandPick' | 'wearFact'>,
  opts: { designName?: string | null; identityPhrases?: readonly string[]; truthCtx: PhraseTruthCtx },
): AdmittedUnit[] {
  const units: AdmittedUnit[] = []
  const identityTexts = [opts.designName, ...(opts.identityPhrases ?? [])]
    .filter((s): s is string => !!s && !!s.trim())
    .map((s) => s.trim())
  const seenIdentity = new Set<string>()
  for (const text of identityTexts) {
    const key = text.toLowerCase()
    if (seenIdentity.has(key)) continue
    seenIdentity.add(key)
    if (phraseTruthVerdict(text, opts.truthCtx).ok) units.push({ text, kind: 'identity', atomic: true })
  }
  for (const text of composed.specFacts ?? []) units.push({ text, kind: 'spec-fact', atomic: true })
  if (composed.brandPick) units.push({ text: composed.brandPick, kind: 'brand', atomic: true })
  if (composed.wearFact) units.push({ text: composed.wearFact, kind: 'wear-fact', atomic: true })
  for (const text of composed.candidates ?? []) units.push({ text, kind: 'pool', atomic: /[\d%]/.test(text) })
  return units
}

// ─── B2: THE CLOSED GLUE LIST ──────────────────────────────────────────────────────────────────

/** Function words that carry no product claim — ruling B2's literal starting list. Splitting on
 *  these (in addition to punctuation) is what turns "Girl Dad Tee **for** Girls" into two
 *  independently-judged runs instead of one, so "Girls" cannot borrow the identity's exemption by
 *  mere adjacency. */
const GLUE_WORDS_RAW = ['a', 'an', 'the', 'and', 'with', 'in', 'for', 'of', 'to', 'your', 'on', 'from', 'that', 'this']
export const GLUE_WORDS: ReadonlySet<string> = new Set(GLUE_WORDS_RAW.map(ihFoldWord))

/** NEVER glue (ruling B2, verbatim): negations, quantifiers, purity words, gendered pronouns. Not
 *  consumed at runtime by the segmenter (they simply are never added to `GLUE_WORDS` above) — kept as
 *  data so a test can assert `GLUE_WORDS` never grows to include one of these AND that none of them
 *  (nor any glue word) matches an exported truth regex (the build-time collision guard B2 asks for). */
export const NEVER_GLUE_WORDS: readonly string[] = ['not', 'no', 'without', 'non', 'all', 'only', 'just', 'pure', 'entirely', 'nothing', 'her', 'his', 'him', 'she', 'he']

// ─── B2: TOKENIZE + SEGMENT ────────────────────────────────────────────────────────────────────

const PUNCT_SPLIT_RE = /[,—–|;:&]/
const WORD_RE = /[A-Za-z0-9]+(?:['’][A-Za-z]+)*/g

/** Splits `line` into RUNS at punctuation only (`, — – | ; : &`) — one run per clause, GLUE WORDS
 *  KEPT IN PLACE. Glue needs no provenance of its own, but it may sit INSIDE a genuine admitted
 *  unit's own wording ("Dad **of** Girls Gift", "Can be worn **as** Oversized") — severing the run at
 *  every glue word BEFORE matching would make such a unit unmatchable as a WHOLE, even when the
 *  writer reproduced it verbatim. `contentFoldedMultiset` below is where glue actually drops out of
 *  the comparison — symmetrically, on both the candidate segment AND every unit it is compared
 *  against — so a segment may legally SPAN a glue word while an isolated glue-only span (no content
 *  word at all) still trivially auto-passes. Tokenizes apostrophe-bearing words ("Girl's", "That's")
 *  as ONE token each — never split into a bare trailing "s" (the A7 defect class the reverted
 *  `wordsOf` helper caused; this tokenizer has no relationship to that code). */
function splitIntoRuns(line: string): string[][] {
  return line.split(PUNCT_SPLIT_RE)
    .map((clause) => clause.match(WORD_RE) ?? [])
    .filter((words) => words.length > 0)
}

/** Every word, folded, INCLUDING glue — used to judge admissibility mechanics is wrong on glue;
 *  kept only as the general-purpose fold used elsewhere (readability). */
function foldedMultiset(text: string): Map<string, number> {
  const m = new Map<string, number>()
  for (const w of text.match(WORD_RE) ?? []) {
    const f = ihFoldWord(w)
    if (!f) continue
    m.set(f, (m.get(f) ?? 0) + 1)
  }
  return m
}

/** The CONTENT fold — glue words dropped, MULTISET (order lost). Used only for ATOMIC units, which
 *  spec §2a point 2 explicitly allows to be "reordered or inflected" when used whole. */
function contentFoldedMultiset(text: string): Map<string, number> {
  const m = new Map<string, number>()
  for (const w of text.match(WORD_RE) ?? []) {
    const f = ihFoldWord(w)
    if (!f || GLUE_WORDS.has(f)) continue
    m.set(f, (m.get(f) ?? 0) + 1)
  }
  return m
}
const multisetEquals = (a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>): boolean => {
  if (a.size !== b.size) return false
  for (const [k, v] of a) if (b.get(k) !== v) return false
  return true
}

/** The CONTENT fold, ORDER PRESERVED — glue words dropped, sequence kept. Used for POOL units, which
 *  spec §2a point 3 grants no reordering privilege (only "used in part" — dropping words). A pool
 *  unit's WHOLE match therefore requires the segment's content words to appear in the SAME ORDER the
 *  unit itself uses them, not merely the same bag of words — "Girls Graphic Tee" is NOT the same use
 *  as "Graphic Tee For Girls" reordered; it is either the picker's own pre-existing admission (if the
 *  pool ever surfaces that exact phrase) or nothing this segmenter can explain, never a NEW
 *  recombination privilege the writer gains that the picker did not already have. */
function contentFoldedSequence(text: string): string[] {
  const seq: string[] = []
  for (const w of text.match(WORD_RE) ?? []) {
    const f = ihFoldWord(w)
    if (!f || GLUE_WORDS.has(f)) continue
    seq.push(f)
  }
  return seq
}
const sequencesEqual = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((w, i) => w === b[i])
/** Does `sub` appear as an IN-ORDER (not necessarily contiguous) subsequence of `sup`? This is what
 *  "used in part" means for a pool unit — the segment may skip words the unit has, never reorder the
 *  ones it keeps. */
const isOrderedSubsequence = (sub: readonly string[], sup: readonly string[]): boolean => {
  if (sub.length === 0) return false
  let i = 0
  for (const w of sup) { if (i < sub.length && sub[i] === w) i++ }
  return i === sub.length
}

interface SegmentCheck { admissible: boolean; ok: boolean; reason?: PhraseTruthReason | 'invention'; whole?: boolean }

/** For ONE candidate segment (a consecutive slice of a run), asks: does SOME admitted unit support
 *  it (whole-exact, or "used in part" for a non-atomic pool unit), and if so does `phraseTruthVerdict`
 *  accept it under the mode that match implies (WHOLE -> the design's own truthCtx; PARTIAL -> the
 *  SAME ctx with `designTokens` stripped, per spec §2a point 3)? Tries every admitting unit and
 *  returns the first PASSING interpretation, else the first FAILING one (so a segment explainable by
 *  several units is judged charitably, exactly as a human reader would resolve the ambiguity —
 *  provenance's job is "can this be honestly attributed", not "which one attribution did the writer
 *  intend"). `admissible: false` means no unit's vocabulary can explain the segment at all — an
 *  invention, the class free text makes possible and a lexicon-based net cannot bound.
 *
 *  WHOLE keeps the design's own truthCtx regardless of unit kind: "the exemption justifies a word
 *  only inside the phrase that carried it" (spec §2a point 3) — a segment that reproduces an admitted
 *  unit VERBATIM (same words, same order for a pool unit; any order for an atomic one) is EXACTLY the
 *  phrase the composer's own admission already judged with this ctx. The spec's own safety property
 *  is "the writer can say nothing the PICKER could not have admitted" (§2a "Consequence") — bounded
 *  by the picker's own admission (a pre-existing, separately-filed picker-level gap included), never
 *  a promise that provenance silently repairs one. PARTIAL (a pool unit with words dropped) strips
 *  it: dropping words is what turns "Dad of Girls Shirt" (a relation, admitted whole) into "Girls"
 *  alone (a bare audience claim). */
function checkSegment(words: readonly string[], units: readonly AdmittedUnit[], truthCtx: PhraseTruthCtx): SegmentCheck {
  const segText = words.join(' ')
  const segSeq = contentFoldedSequence(segText)
  if (segSeq.length === 0) return { admissible: true, ok: true }
  const segMultiset = contentFoldedMultiset(segText)
  let bestFail: SegmentCheck | null = null
  for (const u of units) {
    let isWhole: boolean
    let isPartial: boolean
    if (u.atomic) {
      isWhole = multisetEquals(segMultiset, contentFoldedMultiset(u.text))
      isPartial = false
    } else {
      const unitSeq = contentFoldedSequence(u.text)
      isWhole = sequencesEqual(segSeq, unitSeq)
      isPartial = !isWhole && isOrderedSubsequence(segSeq, unitSeq)
    }
    if (!isWhole && !isPartial) continue
    const judgeCtx: PhraseTruthCtx = isWhole ? truthCtx : { ...truthCtx, designTokens: [] }
    const verdict = phraseTruthVerdict(segText, judgeCtx)
    if (verdict.ok) return { admissible: true, ok: true }
    if (!bestFail) bestFail = { admissible: true, ok: false, reason: verdict.reason, whole: isWhole }
  }
  return bestFail ?? { admissible: false, ok: false, reason: 'invention' }
}

/** DP word-break over ONE run (spec §2a point 2: "must partition (DP; lines are short)"). Returns
 *  `ok` when SOME full partition into admissible-AND-passing segments exists. On failure, walks a
 *  witness partition (preferring any full admissible coverage, even one with a failing segment, over
 *  none at all) to name the first concrete violation — an invention when no unit even TRACES to the
 *  offending word(s), else the segment-truth reason `phraseTruthVerdict` gave. */
function judgeRun(words: readonly string[], units: readonly AdmittedUnit[], truthCtx: PhraseTruthCtx): { ok: true } | { ok: false; violation: string } {
  const n = words.length
  const cache = new Map<string, SegmentCheck>()
  const get = (i: number, j: number): SegmentCheck => {
    const key = `${i}:${j}`
    let c = cache.get(key)
    if (!c) { c = checkSegment(words.slice(i, j), units, truthCtx); cache.set(key, c) }
    return c
  }
  const dpOk: boolean[] = new Array(n + 1).fill(false)
  dpOk[n] = true
  for (let i = n - 1; i >= 0; i--) {
    for (let j = i + 1; j <= n; j++) {
      if (get(i, j).admissible && get(i, j).ok && dpOk[j]) { dpOk[i] = true; break }
    }
  }
  if (dpOk[0]) return { ok: true }

  // No fully-passing partition. Find a fully-ADMISSIBLE one (regardless of truth) to name the
  // specific failing segment, longest-segment-first so the report names the most informative unit.
  const dpAdm: boolean[] = new Array(n + 1).fill(false)
  const admNext: number[] = new Array(n + 1).fill(-1)
  dpAdm[n] = true
  for (let i = n - 1; i >= 0; i--) {
    for (let j = n; j > i; j--) {
      if (get(i, j).admissible && dpAdm[j]) { dpAdm[i] = true; admNext[i] = j; break }
    }
  }
  if (dpAdm[0]) {
    let i = 0
    while (i < n) {
      const j = admNext[i]
      const c = get(i, j)
      if (!c.ok) {
        const segText = words.slice(i, j).join(' ')
        const violation = c.reason === 'invention'
          ? `'${segText}' traces to no admitted fact`
          : c.whole
            ? `whole-unit segment '${segText}' -> ${c.reason}`
            : `partial segment '${segText}' -> ${c.reason}`
        return { ok: false, violation }
      }
      i = j
    }
    return { ok: false, violation: `'${words.join(' ')}' fails provenance` }
  }

  // No admissible partition at all — some word traces to nothing. Report the first uncoverable word.
  const reachable: boolean[] = new Array(n + 1).fill(false)
  reachable[0] = true
  for (let i = 0; i < n; i++) {
    if (!reachable[i]) continue
    for (let j = i + 1; j <= n; j++) if (get(i, j).admissible) reachable[j] = true
  }
  let firstBad = n
  for (let k = 1; k <= n; k++) { if (!reachable[k]) { firstBad = k - 1; break } }
  return { ok: false, violation: `'${words[Math.max(0, firstBad)]}' traces to no admitted fact` }
}

/** B2. Segment provenance: `{ok:true}` or `{ok:false, violations}`. Pure. */
export function ihWriterProvenance(line: string, units: readonly AdmittedUnit[], truthCtx: PhraseTruthCtx): { ok: true } | { ok: false; violations: string[] } {
  const violations: string[] = []
  for (const run of splitIntoRuns(line)) {
    const res = judgeRun(run, units, truthCtx)
    if (!res.ok) violations.push(res.violation)
  }
  return violations.length ? { ok: false, violations } : { ok: true }
}

// ─── B6: READABILITY ───────────────────────────────────────────────────────────────────────────

const LEAN_FEM_RE = new RegExp(`\\b(?:${LEAN_FEM_CORE})\\b`, 'i')
const LEAN_MASC_RE = new RegExp(`\\b(?:${LEAN_MASC_CORE})\\b`, 'i')
/** A clause "has glue" when it contains at least one glue word OR is a single word (a one-word
 *  clause reads as a fragment/fact, not a list item needing a connective). */
function clauseReadsConnected(clause: string): boolean {
  const words = clause.match(WORD_RE) ?? []
  if (words.length <= 1) return true
  return words.some((w) => GLUE_WORDS.has(ihFoldWord(w)))
}

export function writerReadabilityVerdict(line: string, units: readonly AdmittedUnit[]): { ok: true } | { ok: false; reason: string } {
  // B6.1 — not a keyword list: 3+ comma clauses with NO clause containing a glue word.
  const clauses = line.split(',').map((s) => s.trim()).filter(Boolean)
  if (clauses.length >= 3 && !clauses.some(clauseReadsConnected)) {
    return { ok: false, reason: 'reads as a keyword list (3+ comma clauses, no connecting word in any of them)' }
  }
  // B6.2 — no gender-audience word beside "Unisex" (reuse the LEAN cores, no new list).
  if (/\bunisex\b/i.test(line) && (LEAN_FEM_RE.test(line) || LEAN_MASC_RE.test(line))) {
    return { ok: false, reason: 'states a gender audience beside "Unisex"' }
  }
  // B6.3 — names or evokes the design whenever an identity unit exists.
  const identityUnits = units.filter((u) => u.kind === 'identity')
  if (identityUnits.length > 0) {
    const lineFold = new Set([...foldedMultiset(line).keys()])
    const namesDesign = identityUnits.some((u) => {
      const uWords = [...foldedMultiset(u.text).keys()]
      return uWords.length > 0 && uWords.every((w) => lineFold.has(w))
    })
    if (!namesDesign) return { ok: false, reason: 'does not name or evoke the design' }
  }
  return { ok: true }
}

// ─── B4 point 2/3, B7: THE ONE JUDGE (provenance -> tail -> readability), idempotent ──────────

export interface JudgeWriterLineCtx {
  truthCtx: PhraseTruthCtx
  /** The SAME post-compose tail the composer's own line runs through (`runIhTail` in
   *  listingPipeline.ts) — injected so this module never imports that file (see the header). */
  runTail: (line: string) => { value: string; hold: string | null }
}

export type JudgeWriterLineResult = { ok: true; value: string } | { ok: false; violations: string[] }

/** THE ONE sync judge (B4 point 2): provenance, then the SAME deterministic tail the composer's own
 *  line runs (repeat budget, moved content rules, line truth net, floor door), then readability.
 *  Idempotent (B4 point 3): re-judging an already-accepted composer line through this same function
 *  passes, because that line already satisfies every one of these gates by construction. */
export function judgeWriterLine(draft: string, units: readonly AdmittedUnit[], ctx: JudgeWriterLineCtx): JudgeWriterLineResult {
  const line = (draft || '').trim()
  if (!line) return { ok: false, violations: ['empty line'] }
  const prov = ihWriterProvenance(line, units, ctx.truthCtx)
  if (!prov.ok) return { ok: false, violations: prov.violations.map((v) => `provenance: ${v}`) }
  const tail = ctx.runTail(line)
  if (!tail.value) return { ok: false, violations: [`tail: refused (${tail.hold ?? 'refused'})`] }
  const read = writerReadabilityVerdict(tail.value, units)
  if (!read.ok) return { ok: false, violations: [`readability: ${read.reason}`] }
  return { ok: true, value: tail.value }
}

// ─── B5/B10: THE CLIENT + PROMPT ───────────────────────────────────────────────────────────────

/** Loose JSON extraction — local, tiny copy of this repo's own `parseJsonLoose` idiom
 *  (listingPipeline.ts), not imported: importing FROM listingPipeline.ts would cycle back into it
 *  (see this file's header). Strips a fenced code block if the model wrapped its JSON in one. */
function parseJsonLoose<T>(raw: string): T {
  const trimmed = (raw || '').trim()
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const body = fenced ? fenced[1] : trimmed
  try { return JSON.parse(body) as T } catch { return {} as T }
}

function unitsByKind(units: readonly AdmittedUnit[]): Record<AdmittedUnitKind, string[]> {
  const out: Record<AdmittedUnitKind, string[]> = { identity: [], 'spec-fact': [], brand: [], 'wear-fact': [], pool: [] }
  for (const u of units) out[u.kind].push(u.text)
  return out
}

/** B5: the prompt — the admitted units grouped by kind, the design name EXACTLY as stored (a
 *  misspelled seller name — "Billionare", "Definiton" — is reproduced verbatim; provenance would
 *  reject a corrected spelling as an invention), and the writer's own hard constraints. The literal
 *  word "json" appears (bullet/backend council convention, `bullet-pad-pool-exhaustion` memory) so
 *  `response_format: json_object` never 400s. */
function buildWriterPrompt(units: readonly AdmittedUnit[], designName: string | null, priorViolations: readonly string[]): { system: string; user: string } {
  const grouped = unitsByKind(units)
  const system = [
    'You write ONE Amazon Item Highlight line for a t-shirt/apparel listing.',
    'You may ONLY rephrase and reorder the ADMITTED FACTS given to you below. You may NEVER add a new fact, a new claim, or a new word that is not already present in the admitted facts (function words like "and", "with", "for" excepted).',
    'Return JSON: {"line": "..."} — a single JSON object, one field, "line" is the only key.',
    'The line must be Title Case, 105-120 characters, one line (no line breaks), human-readable comma-separated phrases (not a bare keyword dump).',
    'Never state a specific gender audience (Women/Men/Ladies/Guys/etc.) in the same line as the word "Unisex".',
    'If you cannot honestly build a good line from only the admitted facts, still return your best attempt — do not apologize or explain, only the JSON.',
  ].join(' ')
  const user = [
    `DESIGN NAME (reproduce spelling EXACTLY, including any typo): ${JSON.stringify(designName ?? '')}`,
    `ADMITTED FACTS (json), grouped by kind — every word of your line must trace to one of these:`,
    JSON.stringify(grouped),
    priorViolations.length
      ? `Your previous attempt was REJECTED for: ${priorViolations.join('; ')}. Fix these specific problems — remove or replace the offending words, do not repeat them.`
      : '',
  ].filter(Boolean).join('\n')
  return { system, user }
}

/** B5/B10: one writer call. `maxRetries: 0` (this repo's LOAD-BEARING gateway policy), per-call
 *  EMPTY + finish_reason + model logging (the #176 lesson). Never reads an env file directly and
 *  never logs the API key — the client comes from `getLlmClientForRequest` (llmGateway.ts), which
 *  resolves it exactly as every other production caller does. */
async function askWriter(openai: OpenAI, model: string, units: readonly AdmittedUnit[], designName: string | null, priorViolations: readonly string[]): Promise<string> {
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
    const parsed = parseJsonLoose<{ line?: unknown }>(content || '{}')
    return typeof parsed.line === 'string' ? parsed.line.trim() : ''
  } catch (e) {
    console.warn(`[ih-writer] ${model} call FAILED: ${e instanceof Error ? e.message : String(e)}`)
    return ''
  }
}

// ─── B7/B8: BOUNDED, FAIL-CLOSED RUN FOR ONE DESIGN ────────────────────────────────────────────

/** B7: 1 + 2 retries. */
export const IH_WRITER_MAX_CALLS = 3

export interface WriterRunResult {
  accepted: boolean
  value: string
  reasons: string[]
  calls: number
}

export interface WriterDeps {
  openai?: OpenAI | null
}

/** B7/B8: runs the bounded writer loop for ONE design and returns whether an accepted line resulted.
 *  Eligibility (B8): no call for `unrated-pool` or zero admitted pool units — those never make it
 *  past the guards below. Fail-closed (B7): after `IH_WRITER_MAX_CALLS` attempts, `accepted: false` —
 *  the caller falls back to the composer's OWN vetted result, never an empty string over stored
 *  content. */
export async function runWriterForDesign(args: {
  composed: Pick<ComposerResult, 'candidates' | 'specFacts' | 'brandPick' | 'wearFact'>
  fallbackHold: string | null
  designName: string | null
  identityPhrases?: readonly string[]
  truthCtx: PhraseTruthCtx
  runTail: (line: string) => { value: string; hold: string | null }
  deps?: WriterDeps
  model?: string
}): Promise<WriterRunResult> {
  // B8 eligibility.
  if (args.fallbackHold === 'unrated-pool') return { accepted: false, value: '', reasons: ['skip: unrated-pool'], calls: 0 }
  const pool = args.composed.candidates ?? []
  if (pool.length === 0) return { accepted: false, value: '', reasons: ['skip: zero admitted pool units'], calls: 0 }

  const units = buildAdmittedUnits(args.composed, { designName: args.designName, identityPhrases: args.identityPhrases, truthCtx: args.truthCtx })
  const openai = args.deps?.openai ?? (await getLlmClientForRequest().catch(() => null))
  if (!openai) return { accepted: false, value: '', reasons: ['skip: no LLM client available'], calls: 0 }

  const model = args.model ?? ihWriterModel()
  const reasonsAll: string[] = []
  let priorViolations: string[] = []
  for (let call = 1; call <= IH_WRITER_MAX_CALLS; call++) {
    const draft = await askWriter(openai, model, units, args.designName, priorViolations)
    if (!draft) { reasonsAll.push('empty-draft'); priorViolations = ['you returned an empty line']; continue }
    const verdict = judgeWriterLine(draft, units, { truthCtx: args.truthCtx, runTail: args.runTail })
    if (verdict.ok) return { accepted: true, value: verdict.value, reasons: reasonsAll, calls: call }
    reasonsAll.push(...verdict.violations)
    priorViolations = verdict.violations
  }
  return { accepted: false, value: '', reasons: reasonsAll, calls: IH_WRITER_MAX_CALLS }
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
