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
  significantWordsWithSurface, ihRepeatBudget, IH_MAX_WORD_REPEATS,
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
 *  pin in that route.
 *  RULING W5 (fix round B7b, wire minor): `Number.parseInt` parses a PREFIX, exactly the P11 defect
 *  already fixed on `ihWriterDeadlineMs` below — `'2.9'` silently became `2` and `/api/health` echoed
 *  a value nobody set. Require the trimmed value to be CLEANLY all-digits first, same as the
 *  deadline; anything else falls back to the default exactly as an absent env var does. */
export function ihWriterMaxCallsBudget(raw: string | undefined = process.env.IH_WRITER_MAX_CALLS): number {
  const trimmed = (raw ?? '').trim()
  if (!/^[0-9]+$/.test(trimmed)) return 18
  const n = Number.parseInt(trimmed, 10)
  return n > 0 ? n : 18
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
/** RULING P11 (fix round B5, minor 1, wire m1): `Number.parseInt` parses a PREFIX, so `'1e3'`
 *  silently becomes `1` and `'45000ms'` silently becomes `45000` — neither is what the value looks
 *  like it says. Require the trimmed value to be CLEANLY all-digits before parsing; anything else
 *  (empty, non-numeric, a unit suffix, scientific notation) falls back to the default exactly as an
 *  absent env var does — `/api/health`'s echo of the EFFECTIVE value still makes a typo visible. */
export function ihWriterDeadlineMs(raw: string | undefined = process.env.IH_WRITER_DEADLINE_MS): number {
  const trimmed = (raw ?? '').trim()
  if (!/^[0-9]+$/.test(trimmed)) return 45_000
  const n = Number.parseInt(trimmed, 10)
  return n > 0 ? n : 45_000
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

/** RULING R1 (fix round B7a, compliance Blocking `q6brand`, Important `q8two`): classifies the
 *  relationship between the design's identity text and the composer's mandatory brand pick, using
 *  the SAME owner predicates the rest of this module reads (`lineCarriesBrand`, imported from
 *  `itemHighlightComposer.ts`; `lineHasSignificantRepeat`, imported from `productDetailAttrs.ts`) —
 *  never a new rule. Both mandatory units are exempt from every OTHER admission filter (see
 *  `buildAdmittedUnits`'s final `units.filter`); this function decides the ONE thing that is not a
 *  filter — whether a SECOND, dedicated brand unit is even offered alongside the identity, or
 *  whether the family cannot produce a compliant writer line at all:
 *  - `'none'`: no brand is mandatory here (no `brandPick`), or there is no identity — the two units
 *    do not interact; a dedicated brand unit (if any) is offered normally.
 *  - `'identity-carries'`: the identity text ITSELF carries the brand — it is the ONE mandatory
 *    carrier, so the dedicated brand unit must be WITHHELD (never pushed) to keep exactly one
 *    carrier offered. Offering both used to make every arrangement unsatisfiable (Q8's "more than
 *    one unit carries the brand" check fires on identity+brandUnit together, burning the whole retry
 *    budget for nothing — `q8two.mts`'s "ComfortColors Club" shape).
 *  - `'collision'`: the two mandatory units collide some OTHER way (they share a significant word —
 *    `lineHasSignificantRepeat` — without the identity actually carrying the brand text) — no
 *    arrangement could ever legally carry BOTH mandatory units, so the design must skip the writer
 *    entirely before any call is spent (`runWriterForDesign`'s own eligibility check, B8-shaped: 0
 *    calls, the composer ships). */
export type MandatoryBrandStatus = 'none' | 'identity-carries' | 'collision'
export function mandatoryBrandStatus(identityText: string | null, brandPick: string | null, allowedBrand: string | null): MandatoryBrandStatus {
  if (!identityText || !brandPick) return 'none'
  if (allowedBrand && lineCarriesBrand(identityText, allowedBrand)) return 'identity-carries'
  if (lineHasSignificantRepeat(`${identityText}, ${brandPick}`)) return 'collision'
  return 'none'
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
    // RULING P2 (fix round B5, truth Important T4/N17): `number` never applies to the BRAND unit
    // either, regardless of its grammar `kind` — a pool-sourced brand phrase that happens to end in
    // a garment-head word ("Comfort Colors Tee") is not sizeable ("Comfort Colors Tees" reads as a
    // multi-pack, not a plural of the brand).
    units.push({ id: `u${n++}`, text, kind, numberable: kind !== 'identity' && !extra?.isBrand && isNumberable(text), ...extra })
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
  // RULING R1 (fix round B7a, compliance Blocking, `q6brand`/`q8two`): tracked so the dedicated
  // brand unit below can be WITHHELD (never pushed at all) when the identity itself already carries
  // the brand — see the `push(composed.brandPick, ...)` block below. Set only when the identity was
  // actually admitted (inside the loop, after its own truth/trademark/celebrity gate passed).
  let identityCarriesBrand = false
  for (const text of identityTexts) {
    const key = text.toLowerCase()
    if (seenIdentity.has(key)) continue
    seenIdentity.add(key)
    // RULING P1 (fix round B5, compliance Blocking, `attack8` §A8): the design's own IDENTITY text
    // can ALSO carry the brand ("ComfortColors Club") — the second-carrier drop is not only a
    // pool-unit concern. Same predicate, same "at most one carrier" rule.
    const reason = !phraseTruthVerdict(text, opts.truthCtx).ok ? 'untrue'
      : scrubTrademarks(text) !== text ? 'trademark'
        : hasCelebrityName(text) ? 'celebrity'
          : null
    if (reason) {
      console.warn(JSON.stringify({ tag: 'IH_WRITER_IDENTITY_DROPPED', phrase: text, reason }))
      continue
    }
    // RULING Q9 (fix round B6, wire Blocking W8): the identity unit is EFFECTIVELY MANDATORY
    // (`writerReadabilityVerdict`'s "names or evokes the design" rule reads it, when one exists) —
    // dropping it outright because it ALSO happens to carry the brand (a data condition: blank
    // brands come from `loadBlankSpecRows`, and a short/substring-prone one is not hypothetical)
    // left the writer with NO subject to name at all. Never drop it for that reason any more; at
    // most DEMOTE it — log the collision, still admit it. `judgeWriterArrangement`'s own "more than
    // one unit carries the brand" check (below) still refuses any arrangement that uses it ALONGSIDE
    // the dedicated brand unit, so brand-once still holds; the identity is simply never unreachable.
    if (composed.brandPick && opts.truthCtx.allowedBrand && lineCarriesBrand(text, opts.truthCtx.allowedBrand)) {
      identityCarriesBrand = true
      if (text !== composed.brandPick) {
        console.warn(JSON.stringify({ tag: 'IH_WRITER_IDENTITY_BRAND_COLLISION', phrase: text, brandPick: composed.brandPick }))
      }
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
  // RULING R1 (fix round B7a, compliance Blocking `q6brand`, Important `q8two`): when the IDENTITY
  // itself already carries the brand, it satisfies the requirement on its own (it is the ONE
  // mandatory carrier) — the dedicated brand unit is WITHHELD (never pushed at all) so exactly ONE
  // carrier is ever offered. Offering BOTH used to make every arrangement unsatisfiable (Q8's
  // "more than one unit carries the brand" check fires on identity+brandUnit together, burning the
  // whole retry budget — `q8two.mts`'s "ComfortColors Club" shape). The judge's own brand-required
  // check (`judgeWriterArrangement`'s K2, below) is keyed on the composer's `needBrand` explicitly,
  // never on `units.find(isBrand)`, so withholding this unit here never silently drops the
  // requirement — it is verified on the FINAL rendered bytes regardless of which unit carried it.
  if (composed.brandPick) {
    if (identityCarriesBrand) {
      console.warn(JSON.stringify({ tag: 'IH_WRITER_BRAND_CARRIER_WITHHELD', phrase: composed.brandPick, reason: 'identity-carries-brand' }))
    } else {
      push(composed.brandPick, composed.brandOrigin === 'pool' ? 'pool' : 'brand', { isBrand: true })
    }
  }
  if (composed.wearFact) push(composed.wearFact, 'wear-fact')
  // RULING P1 (fix round B5, compliance Blocking): admit AT MOST ONE brand-carrying unit across
  // every kind. When a brand unit exists (`composed.brandPick`), every OTHER unit whose text the
  // composer's OWN `lineCarriesBrand` predicate recognizes as carrying the brand is dropped here —
  // never only the exact-text twin (K2's narrower fix) — because `lineCarriesBrand` also catches a
  // flattened/hyphenated spelling ("Comfortcolors Shirt") that is a DIFFERENT string from
  // `brandPick` but still a second carrier. Logged so a dropped duplicate is never silent.
  const allowedBrandForDrop = opts.truthCtx.allowedBrand
  // RULING Q8 (fix round B6, compliance Important): `judgeWriterArrangement`'s brand-once check
  // fires whenever `allowedBrand` is set — INCLUDING a `needBrand=false` family (the title already
  // carries the brand, so `composed.brandPick` is null) — but until now this admission-time drop
  // only ran when `composed.brandPick` existed, so a needBrand=false family with two independent
  // carriers (e.g. its own identity AND a pool phrase) admitted both and burned its whole retry
  // budget on a collision the prompt never even taught (B5 compliance Important 2). Extend the
  // "at most one carrier" drop to that case too: the identity unit is never dropped for this (Q9),
  // so if it already carries the brand it is the ONE kept carrier and every pool candidate carrying
  // the brand is dropped; otherwise the FIRST pool candidate found is kept and every later one is
  // dropped — never zero, never two.
  const identityCarrierText = allowedBrandForDrop ? (units.find((u) => u.kind === 'identity' && lineCarriesBrand(u.text, allowedBrandForDrop))?.text ?? null) : null
  let keptUnbrandedCarrier: string | null = composed.brandPick ? null : identityCarrierText
  for (const text of composed.candidates ?? []) {
    if (composed.brandPick && allowedBrandForDrop && lineCarriesBrand(text, allowedBrandForDrop) && text !== composed.brandPick) {
      console.warn(JSON.stringify({ tag: 'IH_WRITER_BRAND_CARRIER_DROPPED', phrase: text, brandPick: composed.brandPick }))
      continue
    }
    if (!composed.brandPick && allowedBrandForDrop && lineCarriesBrand(text, allowedBrandForDrop)) {
      if (keptUnbrandedCarrier) {
        console.warn(JSON.stringify({ tag: 'IH_WRITER_BRAND_CARRIER_DROPPED', phrase: text, brandPick: keptUnbrandedCarrier, reason: 'second-carrier-unbranded' }))
        continue
      }
      keptUnbrandedCarrier = text
    }
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
  // RULING S1 (fix round B8a, value Blocking B1, spec §2h rule 1): a garment-head unit is offered
  // ONLY when an identity unit was actually ADMITTED above — §2g rule 4's abutment position ("<design
  // name> <head>") is the garment-head unit's ONE legal place in the whole grammar (R5), so with no
  // surviving identity (`designName` null, OR the identity was dropped for a trademark, a celebrity,
  // or an untrue claim — the SAME three doors the identity loop above already gates on), every head
  // unit offered here would be an OFFERED-BUT-UNUSABLE unit: no arrangement could ever legally place
  // it (`r10b` census, mutation-proved), so offering it only teaches the model a phrase it can never
  // use, or burns a call discovering that the hard way. Logged with the SAME tag every other
  // admission-time drop uses (`IH_WRITER_UNIT_DROPPED`), reason `no-identity-anchor`.
  const identityAdmittedForHeads = units.some((u) => u.kind === 'identity')
  const { allowed } = garmentNounConstraint(opts.truthCtx)
  const seenHead = new Set<string>()
  for (const word of allowed) {
    if (/\s/.test(word)) continue // single-word forms only
    const folded = ihFoldWord(word)
    if (!IH_GARMENT_HEAD_FOLDED.has(folded) || seenHead.has(folded)) continue
    seenHead.add(folded)
    if (!identityAdmittedForHeads) {
      console.warn(JSON.stringify({ tag: 'IH_WRITER_UNIT_DROPPED', phrase: titleCasePhrase(word), kind: 'garment-head', reason: 'no-identity-anchor' }))
      continue
    }
    push(titleCasePhrase(word), 'garment-head')
  }
  // RULING P6(c) (fix round B5, value Important): drop and log ANY unit whose own text fails an
  // OWNER predicate — never a second copy of either rule. `lineHasSignificantRepeat` catches a unit
  // that self-repeats a significant word (a DEAD unit: no arrangement using it can ever pass the
  // judge's own repeat gate, so offering it only costs a call — the class B3's dead wear-fact named).
  // After P6(b)'s fix, a true "N% Fabric / N% Fabric" material fact no longer self-repeats (the
  // fold now excludes pure-numeric tokens) and is correctly NOT dropped here. `phraseTruthVerdict`
  // is skipped for `identity`/`garment-head` kinds — identity already passed its OWN admission gate
  // above (with its own log tag), and a bare single-word garment noun is trivially true by
  // construction (`garmentNounConstraint`'s own allowed-noun table).
  // RULING Q6 (fix round B6, value Blocking B3): the design's identity is EFFECTIVELY MANDATORY
  // (`writerReadabilityVerdict`'s "names or evokes the design" rule), so ANY other unit sharing a
  // significant word with it fails the owner's OWN repeat predicate in every arrangement that also
  // carries identity — offering it only teaches the model a phrase it can never legally use, and
  // costs a call finding that out the hard way. Extend the SAME owner predicate to the PAIR (never a
  // second rule): a unit is dropped here when `identityText + ', ' + unitText` already trips
  // `lineHasSignificantRepeat`, the identical test the tail runs on the FINAL rendered line.
  const identityUnitForCollision = units.find((u) => u.kind === 'identity')
  const identityTextForCollision = identityUnitForCollision?.text ?? null
  return units.filter((u) => {
    // RULING R1 (fix round B7a, compliance Blocking): MANDATORY units (the identity and the isBrand
    // unit) are exempt from EVERY admission filter below — never self-repeat, never identity-
    // collision, never untrue. The B6 escape was exactly this: the identity-collision filter (below)
    // dropped the isBrand unit whenever a design name shared a word with the brand, and the judge's
    // brand-required check (keyed, at the time, on `units.find(isBrand)`) then silently required
    // nothing. `identityCarriesBrand` already withholds the dedicated unit ABOVE when it is not
    // needed (R1's other half) — this exemption is the backstop for every other admission filter.
    if (u.kind === 'identity' || u.isBrand) return true
    if (lineHasSignificantRepeat(u.text)) {
      console.warn(JSON.stringify({ tag: 'IH_WRITER_UNIT_DROPPED', phrase: u.text, kind: u.kind, reason: 'self-repeat' }))
      return false
    }
    // RULING R2 (fix round B7a, value Blocking B2): generalises Q6's admission-time "identity
    // collision" filter from self-repeat ALONE to EVERY line-level PAIR check the judge itself
    // applies — repeat, and the gender/Unisex readability checks, persona-excluded (see
    // `identityPairViolation` below — the SAME function `writerReadabilityVerdict`'s gender half
    // reads, never a copy). The identity unit is effectively mandatory
    // (`writerReadabilityVerdict`'s "names or evokes the design" rule), so ANY unit that fails one of
    // these checks paired with JUST the identity fails it in EVERY arrangement that also carries the
    // identity — offering it only teaches the model a phrase (or costs a call discovering) it can
    // never legally use.
    if (identityTextForCollision) {
      const violation = identityPairViolation(identityTextForCollision, u.text)
      if (violation) {
        console.warn(JSON.stringify({ tag: 'IH_WRITER_UNIT_DROPPED', phrase: u.text, kind: u.kind, reason: violation === 'self-repeat' ? 'identity-collision' : `identity-collision-${violation}` }))
        return false
      }
    }
    if (u.kind !== 'garment-head' && !phraseTruthVerdict(u.text, opts.truthCtx).ok) {
      console.warn(JSON.stringify({ tag: 'IH_WRITER_UNIT_DROPPED', phrase: u.text, kind: u.kind, reason: 'untrue' }))
      return false
    }
    return true
  })
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

/** §2c's unit classes, NARROWED by RULING R6 (fix round B7a, value Important): `SPEC` used to union
 *  three kinds a relation join may introduce (a blank spec fact, the brand phrase, the sanctioned
 *  wear fact); `'wear-fact'` is REMOVED — the wear fact is a CLAUSE ("Can be worn as Oversized"),
 *  not an attribute noun, so "with Can be worn as Oversized" is ungrammatical English and was 100%
 *  of the remaining literal-model rejections (§2f rule 5, B6-review measured). Removing it from
 *  `SPEC_KINDS` makes it list-join-only EXACTLY like the brand unit, through the SAME two checks
 *  this set already feeds (the single relation-glue check and the Q1 open-clause scope check below)
 *  — no new branch, one flag. `GARMENT` is `garment-head` alone (rule 1's "garment noun"); every
 *  other kind (`identity`, `pool`) is neither. */
const SPEC_KINDS: ReadonlySet<AdmittedUnitKind> = new Set(['spec-fact', 'brand'])

/** NEVER glue (ruling B2, verbatim, unchanged by W1/§2c): negations, quantifiers, purity words,
 *  gendered pronouns. Not consumed at runtime (they simply are never added to `GLUE_WORDS` above) —
 *  kept as data so a test can assert `GLUE_WORDS` never grows to include one of these AND that none
 *  of them (nor any glue word) matches an exported truth regex (the build-time collision guard, kept
 *  from B2 per ruling W1: "Keep the glue-vs-lexicon disjointness test."). */
export const NEVER_GLUE_WORDS: readonly string[] = ['not', 'no', 'without', 'non', 'all', 'only', 'just', 'pure', 'entirely', 'nothing', 'her', 'his', 'him', 'she', 'he']

const WORD_RE = /[A-Za-z0-9]+(?:['’][A-Za-z]+)*/g

// ─── RULING Q2 (fix round B6, truth Important): the singular/plural TOGGLE is GONE ────────────────
//
// P2 (fix round B5) removed `number` from the BRAND unit alone ("a plural brand reads as a
// multi-pack, not the brand name"). Review B5 (TR-2) measured the IDENTICAL defect on every OTHER
// numberable unit — the design's own garment head ("Retro Sunset Tees") and any pool phrase ending
// in a garment noun ("Farm Life Sweatshirts", "Retro Sunset Tops") all shipped a manufactured
// quantity/multi-pack claim. P2's own premise was never brand-specific, so the cure is not a second,
// wider exemption table — it is deleting the mechanism `arrangement.number` gave a model to toggle
// ANY unit's inflection at all. `AdmittedUnit.numberable` stays computed (RULING G3's literal
// `GARMENT_HEAD_WORDS` membership check — read only by tests/callers that still describe a unit's
// own garment-noun shape); nothing in `validateArrangement`/`renderArrangement`/the prompt reads it
// any more. A `"number"` key on an arrangement part is now simply an unrecognized key (RULING G9's
// existing "unknown key" violation covers it — no new branch needed).

// ─── W1: THE ARRANGEMENT — validate, then render VERBATIM ─────────────────────────────────────────

export interface ArrangementUnitPart { unit: string }
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
 * FIX ROUND B3 (RULING G1, spec §2c rules 1-4; NARROWED by fix round B5 rulings P2/P3) — the CLOSED
 * ARRANGEMENT GRAMMAR, walked over an already unit/glue-validated `parts` sequence. Two units may
 * sit next to each other in exactly two shapes:
 *   ABUTMENT (no glue between them) — rule 1, RULING P3: legal ONLY when the RIGHT-hand unit is
 *     `garment-head` AND the LEFT-hand unit is the IDENTITY unit ("<design name> Sweatshirt").
 *     `<pool phrase><garment head>` (K3's original "identity OR pool") is REMOVED — review B4
 *     measured it manufacturing a style/cut/feature/size claim no unit carries ("Cream of the Crop"
 *     + "Top" = a crop top; "Money in My Pocket" + "Tee"). Any other abutment (a pool/spec/brand
 *     unit on either side) is a NAMED violation.
 *   ONE OR TWO glue tokens between them:
 *     - a single LIST join (`,` `and` `&` `—` `|`) — rule 2: legal between ANY two units.
 *     - a single RELATION join (`with`/`in`) — rule 3: legal ONLY when the RIGHT-hand unit is
 *       SPEC-class (`spec-fact`/`brand`/`wear-fact`) AND is not the mandatory BRAND unit (RULING
 *       P2: the brand unit is list-join-only regardless of grammar kind — its own text is
 *       "<Brand> <garment noun>", so a relation would read as a second garment). This is what
 *       kills X5 ("with Deep Pockets", a pool unit), X7 ("in Pink Lemonade", an identity unit), and
 *       would kill X8/X9/X10/X11's "for"/"from" relations even before this rule runs, because
 *       `for`/`from` are no longer in the closed glue set at all (rule 4 — see the `GLUE_WORDS_RAW`
 *       block comment).
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
  // RULING P2 (fix round B5, truth Important T4/T2): the brand unit is never article-eligible,
  // regardless of grammar `kind` — "with a Comfort Colors Tee" reads as a second garment, not a
  // spec fact taking an article. See the RELATION branch below for the matching rule.
  if (u.isBrand) return false
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
    if (role === 'relation' && right.isBrand) {
      // RULING P2 (fix round B5, truth Important T4, compliance/value B2): regardless of grammar
      // `kind` (a pool-sourced brand is `kind: 'pool'`; a spec-sourced brand is `kind: 'brand'`,
      // which WOULD otherwise satisfy `SPEC_KINDS` below), the brand unit is list-join-only. Its
      // own text is "<Brand> <garment noun>", so "with"/"in" reads as a SECOND garment, not an
      // attribute of this one ("Retro Sunset Shirt with Comfort Colors Tee").
      return `relation '${run[0].glue}' cannot introduce the brand unit '${right.text}' — the brand unit is list-join only ("," "and" "&" "—" "|"), never after "with"/"in"`
    }
    // RULING R6 (fix round B7a, value Important): the wear fact is a CLAUSE ("Can be worn as
    // Oversized"), not an attribute noun a relation can introduce — "with Can be worn as Oversized"
    // is ungrammatical English, exactly like the brand shape above. Named explicitly (never left to
    // fall through to the generic "must introduce a spec fact" message below) so the retry names the
    // SAME rule the prompt teaches.
    if (role === 'relation' && right.kind === 'wear-fact') {
      return `relation '${run[0].glue}' cannot introduce the wear-fact unit '${right.text}' — the wear fact is list-join only ("," "and" "&" "—" "|"), never after "with"/"in"`
    }
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
    // RULING P2 (fix round B5): the brand unit is list-join-only — never an abutment endpoint,
    // whichever side it sits on ("Shirt with Comfort Colors Tee" already blocked above; this closes
    // the abutment shape too, defence in depth — a brand unit is never `garment-head`-kinded so the
    // RIGHT side can't trigger this, but a future brand-carrying pool unit sitting on the LEFT must
    // not silently abut a garment-head either).
    if (left.isBrand) {
      return `'${left.text}' and '${right.text}' abut with no join; the brand unit is list-join only`
    }
    // RULING P3 (fix round B5, truth Important T1, superseding K3's "identity OR pool" — review B4
    // measured `<pool unit><garment head>` manufacturing a style/cut/feature/size claim no unit
    // carries: "Cream of the Crop" + "Top" = a CROP TOP; "Test Tube" + "Top"; "Money in My Pocket" +
    // "Tee" (X5's pocket, laundered through the abutment route instead of a relation); "Gym Muscle"
    // + "Tee"; "Stand Tall" + "Tee" (sizing)). The lexicon-free, structural cure: abutment is legal
    // ONLY after the IDENTITY unit (K3 already rules an identity's own claims TITLE-BOUNDED) — a
    // POOL unit must now take a list or relation join before a garment-head noun, exactly like any
    // other pairing.
    if (left.kind !== 'identity') {
      return `'${left.text}' and '${right.text}' abut with no join; a garment noun may only follow the identity unit directly — after a pool unit, use a list join (e.g. ',' or 'and')`
    }
  }
  // RULING Q1 (fix round B6, truth Blocking TR-1): A RELATION OWNS ITS CLAUSE, not merely the unit
  // immediately to its right. The two passes above only ever check the unit sitting DIRECTLY after
  // a "with"/"in" token — a LIST join placed after that legal spec unit put an arbitrary POOL unit
  // (or the brand) back inside the SAME relation's reading with no check at all ("Retro Sunset Shirt
  // with a Classic Fit and Deep Pockets" — the pockets are attached by "with", not by "and", but
  // nothing walked that far). Once a relation join ("with"/"in") opens, EVERY unit up to the next
  // "," must be SPEC-class and never the brand unit — a list join or an article inside the open
  // clause does not close it; only a comma does (the SAME clause boundary the tail's own span-truth
  // check already uses, `judgeWriterArrangement` below). Walked separately from the pair-wise passes
  // above so E02's direct-violation message (the FIRST unit after "with"/"in") is unchanged — this
  // pass only ever fires for a unit that pass already let through.
  let relationOpenGlue: string | null = null
  for (const part of parts) {
    if ('unit' in part) {
      if (relationOpenGlue) {
        const u = byId.get(part.unit)!
        if (u.isBrand) {
          return `relation '${relationOpenGlue}' is still open (no ',' yet) and cannot carry the brand unit '${u.text}' — the brand unit is list-join only`
        }
        if (!SPEC_KINDS.has(u.kind)) {
          return `relation '${relationOpenGlue}' is still open (no ',' yet); '${u.text}' is a ${unitClassName(u.kind)} unit and cannot appear inside that clause`
        }
      }
      continue
    }
    if (part.glue === ',') { relationOpenGlue = null; continue }
    if (RELATION_GLUE.has(part.glue)) { relationOpenGlue = part.glue; continue }
    // A list join, an article, or any other closed-glue token neither opens nor closes the clause.
  }
  // RULING R5 (fix round B7a, truth Important I-2): a garment-head unit's ONLY legal position, in
  // the arrangement as a WHOLE, is directly after the identity unit (rule 1's abutment) — its sole
  // stated purpose is naming the garment once. The abutment pass above only rejects a bare NO-GLUE
  // pair whose LEFT side is not the identity; it never inspects a garment-head unit reached through
  // a LIST JOIN instead of a bare abutment ("Retro Sunset Tee and Top", "Farm Life Sweatshirt and
  // Crewneck" — the SAME "second garment / multi-pack" claim T02b/T14/T18b/T24b/R29 measured,
  // reached one join further out than the abutment pass looks). Walked over the WHOLE `parts` array
  // (not clause-scoped) so a garment-head unit is illegal both across a comma and inside/outside a
  // relation clause — there is no position for a SECOND garment-head unit anywhere in a legal line.
  for (let k = 0; k < parts.length; k++) {
    const p = parts[k]
    if (glueRole(p) !== 'unit') continue
    const u = unitAt(p)
    if (u.kind !== 'garment-head') continue
    const prev = k > 0 ? parts[k - 1] : null
    const directlyAfterIdentity = !!prev && glueRole(prev) === 'unit' && unitAt(prev).kind === 'identity'
    if (!directlyAfterIdentity) {
      return `'${u.text}' is a garment-head unit and may appear ONLY directly after the identity unit with no glue (e.g. '<design name> ${u.text}') — anywhere else, even joined by "," or "and", it names a second garment or a multi-pack`
    }
  }
  // RULING S2 (fix round B8a, value Important, spec §2h rule 2): the wear fact stands ALONE in its
  // own "," comma clause. The relation-clause pass above (Q1) already refuses it as the SUBJECT of
  // "with"/"in"; this closes the OTHER half — a wear-fact unit joined to a NEIGHBOUR by a LIST glue
  // ("and" "&" "—" "|") reads as one fit/cut claim on that neighbour ("Can be worn as Oversized and a
  // Classic Fit"), exactly the shape §2h names. Walked over the WHOLE `parts` array, the same scope
  // R5's garment-head-position pass uses: the ONLY legal neighbours on either side of a wear-fact
  // unit are a "," (or the start/end of the line) — never another glue token, and never a bare
  // abutment (which the earlier abutment pass already refuses for every kind but garment-head).
  for (let k = 0; k < parts.length; k++) {
    const p = parts[k]
    if (glueRole(p) !== 'unit') continue
    const u = unitAt(p)
    if (u.kind !== 'wear-fact') continue
    const prev = k > 0 ? parts[k - 1] : null
    const next = k < parts.length - 1 ? parts[k + 1] : null
    const prevOk = !prev || (glueRole(prev) !== 'unit' && (prev as ArrangementGluePart).glue === ',')
    const nextOk = !next || (glueRole(next) !== 'unit' && (next as ArrangementGluePart).glue === ',')
    if (!prevOk || !nextOk) {
      return `'${u.text}' is a wear-fact unit and must stand ALONE in its own "," comma clause — joined to a neighbour by "and"/"&"/"—"/"|" (or abutting one directly), it asserts a fit/cut claim this blank does not back; put it between two commas, or at the very start/end of the line`
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
  // RULING R1 (fix round B7a, compliance Blocking): when explicitly passed, keys rule (g)'s
  // required-brand check on THIS — never merely on `units.find(u => u.isBrand)` (the B6 `q6brand`
  // escape: an admission filter silently removed the isBrand unit, and a `units.find`-only check
  // then required nothing). `undefined` (every pre-R1 test caller) preserves the OLD behavior — "a
  // brand unit exists in `units`" — for source compatibility.
  needBrand?: boolean,
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
      // RULING Q2 (fix round B6): "number" is no longer a recognized key at all — it falls straight
      // into this same unknown-key violation now, never a separate branch.
      const extra = Object.keys(p).filter((k) => k !== 'unit')
      if (extra.length) return { ok: false, violation: `unit part carries unknown key(s): ${extra.join(', ')}` }
      const unit = byId.get(p.unit)
      if (!unit) return { ok: false, violation: `unit id '${p.unit}' does not exist` }
      if (seen.has(p.unit)) return { ok: false, violation: `unit '${p.unit}' used more than once` }
      seen.add(p.unit)
      out.push({ unit: p.unit })
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
  // though the composer's own line would have carried the brand waterfall (X17). RULING R1 (fix
  // round B7a): gated on `needBrand ?? !!brandUnit` — when `needBrand` is explicitly false (a
  // needBrand=false family whose title already carries the brand) this rule never fires even if a
  // stray isBrand unit somehow exists; when `needBrand` is explicitly true but NO isBrand unit
  // exists at all (the identity itself carries the brand — R1's withhold), there is no specific unit
  // id to require here, and the requirement is instead re-verified on the FINAL rendered bytes by
  // `judgeWriterArrangement`'s own K2 check, keyed on the SAME `needBrand`.
  const brandUnit = units.find((u) => u.isBrand)
  const brandRequired = needBrand ?? !!brandUnit
  if (brandRequired && brandUnit && !seen.has(brandUnit.id)) {
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
    // RULING Q2 (fix round B6): NO permitted mutation any more — every unit renders its OWN stored
    // text, verbatim, always. The singular/plural toggle is gone (see the block comment above).
    return u.text
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
      // RULING P11 (fix round B5, minor 1, truth m1): article by SOUND, not just letter — a "uni-"
      // prefix reads as a consonant "yoo" sound ("a Unisex Fit", never "an Unisex Fit"), the mirror
      // image of K6's original fix for "an Classic Fit". A general PREFIX PATTERN, not a lexicon
      // entry for one word: "uni-" is a closed English phonetic class (unicorn, uniform, unique,
      // united, universal), so this generalizes to any future unit starting with it, never a
      // case written for one probe string.
      const startsWithConsonantSound = /^uni/i.test((nextText ?? '').trim())
      token = !startsWithConsonantSound && /^[aeiou]/i.test((nextText ?? '').trim()) ? 'an' : 'a'
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

/** RULING P5 (fix round B5, value Blocking 1): "at least one relation clause" — count of clauses
 *  (split by `READABILITY_CLAUSE_SPLIT_RE`) that carry a "with"/"in" relation word. */
function countRelationClauses(clauses: readonly string[]): number {
  return clauses.filter((c) => !clauseIsKeywordShaped(c)).length
}
/** RULING Q11 (fix round B6, readability shape refined): "at most one list section" — a list
 *  SECTION is a RUN OF TWO OR MORE consecutive clauses that carry no relation word. A single
 *  clause with no relation word, sitting between two relation clauses, is ordinary prose (P4's own
 *  wear-fact pin, B08, needs exactly this shape: "…with a Relaxed Fit, Can be worn as Oversized,
 *  Vintage Beach Vibes in Garment-Dyed Fabric, Comfort Colors Tee" — two LONE non-relation clauses,
 *  neither one a run of 2+, so it reads as prose, not "2 separate keyword lists" as fix round B5
 *  measured it) — only a run of two or more counts as a section (a trailing run of any length still
 *  counts once). Two such runs, separated by a relation clause, still count as two sections. */
function countListSections(clauses: readonly string[]): number {
  let sections = 0
  let runLen = 0
  const closeRun = () => { if (runLen >= 2) sections++; runLen = 0 }
  for (const c of clauses) {
    if (clauseIsKeywordShaped(c)) runLen++
    else closeRun()
  }
  closeRun()
  return sections
}

/** RULING R4 (fix round B7a, value Blocking B3): counts relation/list clauses from the
 *  ARRANGEMENT's own GLUE PARTS, never by re-scanning the rendered TEXT for the words "with"/"in"
 *  (`clauseIsKeywordShaped` above). A pool phrase whose OWN text happens to contain "in" or "with"
 *  ("Christmas in July Shirt", "Mom with Attitude") used to count as a relation clause with ZERO
 *  actual relation JOINS, letting a pure keyword list pass readability and ship. Clause boundaries
 *  are the SAME characters `READABILITY_CLAUSE_SPLIT_RE` splits on (`GLUE_PUNCTUATION`, defined
 *  earlier in this file) — matched against the glue PARTS, never the rendered string. Returns one
 *  boolean per clause: `true` when that clause is keyword-shaped (carries no relation-glue part). */
function clauseShapesFromParts(parts: readonly ArrangementPart[]): boolean[] {
  const shapes: boolean[] = []
  let sawUnit = false
  let sawRelationGlue = false
  const closeClause = () => { if (sawUnit) shapes.push(!sawRelationGlue); sawUnit = false; sawRelationGlue = false }
  for (const part of parts) {
    if ('unit' in part) { sawUnit = true; continue }
    // RULING R4: `READABILITY_CLAUSE_SPLIT_RE` splits on EVERY member of `GLUE_PUNCTUATION`
    // (`,` `—` `|` `&`), not only the comma — the glue-based walk must match that exactly.
    if (GLUE_PUNCTUATION.has(part.glue)) { closeClause(); continue }
    if (RELATION_GLUE.has(part.glue)) sawRelationGlue = true
    // A list-word join (`and`) or an article (`a`/`an`) neither opens nor closes a clause boundary.
  }
  closeClause()
  return shapes
}
/** RULING R4: the glue-based mirror of `countListSections` above, over the boolean clause-shape
 *  array `clauseShapesFromParts` returns — same run-of-2+ rule, same behavior, different input. */
function countListSectionsFromShapes(shapes: readonly boolean[]): number {
  let sections = 0
  let runLen = 0
  const closeRun = () => { if (runLen >= 2) sections++; runLen = 0 }
  for (const isKeywordShaped of shapes) {
    if (isKeywordShaped) runLen++
    else closeRun()
  }
  closeRun()
  return sections
}

/** RULING S9 (fix round B8a, truth minor m6): escapes every regex-special character in `s` so it
 *  can be embedded literally inside a `RegExp` — a design name can contain any of them ("Ladies?!",
 *  "Cat (Person)"). */
function escapeRegExpLiteral(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
/** RULING R2 (fix round B7a, value Blocking B2): "The design name is a PERSONA, not an audience
 *  claim." Removes the identity unit(s)' OWN rendered text from `text` before a gender/Unisex check
 *  reads it, so a design named "Ladies Man" or "Crazy Cat Lady" is judged on what OTHER units say,
 *  never on its own name. Units render verbatim (Q2) and each is used at most once, so the identity's
 *  exact stored text is always a contiguous substring of the rendered line when it is present.
 *  RULING S9 (fix round B8a, truth Minor m6, superseding R2's own docstring claim): the ORIGINAL
 *  `text.split(t).join(' ')` removed `t` as a RAW substring, not on word boundaries — so an
 *  identity ONE WORD long that happens to be a PREFIX of a gender-core word ("Lad") cut that word out
 *  of an entirely DIFFERENT unit's text ("Ladies Night Out" -> " ies Night Out", stripping the "Lad"
 *  that also starts "Ladies" and silently removing the gender signal readability exists to catch —
 *  the review's own A33/A34 control pair). `\b…\b` requires a WORD BOUNDARY on both sides of the
 *  matched span, so "Lad" no longer matches inside "Ladies" (there is no boundary between the 'd' of
 *  "Lad" and the 'i' of "Ladies" — both are word characters) while the exact phrase "Crazy Cat Lady"
 *  still matches only its own contiguous occurrence, unchanged from before. This is exact, not an
 *  approximation, in the sense the old docstring claimed but the old implementation did not deliver. */
function stripIdentityWords(text: string, identityTexts: readonly string[]): string {
  let out = text
  for (const t of identityTexts) {
    if (!t) continue
    out = out.replace(new RegExp(`\\b${escapeRegExpLiteral(t)}\\b`, 'g'), ' ')
  }
  return out
}
/** RULING R2: the SAME gender/Unisex violation `writerReadabilityVerdict`'s B6.2 half returns,
 *  factored out so `identityPairViolation` below can reuse it — one function, never a copy. Callers
 *  pass an ALREADY persona-excluded `text` (via `stripIdentityWords`). */
function genderAudienceViolation(text: string): 'unisex-gender' | 'gender-mix' | null {
  const hasFem = LEAN_FEM_RE.test(text)
  const hasMasc = LEAN_MASC_RE.test(text)
  if (/\bunisex\b/i.test(text) && (hasFem || hasMasc)) return 'unisex-gender'
  if (hasFem && hasMasc) return 'gender-mix'
  return null
}
/** RULING R2 (fix round B7a): generalises Q6's admission-time "identity collision" filter from
 *  self-repeat ALONE to EVERY line-level PAIR check the judge itself applies at pair scope — repeat,
 *  and the gender/Unisex readability checks, persona-excluded. The identity unit is effectively
 *  mandatory (`writerReadabilityVerdict`'s "names or evokes the design" rule), so ANY unit that
 *  fails one of these checks paired with JUST the identity fails it in EVERY arrangement that also
 *  carries the identity — reused by `buildAdmittedUnits`'s final filter, never a copy. Returns the
 *  SPECIFIC violation (never a bare boolean) so the caller can log a specific reason (R2's own
 *  requirement), and `null` when the pair is clean — which also means the unit is now REACHABLE
 *  beside a persona identity that itself carries a gender-core word ("Unisex Fit" beside "Crazy Cat
 *  Lady": stripping "Crazy Cat Lady" leaves no gendered word at all, so the pair is clean). */
function identityPairViolation(identityText: string, unitText: string): 'self-repeat' | 'gender-mix' | 'unisex-gender' | null {
  const pair = `${identityText}, ${unitText}`
  if (lineHasSignificantRepeat(pair)) return 'self-repeat'
  return genderAudienceViolation(stripIdentityWords(pair, [identityText]))
}

export function writerReadabilityVerdict(line: string, units: readonly AdmittedUnit[], parts?: readonly ArrangementPart[]): { ok: true } | { ok: false; reason: string } {
  // RULING P5 (fix round B5, value Blocking 1, superseding K7/W7's "at most one keyword-shaped
  // clause"): ONE readability shape, taught from the SAME constants this check reads
  // (`READABILITY_CLAUSE_SPLIT_RE`, `RELATION_WORDS_FOLDED`) — a line needs AT LEAST ONE relation
  // clause ("with"/"in"), and AT MOST ONE list section (a run of clauses joined only by list glue).
  // K7's rule rejected a legitimate trailing list ("…with X and a Y, A, B and C") the instant it
  // spanned 2+ clauses after the required relation clause — the exact regression the B4 value lens
  // measured on 2 of its own 10 reference lines (Dino Squad, Spreadsheet Queen). This rule still
  // refuses a bare keyword dump: zero relation clauses is exactly the PO's original complaint.
  // RULING R4 (fix round B7a, value Blocking B3): when the caller supplies the ARRANGEMENT's own
  // `parts` (every production caller does, via `judgeWriterArrangement`), clause shape is read from
  // the GLUE, never by re-scanning the rendered text for "with"/"in" — a pool phrase whose own text
  // happens to contain those letters ("Christmas in July Shirt") no longer counts as a relation
  // clause with zero actual relation joins. `parts` is OPTIONAL only for source compatibility with
  // callers that hand-type a rendered line with no arrangement at all (every such existing caller
  // types a line whose relation words really do come from a "with"/"in" GLUE choice, so the two
  // mechanisms agree on every one of them).
  const clauseCount = parts ? clauseShapesFromParts(parts).length : line.split(READABILITY_CLAUSE_SPLIT_RE).map((s) => s.trim()).filter(Boolean).length
  const relationClauses = parts
    ? clauseShapesFromParts(parts).filter((keywordShaped) => !keywordShaped).length
    : countRelationClauses(line.split(READABILITY_CLAUSE_SPLIT_RE).map((s) => s.trim()).filter(Boolean))
  // RULING S5 (fix round B8a, value Important): named from RELATION_GLUE, and explicit that a
  // "with"/"in" appearing INSIDE a unit's own text (never an arrangement GLUE part) does not count —
  // the exact wording the registry sentence now teaches (`writerReadabilityFidelitySentence` below),
  // so a model that follows the retry message and the taught rule are never taught two different
  // things ("Christmas in July Shirt" carries the letters "in" but ZERO relation GLUE, and this
  // message used to say only "0 of N clauses contain a … relation", which reads as a claim about the
  // rendered WORDS, contradicting the very clause the model just wrote).
  if (relationClauses < 1) {
    return { ok: false, reason: `reads as a keyword list (0 of ${clauseCount} clauses contain a "with"/"in" JOIN — a "with"/"in" appearing inside a unit's own text does not count; at least one relation clause is required)` }
  }
  const listSections = parts
    ? countListSectionsFromShapes(clauseShapesFromParts(parts))
    : countListSections(line.split(READABILITY_CLAUSE_SPLIT_RE).map((s) => s.trim()).filter(Boolean))
  if (listSections > 1) {
    return { ok: false, reason: `reads as ${listSections} separate keyword lists (clauses with no "with"/"in" relation, split apart by another relation clause) — at most one list section is allowed` }
  }
  // B6.2 — no gender-audience word beside "Unisex" (reuse the LEAN cores, no new list).
  // RULING P11 (minor 4), TAUGHT UNCONDITIONALLY as of RULING Q4 (fix round B6, value Blocking B1):
  // a feminine AND a masculine audience word together ("Mens … for Women") reads exactly as badly,
  // reusing the identical LEAN_FEM_RE/LEAN_MASC_RE cores, no new lexicon. This half of the check has
  // NO dependency on a "Unisex" unit being offered — it fires on every family — so it is taught by
  // its own unconditional registry id (`gender-mix`), never bundled into `unisex-gender` (which IS
  // gated on a Unisex unit, per RULING K4/P7): bundling them meant the fem+masc sentence vanished on
  // precisely the gendered-lean families where a Unisex unit is never offered at all, and the check
  // fired UNTAUGHT on exactly the families it governs (B5 review, finding B1).
  // RULING R2 (fix round B7a, value Blocking B2): "The design name is a PERSONA, not an audience
  // claim." The identity unit's OWN words are excluded from this pair of checks (both here on the
  // full line, and in `identityPairViolation`'s admission-time pair check) — a design named "Ladies
  // Man" or "Crazy Cat Lady" is judged on what OTHER units say, never on its own name.
  // RULING S9 (fix round B8a, value minor m1): CALLS `genderAudienceViolation` — the SAME function
  // `identityPairViolation`'s admission-time pair check calls — instead of re-implementing the two
  // LEAN_FEM_RE/LEAN_MASC_RE tests inline. The two copies were equivalent at HEAD (both read from the
  // same regex cores), but "one function, not a copy" is R2's own stated discipline, and a re-
  // implementation is exactly the shape that drifts silently the NEXT time either check changes.
  const identityUnitsForGender = units.filter((u) => u.kind === 'identity')
  const genderProbeLine = identityUnitsForGender.length ? stripIdentityWords(line, identityUnitsForGender.map((u) => u.text)) : line
  const genderViolation = genderAudienceViolation(genderProbeLine)
  if (genderViolation === 'unisex-gender') {
    return { ok: false, reason: 'states a gender audience beside "Unisex"' }
  }
  if (genderViolation === 'gender-mix') {
    return { ok: false, reason: 'states both a feminine and a masculine audience word in the same line' }
  }
  // B6.3 — names or evokes the design whenever an identity unit exists.
  if (identityUnitsForGender.length > 0) {
    const lineFold = foldedContentWords(line)
    const namesDesign = identityUnitsForGender.some((u) => {
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
  /** RULING R1 (fix round B7a, compliance Blocking): the composer's OWN `needBrand`, passed in
   *  EXPLICITLY — the brand-required check below (K2) is keyed on THIS, never on
   *  `units.find(u => u.isBrand)` (which silently passed once an admission filter removed the
   *  isBrand unit — the B6 `q6brand` escape). Omitted (every pre-R1 test caller): falls back to "a
   *  brand unit exists in `units`", source-compatible with every existing pin. Production callers
   *  (`runWriterForDesign`) always pass it, so a FUTURE admission bug that drops the isBrand unit can
   *  never again silently disable the requirement — it is re-verified on the FINAL rendered bytes
   *  regardless of which unit (if any) carried it. */
  needBrand?: boolean
}

export type JudgeWriterLineResult = { ok: true; value: string } | { ok: false; violations: string[] }

/** RULING P7 (fix round B5, value Important I1): maps the tail's own REASON CODE (e.g.
 *  `productDetailAttrs.ts`'s `'sentence-shape'`) to a plain-language sentence the model was
 *  actually TAUGHT (via `WRITER_RULE_REGISTRY`'s `sentence-shape` id) — a bare reason code names
 *  nothing the prompt ever showed the model. Any reason code with no entry here falls through to
 *  its own bare code (unchanged behaviour) — this is additive precision, never a new refusal. */
const TAIL_REASON_MESSAGES: Readonly<Record<string, string>> = {
  'sentence-shape': "needs at least one ',' between phrases",
}

// RULING Q5 (fix round B6, value Blocking B2): the SAME "plain-language, in the TAIL_REASON_MESSAGES
// pattern" idea, kept as its OWN map because it answers a DIFFERENT question — every
// `PhraseTruthReason` span truth (`contentTruth.ts`) can name in the `join:` violation below, never
// the tail's own coarser refusal (which stays keyed on `TAIL_REASON_MESSAGES` above, unchanged, so
// existing pins asserting the tail's raw reason code are unaffected by this addition).
const SPAN_REASON_MESSAGES: Readonly<Record<string, string>> = {
  'fit-claim-lie': 'this pairing asserts a fit/cut claim this blank does not back',
  'material-lie': 'this pairing asserts a fabric/material claim this blank does not back',
  'weight-class-lie': 'this pairing asserts a fabric weight this blank does not back',
  'competitor-brand': "this pairing names a brand that is not this product's own",
  'audience-lean-lie': "this pairing states a single gender this family's audience lean does not back",
  'wrong-garment-noun': 'this pairing names a garment this family is not',
  'garment-vocab-on-non-apparel': 'this pairing uses garment language on a non-apparel family',
  'capability-claim': 'this pairing asserts a capability (e.g. sun protection, moisture-wicking) no blank fact backs',
}

/** THE ONE sync judge (B4 point 2): validate the arrangement, render it VERBATIM, then the SAME
 *  deterministic tail the composer's own line runs (repeat budget, moved content rules, line truth
 *  net, floor door), then readability. Idempotent (B4 point 3): re-judging an arrangement that
 *  renders to an already-accepted composer line passes, because that line already satisfies every
 *  one of these gates by construction — nothing here re-parses the RENDERED text, so idempotence
 *  needs no special case. */
export function judgeWriterArrangement(raw: unknown, units: readonly AdmittedUnit[], ctx: JudgeWriterLineCtx): JudgeWriterLineResult {
  const v = validateArrangement(raw, units, ctx.needBrand)
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
  // RULING P4 (fix round B5, truth Important x2, superseding K5's ADJACENT-PAIR scope): judge every
  // CONTIGUOUS SUB-SPAN of units (all i<j, not only adjacent j=i+1) WITHIN one comma clause, and
  // NEVER across a comma. K5's adjacent-pair-only scope was itself non-monotone in the OTHER
  // direction: inserting one more unit BETWEEN the "%" marker and the fibre (a garment head, or a
  // second comma) let the pairwise check skip straight over the lie ("100% Awesome Sweatshirt &
  // Soft Poly Feel with 52% Cotton / 48% Polyester" — T2/N09/N10). Judging every sub-span inside the
  // clause (not only neighbours) catches it regardless of what sits between the two lying units.
  // Crossing a comma is wrong in the OPPOSITE direction: the tail already owns clause-scope and
  // line-scope truth, and a comma-crossing pair check made the PO-sanctioned "Can be worn as
  // Oversized" unusable in ANY position (B08 — the fact's own comma clause, judged in isolation, is
  // true; only a cross-clause pairing with its NEIGHBOUR read as a fit-claim-lie). `n` is at most
  // ~12 admitted units, so this is at most ~66 extra `phraseTruthVerdict` calls per clause — still
  // the SAME predicate every pool candidate already passes, no lexicon.
  const clauses: number[][] = []
  {
    let current: number[] = []
    v.parts.forEach((p, idx) => {
      if ('unit' in p) { current.push(idx); return }
      if (p.glue === ',') { if (current.length) clauses.push(current); current = [] }
      // Every other glue token (list/relation/article/punctuation) stays WITHIN the same clause.
    })
    if (current.length) clauses.push(current)
  }
  for (const clause of clauses) {
    for (let a = 0; a < clause.length - 1; a++) {
      for (let b = a + 1; b < clause.length; b++) {
        const span = renderArrangement(v.parts.slice(clause[a], clause[b] + 1), units).trim()
        const spanVerdict = phraseTruthVerdict(span, ctx.truthCtx)
        if (!spanVerdict.ok) {
          // RULING Q5 (fix round B6, value Blocking B2): plain-language — never the raw internal
          // reason code, which named nothing the model was taught.
          const label = SPAN_REASON_MESSAGES[spanVerdict.reason] ?? spanVerdict.reason
          return { ok: false, violations: [`join: '${span}' — ${label}`] }
        }
      }
    }
  }
  // RULING P1 (fix round B5, compliance Blocking, defense in depth): more than one unit carrying
  // the brand in the FINAL arrangement is a named violation — never only an admission-time drop.
  // `buildAdmittedUnits` already admits at most one carrier by construction; this catches the
  // residual case of a future admission gap.
  if (ctx.truthCtx.allowedBrand) {
    const usedUnitIds = new Set<string>()
    v.parts.forEach((p) => { if ('unit' in p) usedUnitIds.add(p.unit) })
    const carriers = units.filter((u) => usedUnitIds.has(u.id) && lineCarriesBrand(u.text, ctx.truthCtx.allowedBrand!))
    if (carriers.length > 1) {
      return { ok: false, violations: [`brand: more than one unit carries the brand (${carriers.map((u) => u.text).join(', ')}) — the composer's brand-once rule allows exactly one`] }
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
    const rep = findFirstSignificantRepeat(line)
    const surfaceLabel = rep ? rep.surfaces.join(' / ') : '?'
    const budgetLabel = rep && rep.budget === IH_MAX_WORD_REPEATS ? 'garment words: at most 2' : `this word: at most ${rep?.budget ?? 1}`
    return { ok: false, violations: [`'${surfaceLabel}' appears ${rep?.count ?? '?'} times (${budgetLabel})`] }
  }
  const tail = ctx.runTail(line)
  if (!tail.value) {
    // Band/repeat are already clear above — a tail refusal here is always the tail's OWN
    // content/truth/floor gate (RULING W4: surface the REAL reason, e.g. "material-lie", never the
    // coarser hold bucket). RULING P7 (fix round B5, value Important): a `sentence-shape` reason
    // code names nothing the model was TAUGHT — map it to the plain-language rule it actually is.
    const rawReason = tail.reason ?? tail.hold ?? 'refused'
    const reasonLabel = TAIL_REASON_MESSAGES[rawReason] ?? rawReason
    return { ok: false, violations: [`tail: refused (${reasonLabel})`] }
  }
  // RULING K1 (compliance B1; value I2): the tail must return the rendered bytes UNCHANGED. Any
  // edit — a dropped phrase (a repeat/length amputation the checks above did not anticipate) or an
  // inserted one (`ensureBlankBrandInHighlights`'s own brand prefix) — is a named rejection, never a
  // silent edit the model never chose (spec §2d rule 1: "It passes through the tail byte-identical").
  if (tail.value !== line) {
    return { ok: false, violations: [`the tail changed the line: ${tail.reason ?? 'edited by the post-compose net'}`] }
  }
  // RULING R4 (fix round B7a): pass the arrangement's own `parts` so relation/list clauses are
  // counted from GLUE, never by re-scanning `tail.value` for the words "with"/"in".
  const read = writerReadabilityVerdict(tail.value, units, v.parts)
  if (!read.ok) return { ok: false, violations: [`readability: ${read.reason}`] }
  // RULING K1 (compliance B1): the accepted line must ALSO be pushable by the push seam's OWN
  // classifier (`classifyStoredIhLine`, imported — never a copy) — "accepted" and "pushable" are the
  // SAME question from here on, never two.
  const pushClass = classifyStoredIhLine(tail.value)
  if (pushClass !== 'ok') {
    return { ok: false, violations: [`push-seam: ${pushClass}`] }
  }
  // RULING K2 (compliance B2, defense in depth), keyed per RULING R1 (fix round B7a) on the
  // composer's OWN `needBrand` — NEVER on `units.find(u => u.isBrand)` — when this family's brand
  // is mandatory, the FINAL bytes must carry it through the composer's OWN carries-brand test
  // (imported, never a copy). This is the backstop for BOTH shapes R1 introduces: the identity
  // itself carries the brand (no dedicated isBrand unit exists at all — `units.find` would find
  // nothing to require, yet the requirement still holds and is verified HERE), and the residual case
  // where a unit was present but the rendered/tailed bytes somehow do not carry the brand text (a
  // future tail edit, or admission gap) — `ctx.needBrand` undefined (every pre-R1 test caller) falls
  // back to "a brand unit exists in `units`", source-compatible with every existing pin.
  const brandUnitFallback = units.find((u) => u.isBrand)
  const brandRequired = ctx.needBrand ?? !!brandUnitFallback
  if (brandRequired && ctx.truthCtx.allowedBrand && !lineCarriesBrand(tail.value, ctx.truthCtx.allowedBrand)) {
    return { ok: false, violations: ['brand: rendered line does not carry the required brand'] }
  }
  return { ok: true, value: tail.value }
}

/** RULING K1/P7 (fix round B5, value Important I2): which significant word first exceeds its
 *  repeat budget in `line` — used only to build the retry message; the GATE itself is
 *  `lineHasSignificantRepeat` above (imported from productDetailAttrs.ts, never re-implemented
 *  here). RETURNS the SURFACE spellings actually written (deduped, in first-seen order — "Women"
 *  and "Woman" fold to the same word but are different bytes the model wrote), the ACTUAL count
 *  (never hardcoded "twice" — a folded word used three times said "twice" before this fix, which
 *  contradicted itself), and the word's own budget, so the message never lies about what the model
 *  did or why. */
function findFirstSignificantRepeat(line: string): { surfaces: string[]; count: number; budget: number } | null {
  const counts = new Map<string, number>()
  const surfacesByFold = new Map<string, string[]>()
  for (const { folded, surface } of significantWordsWithSurface(line)) {
    const c = (counts.get(folded) ?? 0) + 1
    counts.set(folded, c)
    const list = surfacesByFold.get(folded) ?? []
    if (!list.includes(surface)) list.push(surface)
    surfacesByFold.set(folded, list)
    const budget = ihRepeatBudget(folded)
    if (c > budget) return { surfaces: list, count: c, budget }
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
/** RULING R3 (fix round B7a, value Blocking): the inputs a `WriterRuleSpec.when` predicate may
 *  read — the SAME inputs the check it teaches reads (`units`, and the brand/allowedBrand context
 *  `buildWriterPrompt` already threads through), never a hand-maintained condition list that can
 *  drift narrower than the check (Q4's own ruled class: the B1 escape was exactly a `when`-shaped
 *  condition, hand-typed as `CONDITIONAL_RULE_IDS` + a bespoke filter clause, that read a NARROWER
 *  test — `kind === 'spec-fact'` — than the check it was supposed to teach, which fires on ANY
 *  offered unit's text). */
export interface WriterRuleWhenCtx { units: readonly AdmittedUnit[]; brandUnit: AdmittedUnit | null; allowedBrand: string | null }
export interface WriterRuleSpec {
  id: string
  sentence: string
  /** A predicate over `WriterRuleWhenCtx` — `undefined` means "always rendered" (most rules).
   *  `buildWriterPrompt` renders this entry's sentence IF AND ONLY IF `when` is absent or returns
   *  true. Declaring the condition HERE, beside the sentence it gates, is the whole fix: there is no
   *  second place for the two to drift apart. */
  when?: (ctx: WriterRuleWhenCtx) => boolean
}
export const WRITER_RULE_REGISTRY: readonly WriterRuleSpec[] = [
  { id: 'shape', sentence: 'You arrange ONE Amazon Item Highlight line for a t-shirt/apparel listing out of ADMITTED UNITS — you do NOT write free text.' },
  // RULING Q2 (fix round B6, truth Important TR-2): the "number" field is GONE — a unit renders its
  // OWN stored text, singular or plural, exactly as given; there is no toggle any more.
  { id: 'json-shape', sentence: 'Return JSON: {"parts": [...]} — an ORDERED list where each element is EITHER {"unit": "<id>"} OR {"glue": "<token>"}.' },
  { id: 'unit-verbatim', sentence: 'Every "unit" id must be one of the ids given to you below. Each unit may be used AT MOST ONCE. Units render VERBATIM — their own exact words, order, numbers and punctuation, singular or plural exactly as given. You cannot change a unit\'s text in any way.' },
  { id: 'closed-glue', sentence: `A "glue" token must be exactly one of these words: ${GLUE_WORDS_RAW.join(', ')} — or one of these punctuation marks: , — | &` },
  { id: 'no-invention', sentence: 'Do not invent a unit id, a glue token, or any text — every word in the final line comes from a unit you chose.' },
  {
    // RULING P3/P2 (fix round B5): narrowed from "identity OR pool" to IDENTITY ONLY on the
    // abutment's left side (a pool unit abutting a garment head manufactured an unattested style/
    // cut/size claim — "Cream of the Crop Top"); and the brand unit is EXCLUDED from relation joins
    // regardless of grammar kind (its own text is "<Brand> <garment noun>", so "with"/"in" would
    // read as a second garment). RULING Q1 (fix round B6, truth Blocking TR-1): rule 3 restated at
    // the CLAUSE level — "with"/"in" open a relation that stays open until the next ",", not merely
    // for the one unit directly after the join, so a LIST join inside that still-open clause cannot
    // smuggle a pool unit (or the brand) back in ("with a Classic Fit and Deep Pockets" invents the
    // SAME feature X5 already named, one join further out).
    id: 'grammar',
    // RULING R5 (fix round B7a, truth Important I-2): a garment-head unit's ONLY legal position, in
    // the WHOLE arrangement, is directly after the identity — the OLD wording's own parenthetical
    // ("join it with ',' or 'and' instead") was actively WRONG advice under this ruling, since a
    // garment-head unit reached that way ("Tee and Top") names a second garment exactly like a bare
    // abutment does; corrected below. RULING R6 (fix round B7a, value Important): the wear fact is
    // now list-join-only too, so rule (3)'s "spec-fact or wear-fact unit" narrows to "spec-fact unit"
    // — the dedicated `wear-fact-list-only` rule (below) teaches the wear fact's OWN restriction, the
    // same way the brand rule teaches the brand's.
    sentence: 'THE GRAMMAR (the only legal ways two units may sit next to each other): (1) two units may touch with NO glue between them ONLY when the RIGHT-hand one is a garment-head unit AND the LEFT-hand one is the IDENTITY unit (e.g. "<design name> Sweatshirt") — a garment-head unit may appear ONLY in that ONE position, directly after the identity, and NEVER anywhere else: never abutting a pool/spec/brand unit, and never reached by a list or relation join either ("Tee and Top", "Sweatshirt, Crewneck" are both illegal — a garment-head unit names the garment ONCE, right after the identity, or not at all). (2) "," "and" "&" "—" "|" are LIST joins and may join ANY two units EXCEPT a garment-head unit (rule 1 covers its one legal position; it is never list-joined) — list joins assert nothing between the items, exactly like a plain list. (3) "with" and "in" open a RELATION CLAUSE that stays open until the next "," — EVERY unit inside it (the one right after the join, and any later unit reached by a list join before the next ",") must be a spec-fact unit, and NEVER a pool, identity, wear-fact, or BRAND unit (a relation clause may only ever attach TRUE facts of this product; "with Deep Pockets" or "in Pink Lemonade" invent a feature/colour, and "with a Classic Fit and Deep Pockets" invents the SAME thing one join further out — start a NEW comma clause instead of adding a list join inside an open relation; "with Comfort Colors Tee" reads as a second garment and "with Can be worn as Oversized" is ungrammatical English — both the brand and the wear fact are LIST-JOIN ONLY, see their own rules below). (4) No other glue word exists — do not use "for", "of", "to", "your", "on", "from", "that", "this" or "the"; they are not in the closed set above. No glue or punctuation may open or close the line, and no two glue tokens may sit next to each other except exactly one join immediately followed by "a"/"an".',
  },
  { id: 'article', sentence: '"a"/"an" may appear ONLY directly after a list or relation join, AND directly before a spec-fact unit whose own last word is "Fit" or "Neck" (e.g. "with a Classic Fit", "and a Crew Neck") — never before a pool/identity unit, never before the brand unit, never before a different kind of spec/wear-fact unit, and NEVER standing alone with no join immediately before it. Write "a"/"an" as you see fit; the correct spelling for the following word is chosen for you automatically.' },
  { id: 'band', sentence: `The rendered line must be ${CONTENT_CONTRACT.itemHighlights.min}-${CONTENT_CONTRACT.itemHighlights.max} characters.` },
  { id: 'repeat', sentence: 'Repeat rule: each significant word may appear at most once, EXCEPT a garment head noun (shirt/tee/sweatshirt/hoodie/etc.), which may appear up to twice. Plural and gender forms count as the SAME word for this rule (e.g. "Women"/"Woman" are one word; "Shirt"/"Shirts" are one word).' },
  // RULING P2 (fix round B5, truth Important T4, compliance/value B2), Q2 (fix round B6, number
  // gone), Q1 (fix round B6, clause-level): the mechanism is taught HERE (list-join-only; never
  // inside a still-open relation clause either); WHICH unit id is required is named separately in
  // the user message below (`buildWriterPrompt`), keyed on `isBrand` — never on grammar `kind`,
  // since a pool-origin brand unit's `kind` is `'pool'` and used to render as an EMPTY "brand" group.
  {
    id: 'brand',
    sentence: 'When a REQUIRED BRAND UNIT is named below (by id), your arrangement MUST use that exact unit id somewhere, or it will be rejected. The brand unit is LIST-JOIN ONLY — join it with "," "and" "&" "—" or "|" — never after "with"/"in", never anywhere inside a relation clause that is still open (before the next ","), and never after an article. At most ONE unit in your whole arrangement may carry the brand text — using two different units that both name the brand is rejected even if neither is the required brand unit.',
    // RULING R3 (fix round B7a): declared HERE — `judgeWriterArrangement`'s "more than one unit
    // carries the brand" check fires whenever `allowedBrand` is set at ALL (RULING Q8), including a
    // `needBrand=false` family with no dedicated brand unit at all (its title already carries the
    // brand). `buildWriterPrompt` computes `brandUnit`/`allowedBrand` from the SAME `ctx` shape.
    when: (ctx) => !!ctx.brandUnit || !!ctx.allowedBrand,
  },
  // RULING R6 (fix round B7a, value Important): the wear fact is a CLAUSE ("Can be worn as
  // Oversized"), not an attribute noun — "with Can be worn as Oversized" is ungrammatical English,
  // and it was 100% of the remaining literal-model rejections (§2f rule 5). Taught the SAME shape as
  // the brand rule (list-join only), gated on whether a wear-fact unit is even offered — pointless
  // prompt weight otherwise (the same reasoning as `unisex-gender`'s own gate, below).
  // RULING S2 (fix round B8a, value Important, spec §2h rule 2): superseded from "list-join only" to
  // "stands ALONE in its own comma clause" — R6's own sentence still invited "and"/"&"/"—"/"|" onto
  // the wear fact, and every one of those joins was refused 100% of the time (the wear fact asserts a
  // fit/cut claim only on ITSELF, never paired with a neighbour any other way).
  { id: 'wear-fact-list-only', sentence: 'A wear-fact unit (e.g. "Can be worn as Oversized") must stand ALONE in its own "," comma clause — never after "with"/"in" (like the brand unit, it is never the subject of a relation), and never joined to a NEIGHBOUR by "and" "&" "—" or "|" either: put a "," immediately before it and a "," immediately after it (or the very start/end of the line), with no other unit in between.', when: (ctx) => ctx.units.some((u) => u.kind === 'wear-fact') },
  { id: 'sentence-shape', sentence: 'The arrangement must contain AT LEAST ONE "," (comma) glue token somewhere between two units — "—", "|" and "&" alone do NOT satisfy this, and an arrangement with zero commas will be rejected even if it otherwise reads well.' },
  // RULING Q4 (fix round B6, value Blocking B1): split OUT of `unisex-gender` — this half of the
  // check has no dependency on a Unisex unit and fires on EVERY family, so it is taught
  // unconditionally, by its own id, never bundled with a sentence that is withheld on gendered leans.
  // RULING R2 (fix round B7a, value Blocking B2): the design name is EXCLUDED from this check — a
  // design named "Ladies Man" or "Crazy Cat Lady" is a persona, not an audience claim.
  { id: 'gender-mix', sentence: 'Never state both a feminine audience word (e.g. "Women", "Ladies") and a masculine audience word (e.g. "Men", "Mens") in the same line, OTHER than the design\'s own name (its name is a persona, not an audience claim) — the combination contradicts itself and will be rejected.' },
  // RULING R3 (fix round B7a, value Blocking): `when` reads "does ANY offered unit's text contain
  // 'unisex'" — the SAME condition `writerReadabilityVerdict`'s check reads (it scans the whole
  // rendered LINE for the word, which can only ever have come from an offered unit) — no longer
  // narrowed to a spec-fact unit alone, which let a POOL-sourced "Unisex" phrase teach nothing (the
  // B1 escape this closes).
  { id: 'unisex-gender', sentence: 'Never put a gendered audience word (e.g. "Women", "Men", "Ladies"), OTHER than the design\'s own name, in the same line as a "Unisex" unit — the combination contradicts itself and will be rejected.', when: (ctx) => ctx.units.some((u) => /\bunisex\b/i.test(u.text)) },
  // RULING P5 (fix round B5, value Blocking 1): rendered from the SAME constants the check reads
  // (`READABILITY_CLAUSE_SPLIT_RE`, `RELATION_WORDS_FOLDED`) — see `writerReadabilityFidelitySentence`
  // below, which BUILDS this sentence text so the two can never drift silently.
  { id: 'names-design', sentence: writerReadabilityFidelitySentence() },
  // RULING Q5 (fix round B6, value Blocking B2): unconditional — this check has no gating condition
  // (it runs on every clause, every family), and the retry message it produces (the "join:"
  // violation, mapped through `TAIL_REASON_MESSAGES`) names nothing the prompt taught before this.
  { id: 'pair-truth', sentence: 'Some facts are only true ON THEIR OWN, not paired with a neighbour — even inside one relation clause, or joined by "and"/"&"/"—"/"|". If your arrangement is rejected for a "join:" truth problem, do not try a different neighbour for that unit: either put it alone in its OWN "," comma clause, or drop it.' },
  // RULING P11 (minor 5): advisory only — not itself enforced by any check, so it never produces a
  // named violation; it merely steers the model away from a true-but-redundant pairing.
  { id: 'neck-redundancy', sentence: 'Avoid pairing a "Neck" spec fact (e.g. "Crew Neck") directly beside a garment-head noun that already names the same neck style (e.g. "Crewneck") — it is not rejected, but it reads redundantly ("Crewneck with a Crew Neck").' },
  { id: 'closing', sentence: 'If you cannot honestly build a good line from only the admitted units, still return your best attempt as {"parts": [...]} — do not apologize or explain, only the JSON.' },
]

/** RULING R3 (fix round B7a, value Blocking): the ruled class guard. Sweeps EVERY entry whose
 *  `when` is declared and asserts it is never NARROWER than the check it teaches — a registry-level
 *  fidelity test (`itemHighlightWriterFixRoundB7a.test.ts`) drives real admitted units through the
 *  REAL judge/readability refusals and asserts the matching entry's `when` was true for that unit
 *  set. Superseded `CONDITIONAL_RULE_IDS` (a hand-typed id set plus a bespoke filter clause in
 *  `buildWriterPrompt`) — THAT was the B1 escape's own shape: a condition living apart from the
 *  check it was supposed to mirror, free to drift narrower. */

/** RULING P5 (fix round B5): builds the `names-design` registry sentence FROM the same constants
 *  `writerReadabilityVerdict` reads, so the taught rule and the enforced rule cannot drift apart —
 *  the exact failure class K4's own completeness test could not catch (it only checks the sentence
 *  APPEARS, never that it matches what is enforced). A test asserts this sentence changes if
 *  `READABILITY_CLAUSE_SPLIT_RE`'s glue characters change. */
/** RULING S5 (fix round B8a, value Important): built from `RELATION_GLUE` (the arrangement's own
 *  GLUE role, `with`/`in` as a JOIN), never `RELATION_WORDS_FOLDED` (the word-scan fallback) — the
 *  taught sentence must say the same thing the REAL check (`writerReadabilityVerdict`'s parts-based
 *  branch) actually does: a relation clause needs a "with"/"in" JOIN between two units, and a
 *  "with"/"in" sitting inside one unit's own text ("Christmas in July Shirt") is not a join at all
 *  and does not count. The two constants hold the identical words today (`RELATION_GLUE = {'with',
 *  'in'}`, folded the same way), so this is a wording fix, not a behaviour change — but the WORDING
 *  was actively wrong: it told a literal-following model to look for the relation WORD, and the
 *  judge's own retry message for the "Christmas in July" rejection said the same thing, so the one
 *  unit for which the system already knows the right answer was teaching the model the wrong one. */
function writerReadabilityFidelitySentence(): string {
  const splitChars = READABILITY_CLAUSE_SPLIT_RE.source.replace(/[[\]]/g, '').split('').join(' ')
  const relationWords = [...RELATION_GLUE].join('"/"')
  // RULING Q11 (fix round B6, readability shape refined): a list SECTION is a RUN OF TWO OR MORE
  // consecutive clauses lacking a relation word — a single such clause, sitting between two
  // relation clauses, is ordinary prose, not a list section (`countListSections` above).
  return `READABILITY: split the line at every ${splitChars} into clauses. AT LEAST ONE clause must contain a "${relationWords}" JOIN (a glue token connecting two units) — a "${relationWords}" appearing INSIDE a unit's own text does not count, and a line with ZERO such join clauses reads as a keyword list and is rejected. After that, a RUN OF TWO OR MORE consecutive clauses that all lack a "${relationWords}" join counts as ONE list section (a trailing run of any length still counts once; a SINGLE such clause on its own, between two relation clauses, is ordinary prose and does NOT count) — AT MOST ONE such list section is allowed; a SECOND one, split off by another relation clause, will also be rejected. If the design has an identity unit, the line must also name or evoke it.`
}

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
/** RULING Q8 (fix round B6, compliance Important): `allowedBrand` is now a parameter, not merely
 *  read off a brand UNIT — `judgeWriterArrangement`'s "more than one unit carries the brand" check
 *  fires whenever `truthCtx.allowedBrand` is set, EVEN on a `needBrand=false` family with no brand
 *  unit at all (its title already carries the brand). Every production caller (`askWriter`) passes
 *  it; the every test caller that omits it (pre-Q8) gets the pre-Q8 behaviour (gated on `brandUnit`
 *  alone) — additive, never a required-argument break. */
export function buildWriterPrompt(units: readonly AdmittedUnit[], designName: string | null, priorViolations: readonly string[], allowedBrand: string | null = null): { system: string; user: string } {
  const grouped = unitsByKind(units)
  const brandUnit = units.find((u) => u.isBrand) ?? null
  // RULING R3 (fix round B7a, value Blocking): each registry entry's OWN `when` decides whether its
  // sentence renders — never a second, hand-maintained condition here. `whenCtx` carries exactly the
  // inputs a `when` predicate may read (`WriterRuleWhenCtx`).
  const whenCtx: WriterRuleWhenCtx = { units, brandUnit, allowedBrand }
  const system = WRITER_RULE_REGISTRY
    .filter((r) => !r.when || r.when(whenCtx))
    .map((r) => r.sentence)
    .join(' ')
  // RULING K4 (value I3): each unit's character length and the join costs, so the model can COUNT
  // toward the band instead of guessing — the value lens measured the commonest failure
  // (under-floor) carried no way for the model to know how close it was.
  const lengths = units.map((u) => `${u.id}=${u.text.length}c`).join(', ')
  // RULING P7 (fix round B5, value Minor M1): " in " is 4 chars (1 space + "in" + 1 space), not
  // 5-7 — split each join word out individually instead of one lumped, imprecise range.
  const joinCosts = '", " = 2 chars, " and " = 5 chars, " with " = 6 chars, " in " = 4 chars, " — "/" | "/" & " = 3 chars, "a "/"an " = 2-3 chars'
  // RULING S1 (fix round B8a, value Blocking B1, folding in m2): NEVER send the DESIGN NAME line
  // when no identity unit was admitted — `designName` null, OR the name was dropped for a trademark,
  // a celebrity, or an untrue claim (`buildAdmittedUnits`'s identity loop). Before this, a DROPPED
  // name ("Disney Squad") was still sent with the "reproduce spelling EXACTLY" instruction even
  // though there is no identity unit id anywhere in `units` for the model to place — an impossible
  // instruction that leaked nothing (the model cannot write free text), but named a design the writer
  // was never going to be allowed to use.
  const hasIdentityUnit = units.some((u) => u.kind === 'identity')
  const user = [
    hasIdentityUnit ? `DESIGN NAME (reproduce spelling EXACTLY, including any typo): ${JSON.stringify(designName ?? '')}` : '',
    `ADMITTED UNITS (json), grouped by kind, each {"id":"...","text":"..."} — arrange these ids, never their text:`,
    JSON.stringify(grouped),
    // RULING P2 (fix round B5, compliance Important, value Blocking 2): name the REQUIRED brand
    // unit's id EXPLICITLY here — the "brand" GROUP above is EMPTY whenever the brand is pool-
    // sourced (K2 classes it `kind: 'pool'`), so a model that only reads the grouped JSON has no
    // way to find it there.
    brandUnit ? `REQUIRED BRAND UNIT: id "${brandUnit.id}" (text: ${JSON.stringify(brandUnit.text)}) — list-join only.` : '',
    `Unit character lengths (to help you count toward the ${CONTENT_CONTRACT.itemHighlights.min}-${CONTENT_CONTRACT.itemHighlights.max} band): ${lengths}`,
    `Join costs (added between units, roughly): ${joinCosts}`,
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
/** RULING W5 (fix round B7b, wire minor): the sentinel `askWriter` returns when ITS OWN deadline
 *  check fires — never a real object shape `judgeWriterArrangement`/`parseJsonLoose` could produce,
 *  so `draft === WRITER_DEADLINE_SKIPPED` is an exact, unambiguous test. A plain module-private
 *  `Symbol`, not exported. */
const WRITER_DEADLINE_SKIPPED: unique symbol = Symbol('writer-deadline-skipped')

/** RULING P9 (fix round B5, wire Blocking 2): `deadlineAt` (an absolute epoch-ms bound, ONE per
 *  regen, threaded down from `runWriterForDesign`) bounds THIS call's own SDK request — never only
 *  the loop-level check between retries. When less than the per-call `20_000`ms budget remains, the
 *  call is given exactly the remaining time (via BOTH the SDK's own `timeout` option and an
 *  `AbortSignal.timeout` — the ruling's own "carried as an AbortSignal" wording), so the worst case
 *  per call is `min(20_000, remaining)`, never a full new 20s window after the deadline has all but
 *  passed. When the deadline has ALREADY passed, the call is skipped entirely (no network round
 *  trip spent chasing a result nobody will use).
 *  RULING W5 (fix round B7b, wire minor): the skip above returns `WRITER_DEADLINE_SKIPPED`, a
 *  distinct sentinel from the `{}` the catch block below returns on a REAL (attempted, billable)
 *  failure — `runWriterForDesign`'s retry loop checks for it and does NOT advance `callsMade`,
 *  because no network round trip happened. Before this, `callsMade = call` ran unconditionally right
 *  after every `askWriter` return, so the loop-level deadline check (just above THIS call, in the
 *  retry loop) racing against `askWriter`'s OWN `remainingMs <= 0` check — deadline passes in the
 *  gap between them — over-counted a call that spent nothing. */
async function askWriter(
  openai: OpenAI, model: string, units: readonly AdmittedUnit[], designName: string | null,
  priorViolations: readonly string[], deadlineAt?: number, allowedBrand?: string | null,
): Promise<unknown> {
  const { system, user } = buildWriterPrompt(units, designName, priorViolations, allowedBrand ?? null)
  const remainingMs = deadlineAt !== undefined ? deadlineAt - Date.now() : Number.POSITIVE_INFINITY
  if (remainingMs <= 0) {
    console.warn(`[ih-writer] ${model} call skipped — writer deadline already exceeded`)
    return WRITER_DEADLINE_SKIPPED
  }
  const callTimeout = Math.max(1, Math.min(20_000, remainingMs))
  try {
    const isGpt5 = /^(gpt-5|o\d)/.test(model)
    const messages = [{ role: 'system' as const, content: system }, { role: 'user' as const, content: user }]
    const r = await openai.chat.completions.create(
      isGpt5
        ? { model, messages, max_completion_tokens: 400, reasoning_effort: 'low' as const, response_format: { type: 'json_object' as const } }
        : { model, messages, temperature: 0.4, max_tokens: 250, response_format: { type: 'json_object' as const } },
      { timeout: callTimeout, maxRetries: 0, signal: AbortSignal.timeout(callTimeout) },
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
/** RULING P10 (fix round B5, wire Blocking 3): thrown by `runWriterForDesign` INSTEAD of the bare
 *  underlying error, carrying the number of billable calls ALREADY MADE before the throw (never 0
 *  by assumption) — so a caller's catch block can refund `IH_WRITER_RETRY_CAP - callsMade` instead
 *  of the full reservation. The wire lens measured 30 calls spent against an 18 budget because the
 *  catch in `listingPipeline.ts` refunded the FULL per-design cap even when calls were spent (the
 *  throw site — `judgeWriterArrangement`'s call into the caller-supplied `runTail`, itself calling
 *  `productDetailAttrs.ts`'s `ownBrandTokenSet` — is reached only AFTER `askWriter` already spent
 *  the call). The ORIGINAL error is preserved as `cause` for logging. */
export class WriterPartialCallsError extends Error {
  constructor(message: string, public readonly callsMade: number, public readonly reasonsSoFar: readonly string[]) {
    super(message)
    this.name = 'WriterPartialCallsError'
  }
}

export async function runWriterForDesign(args: {
  // RULING R1 (fix round B7a): `needBrand` added, OPTIONAL (never required, so no existing literal
  // test fixture that omits it becomes a type error) — the judge's brand-required check is keyed on
  // it EXPLICITLY (below) when present. Every existing production caller already passes the full
  // `ComposerResult`, which carries this field (required, `boolean`) on every exit.
  composed: Pick<ComposerResult, 'candidates' | 'specFacts' | 'brandPick' | 'wearFact'> & { needBrand?: boolean }
  fallbackHold: string | null
  designName: string | null
  identityPhrases?: readonly string[]
  truthCtx: PhraseTruthCtx
  runTail: (line: string) => { value: string; hold: string | null; reason?: string | null }
  deps?: WriterDeps
  model?: string
  /** RULING P9 (fix round B5, wire Blocking 2): the REGEN-LEVEL absolute deadline (epoch ms), the
   *  SAME value threaded through every design in the family (and the single design on the
   *  single-design path) — checked BETWEEN retries here (closing the in-flight-design gap: a
   *  design already inside its own 3x20s loop used to keep spending calls past the deadline check
   *  that only ran BEFORE a design reserved), and handed to `askWriter` so the per-call SDK timeout
   *  itself never exceeds the remaining budget. `undefined` (every pre-P9 caller) is a no-op. */
  deadlineAt?: number
}): Promise<WriterRunResult> {
  // B8 eligibility.
  if (args.fallbackHold === 'unrated-pool') return { accepted: false, value: '', reasons: ['skip: unrated-pool'], calls: 0 }
  const pool = args.composed.candidates ?? []
  if (pool.length === 0) return { accepted: false, value: '', reasons: ['skip: zero admitted pool units'], calls: 0 }
  // W8: non-apparel families never write (the field composes no garment vocabulary for them either).
  if (args.truthCtx.garmentFamily === 'none') return { accepted: false, value: '', reasons: ['skip: non-apparel family'], calls: 0 }
  // RULING R1 (fix round B7a, compliance Blocking): if the identity and the composer's mandatory
  // brand pick collide in a way neither unit's own admission can resolve (the identity does NOT
  // itself carry the brand, yet shares a significant word with it), no arrangement could ever
  // legally carry BOTH mandatory units (`buildAdmittedUnits` never filters either one — R1's other
  // half). Skip the writer entirely, 0 calls, named reason — the composer ships.
  const identityTextForBrand = (args.designName ?? '').trim() || null
  if (mandatoryBrandStatus(identityTextForBrand, args.composed.brandPick ?? null, args.truthCtx.allowedBrand ?? null) === 'collision') {
    console.warn(JSON.stringify({ tag: 'IH_WRITER_SKIP', design: identityTextForBrand, reason: 'mandatory-collision' }))
    return { accepted: false, value: '', reasons: ['skip: mandatory-collision (identity and required brand collide)'], calls: 0 }
  }

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
  // RULING P10: tracked OUTSIDE the try so the catch below can always read the true count, even
  // when the throw happens synchronously inside `judgeWriterArrangement`/`runTail`, AFTER the call
  // that incremented it.
  let callsMade = 0
  try {
    for (let call = 1; call <= IH_WRITER_RETRY_CAP; call++) {
      // RULING P9: checked BETWEEN retries — an in-flight design's own loop now honours the SAME
      // regen-level deadline every OTHER pending design is checked against before it reserves.
      if (args.deadlineAt !== undefined && Date.now() >= args.deadlineAt) {
        reasonsAll.push('skip: writer deadline exceeded mid-retry')
        break
      }
      const draft = await askWriter(openai, model, units, args.designName, priorViolations, args.deadlineAt, args.truthCtx.allowedBrand)
      if (draft === WRITER_DEADLINE_SKIPPED) {
        // RULING W5: askWriter's OWN deadline check fired — a race against the loop-level check just
        // above, never a network round trip, so it is NOT a billable call (callsMade unchanged).
        reasonsAll.push('skip: writer deadline exceeded mid-call')
        break
      }
      callsMade = call
      const verdict = judgeWriterArrangement(draft, units, { truthCtx: args.truthCtx, runTail: args.runTail, needBrand: args.composed.needBrand })
      if (verdict.ok) return { accepted: true, value: verdict.value, reasons: reasonsAll, calls: call }
      reasonsAll.push(...verdict.violations)
      priorViolations = verdict.violations
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    throw new WriterPartialCallsError(`writer-side bug after ${callsMade} call(s): ${message}`, callsMade, reasonsAll)
  }
  return { accepted: false, value: '', reasons: reasonsAll, calls: callsMade }
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
