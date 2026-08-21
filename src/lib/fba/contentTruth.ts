/**
 * contentTruth.ts — THE shared content truth spine (PO-approved 2026-08-21, after four live defects
 * on B0DSCDZC6K, a Gildan 18000 sweatshirt + 18500 hoodie family stored `audience_lean='unisex'`).
 *
 * WHAT WENT WRONG. The Item Highlights composer already had a truth stage: ONE pure predicate every
 * candidate phrase had to pass before it could be composed (garment-noun truth, capability claims,
 * kids/adult audience, competitor blanks, weight class). It was wired to the Item Highlight composer
 * and NOWHERE ELSE. Meanwhile:
 *   (a) the TITLE fill appended pool phrases WORD BY WORD with no provenance check, so "mind your
 *       business" shipped as a dangling ", Mind";
 *   (b) the TITLE said "Funny Work Shirts" on a SWEATSHIRT/HOODIE family, because the only garment
 *       net on the title path (`stripContradictedGarments`) grounds in a haystack DERIVED FROM THE
 *       TITLE — when the title carries the lie, the net agrees with it;
 *   (c) the TITLE said "for Women" on a family whose stored audience_lean is 'unisex' — nothing
 *       mapped audience_lean onto any fill;
 *   (d) competitor blank brands were stripped from bullets and description but NOT the title.
 *
 * THE CURE IS ONE SEAM, NOT FOUR NETS. This module owns the predicate; every field's deterministic
 * fill asks it the same question about the same phrase. The rules are BLANK-GROUNDED (resolveFamilyBlank
 * → garment_family / BlankSpec), never title-derived — that is the whole point: a title cannot vouch
 * for itself. `ihTruthVerdict` is re-exported from itemHighlightComposer.ts as a thin wrapper so the
 * composer and its pins are untouched byte-for-byte.
 *
 * FIELD-AGNOSTIC BY DEFAULT. Every rule applies to every field except ONE: `audience-lean-lie`
 * (PO gold pattern "no forced gender"). A unisex family's TITLE is a product claim and may not
 * assert a single gender; its bullets/description/backend carry MARKET vocabulary where a gendered
 * phrase is legitimate shopper language. That asymmetry is the ONLY thing `ctx.field` decides.
 *
 * Pure data + pure functions. No side effects, no imports beyond blankSpecs — safe to import anywhere.
 */
import { trueWeightClass, PERFORMANCE_CLAIM_RE, type BlankSpec, type GarmentFamily } from './blankSpecs'

/** The truth stage's garment vocabulary: the blank_specs enum UNFOLDED (kids_tee must reach the
 *  audience rule; long_sleeve_tee names its own spec phrase), plus the title-guess values. */
export type TruthGarmentFamily = GarmentFamily | 'hat' | 'none' | null

/** The content surfaces the spine gates. Only `audience-lean-lie` reads this; see the header. */
export type ContentField = 'title' | 'bullets' | 'description' | 'backend' | 'highlights'

export type PhraseTruthReason =
  | 'wrong-garment-noun'            // names a garment the family is not (jersey/hooded on a tee…)
  | 'garment-vocab-on-non-apparel'  // any garment word on a 'none' (Electronics) family
  | 'capability-claim'              // sun protection / UPF / moisture-wicking… — no blank states it
  | 'audience-adult-on-kids'        // women/men/ladies/plus-size on a kids_tee family
  | 'audience-kids-on-adult'        // kids/toddler/youth/boys/girls/baby on an adult family
  | 'competitor-brand'              // another blank maker (Pro Club, Gildan…) unless it is the family's own
  | 'weight-class-lie'              // light/mid/heavyweight that the blank's weightNote does not back
  | 'audience-lean-lie'             // a single gender asserted in the TITLE of a unisex-lean family

/** The seller's declared audience lean, normalized to what the truth rule needs. */
export type TruthAudienceLean = 'unisex' | 'women' | 'men' | null

export interface PhraseTruthCtx {
  garmentFamily: TruthGarmentFamily | undefined
  /** BlankSpec has no capability field today, so the capability rule is unconditional; weightNote
   *  backs the weight-class rule. */
  spec: Pick<BlankSpec, 'weightNote'> | null | undefined
  allowedBrand: string | null | undefined
  audience: 'kids' | 'adult' | null
  /** EVERY garment family present in a MIXED variation family (B0DSCDZC6K ships Gildan 18000
   *  sweatshirts AND 18500 hoodies under one parent). `resolveFamilyBlank` reports a single
   *  DOMINANT family, so judging a hoodie noun against the sweatshirt row alone would call a true
   *  word a lie. When present, the allowed garment classes are the UNION over these families.
   *  Absent/empty ⇒ exactly `garmentFamily` alone (the Item-Highlight contract, unchanged). */
  mixedFamilies?: readonly TruthGarmentFamily[]
  /** Seller-declared lean. Only 'unisex' can trigger a rule, and only on the TITLE. */
  audienceLean?: TruthAudienceLean
  /** Which surface is asking. Field-agnostic for every rule except `audience-lean-lie`. */
  field: ContentField
}

export type PhraseTruthVerdict = { ok: true } | { ok: false; reason: PhraseTruthReason }

/* ─── LEXICONS (moved verbatim from itemHighlightComposer.ts — behavior byte-identical) ────────── */

/** Competitor blank/apparel makers — never composable unless the family's own allowed brand.
 *  The trademark lexicon covers franchises/marks, not blanks (the Darlin' pool composed
 *  "Pro Club Shirts" straight through it).
 *  FISHING / OUTDOOR APPAREL (2026-08-21, seen in live pools: "huk shirts for men", "magellan
 *  fishing shirts"): a shopper typing a maker's name wants THAT maker — never this blank. Scoped to
 *  the truth stage only: "columbia" / "magellan" double as place/design words elsewhere
 *  (listingPipeline.ts:968), and declining to PLACE a phrase is a hold, not a publish. */
export const APPAREL_BRAND_RE = /\b(?:pro\s?club|gild[ae]n|guildan|softstyle|heavy\s?cotton\s?brand|hanes|fruit\s+of\s+the\s+loom|next\s+level|bella\s?canvas|american\s+apparel|champion|carhartt|comfort\s+colors|huk|bassdash|columbia|under\s*armou?r|magellan|simms|aftco|pelagic)\b/i

export const GARMENT_SURFACE_RE = /\b(?:t[-\s]?shirts?|tees?|tshirts?|shirts?|apparel|tops?|clothing|hoodies?|sweatshirts?|garments?)\b/i

/** Every garment noun the lexicon knows; longer multi-word forms FIRST so "hooded sweatshirt" /
 *  "tank top" match as one noun. `crewnecks?` is the one-word sweatshirt noun ("crew neck" two
 *  words is a neck style and not a noun). */
const GARMENT_NOUN_RE = /\b(?:hooded[\s-]?sweatshirts?|tank[\s-]?tops?|t[\s-]?shirts?|tshirts?|tees?|shirts?|tops?|sweatshirts?|crewnecks?|pullovers?|hoodies?|hoodys?|hooded|jerseys?|tanks?|polos?|dress(?:es)?|sweaters?|jackets?|onesies?|bodysuits?|rompers?|leggings)\b/gi

/** A matched noun → its garment class. `crewneck` is its own class: a crew neck contradicts a hood. */
const garmentNounClass = (m: string): string => {
  const k = m.toLowerCase().replace(/[\s-]+/g, '')
  if (/^(?:t?shirts?|tees?|tops?)$/.test(k)) return 'tee'
  if (/^(?:sweatshirts?|pullovers?)$/.test(k)) return 'sweatshirt'
  if (/^crewnecks?$/.test(k)) return 'crewneck'
  if (/^(?:hoodies?|hoodys?|hooded|hoodedsweatshirts?)$/.test(k)) return 'hoodie'
  return k.replace(/s$/, '')
}
const TEE_CLASSES: ReadonlySet<string> = new Set(['tee'])
const SWEATSHIRT_CLASSES: ReadonlySet<string> = new Set(['sweatshirt', 'crewneck'])
const HOODIE_CLASSES: ReadonlySet<string> = new Set(['hoodie', 'sweatshirt'])

/** The garment classes ONE family may name. A hoodie IS a hooded sweatshirt (coordinator ruling
 *  2026-08-21): hoodie families accept hoodie / hooded sweatshirt / sweatshirt / pullover — only
 *  tee nouns (and a crew neck) are foreign to them. null = no noun rule (unresolved blank / hat). */
const classesForFamily = (gf: TruthGarmentFamily | undefined): ReadonlySet<string> | null => {
  if (gf === 'tee' || gf === 'long_sleeve_tee' || gf === 'kids_tee') return TEE_CLASSES
  if (gf === 'sweatshirt') return SWEATSHIRT_CLASSES
  if (gf === 'hoodie') return HOODIE_CLASSES
  return null
}

/** The allowed set for the whole VARIATION family: the union over every blank present. An empty
 *  `mixedFamilies` (the default, and every Item-Highlight caller) reduces to `classesForFamily`. */
const allowedGarmentClasses = (ctx: PhraseTruthCtx): ReadonlySet<string> | null => {
  const families = ctx.mixedFamilies && ctx.mixedFamilies.length ? ctx.mixedFamilies : [ctx.garmentFamily]
  const sets = families.map(classesForFamily)
  if (sets.some((s) => s === null)) return null          // any unresolved member ⇒ no noun rule
  const union = new Set<string>()
  for (const s of sets) for (const c of s as ReadonlySet<string>) union.add(c)
  return union.size ? union : null
}

// `womans`/`mans`/`lady` added 2026-08-21: "Womans Shirts" composed onto the kids family B0DP5H8QBT.
const ADULT_AUDIENCE_RE = /\b(?:women|woman|womens|womans|ladies|lady|men|mens|mans|adults?|plus[\s-]?size)\b/i
const KIDS_AUDIENCE_RE = /\b(?:kids?|toddlers?|youth|boys|girls|baby)\b/i

/** The two halves of the FORCED-GENDER rule. Adult gender words only — kids words are the
 *  kids/adult audience rule's business, and a phrase naming BOTH halves is INCLUSIVE, not forced. */
const LEAN_FEM_RE = /\b(?:wom[ae]n['’]?s?|ladies|lady)\b/i
const LEAN_MASC_RE = /\b(?:m[ae]n['’]?s?)\b/i

/** Audience is a property of the BLANK FAMILY (64000B youth tee ⇒ kids), never inferred from a title. */
export function audienceOfGarmentFamily(gf: TruthGarmentFamily | undefined): 'kids' | 'adult' | null {
  if (gf === 'kids_tee') return 'kids'
  if (gf === 'tee' || gf === 'long_sleeve_tee' || gf === 'sweatshirt' || gf === 'hoodie' || gf === 'hat') return 'adult'
  return null
}

/** PipelineInput.audienceLean → the truth rule's view. `lean_male`/`lean_female` are SOFT
 *  re-weightings (cross-gender traffic is the point of a lean), so they are NOT unisex and never
 *  trigger the forced-gender rule. */
export function normalizeAudienceLean(
  lean: 'male' | 'female' | 'lean_male' | 'lean_female' | 'unisex' | null | undefined,
): TruthAudienceLean {
  if (lean === 'unisex') return 'unisex'
  if (lean === 'female' || lean === 'lean_female') return 'women'
  if (lean === 'male' || lean === 'lean_male') return 'men'
  return null
}

/* ─── THE PREDICATE ───────────────────────────────────────────────────────────────────────────── */

/**
 * ONE pure truth predicate for a candidate phrase against the family's BLANK facts. Every
 * deterministic fill in the pipeline — title, bullets, description, backend, item highlights —
 * asks this and nothing else. Exported so the pins read as the PO's rulings.
 */
export function phraseTruthVerdict(phrase: string, ctx: PhraseTruthCtx): PhraseTruthVerdict {
  const gf = ctx.garmentFamily
  // (a) garment-noun truth — 'none' = NON-APPAREL (PO 2026-08-21: B0GCF11RKL is Electronics — the
  // composer put "T Shirts for Women" on a memory card); otherwise a phrase naming a garment class
  // the family is not (a tee is never a jersey/hoodie/sweatshirt; hooded ⇒ hoodie only).
  if (gf === 'none') {
    if (GARMENT_SURFACE_RE.test(phrase)) return { ok: false, reason: 'garment-vocab-on-non-apparel' }
  } else {
    const allowed = allowedGarmentClasses(ctx)
    if (allowed) {
      for (const m of phrase.matchAll(GARMENT_NOUN_RE)) {
        if (!allowed.has(garmentNounClass(m[0]))) return { ok: false, reason: 'wrong-garment-noun' }
      }
    }
  }
  // (b) capability claims — BlankSpec states no capability today ⇒ every such claim is unverifiable.
  if (PERFORMANCE_CLAIM_RE.test(phrase)) return { ok: false, reason: 'capability-claim' }
  // (c) audience truth — derived from the blank family, never a title.
  if (ctx.audience === 'kids' && ADULT_AUDIENCE_RE.test(phrase)) return { ok: false, reason: 'audience-adult-on-kids' }
  if (ctx.audience === 'adult' && KIDS_AUDIENCE_RE.test(phrase)) return { ok: false, reason: 'audience-kids-on-adult' }
  // (c2) FORCED GENDER — TITLE ONLY (PO gold pattern "no forced gender", live B0DSCDZC6K: the title
  // said "for Women" while the family's stored audience_lean is 'unisex'). The title is a PRODUCT
  // CLAIM; bullets/description/backend carry MARKET vocabulary, where a gendered shopper phrase is
  // legitimate and indexes real traffic — so this is the one field-scoped rule in the spine.
  // A phrase naming BOTH genders ("for men and women") is inclusive, not forced.
  if (ctx.field === 'title' && ctx.audienceLean === 'unisex') {
    const fem = LEAN_FEM_RE.test(phrase)
    const masc = LEAN_MASC_RE.test(phrase)
    if (fem !== masc) return { ok: false, reason: 'audience-lean-lie' }
  }
  // (d) competitor APPAREL brands — outside the trademark lexicon (it covers franchises, not blanks):
  // a pool row naming another maker never ships. The family's own allowed blank brand
  // (brand_in_copy, e.g. Comfort Colors) is exempted by name.
  const bm = phrase.match(APPAREL_BRAND_RE)
  if (bm && bm[0].toLowerCase() !== (ctx.allowedBrand ?? '').toLowerCase()) return { ok: false, reason: 'competitor-brand' }
  // (e) fabric-class truth — a weight-class word must match the blank (unknown blank ⇒ none).
  const wm = phrase.match(/\b(light|mid|middle|heavy)[\s-]?weight\b/i)
  if (wm) {
    const wt = trueWeightClass(ctx.spec)
    if (!wt || !wt.startsWith(wm[1].toLowerCase().slice(0, 3))) return { ok: false, reason: 'weight-class-lie' }
  }
  return { ok: true }
}

/** Convenience for the fills: `true` = the phrase may ship. */
export const phraseIsTrue = (phrase: string, ctx: PhraseTruthCtx): boolean => phraseTruthVerdict(phrase, ctx).ok

/* ─── THE TITLE TERMINAL NET ──────────────────────────────────────────────────────────────────── */

/**
 * The reasons the TITLE net may act on by DELETING a phrase from copy an LLM wrote.
 *
 * A candidate FILTER can reject anything for free — a rejected pool phrase costs nothing. A NET
 * deletes shipped bytes, so it only carries the reasons whose false-positive cost is bounded:
 *   • wrong-garment-noun / garment-vocab-on-non-apparel — defect (b). Blank-grounded, and the whole
 *     reason the title path had no truthful judge.
 *   • audience-lean-lie — defect (c). Fires only on an explicit seller-declared 'unisex'.
 * DELIBERATELY EXCLUDED:
 *   • competitor-brand — `stripCompetitorBlanks` already owns it on the title path and removes the
 *     BRAND WORD (keeping the rest of the phrase) with the family's own blank exempted by name.
 *     A whole-segment drop here would be strictly worse.
 *   • audience-adult-on-kids / audience-kids-on-adult — a DESIGN name legitimately carries these
 *     words ("Baby Shark", "Boys Trip"); on the title they are a false-positive factory. The
 *     candidate filter still rejects them from the FILL, which is where the pool leaks them in.
 *   • capability-claim / weight-class-lie — `stripCapabilityClaims` and `enforceFabricTruth` are the
 *     existing owners of those two invariants; a second net would be the eighth rulebook.
 */
export const TITLE_NET_REASONS: ReadonlySet<PhraseTruthReason> = new Set<PhraseTruthReason>([
  'wrong-garment-noun',
  'garment-vocab-on-non-apparel',
  'audience-lean-lie',
])

/** The trailing audience clause every title producer can emit. */
const AUDIENCE_TAIL_RE = /\s*[,|]?\s+for\s+(?:men|women)(?:['’]s)?\s*$/i

/**
 * TERMINAL title truth net — the ONE deterministic net that removes an UNTRUE phrase from a shipped
 * title, on every producer and every path (installed at `scrubPublished`, the single choke point
 * both `recommended_title` and `per_child_titles` pass through).
 *
 * WHY SEGMENTS ARE SAFE HERE AND NOT IN PROSE: an Amazon title is a phrase LIST — "BRAND Design
 * Noun | Keyphrase, Keyphrase, Keyphrase" — so dropping one segment leaves a grammatical title.
 * The FIRST segment is never dropped: it carries brand + design name + product noun (the money
 * phrase), and destroying it is strictly worse than the lie it might contain. Shortening is the
 * only edit this makes; the band net downstream re-pads from SPEC facts, never from the pool.
 *
 * `protectHay` (the family's design names) is the second safety rail: a segment is KEPT whenever
 * dropping it would delete a design word that survives NOWHERE ELSE in the title. A design name may
 * legitimately contain a comma ("See You Later, Alligator"), which would otherwise put half of it in
 * a droppable segment — and losing the seller's design is strictly worse than keeping a lie beside
 * it. A phrase that merely RESTATES design words already present elsewhere is still droppable.
 *
 * Idempotent (a second pass finds nothing left to drop) and a no-op when `ctx` names no blank.
 */
export function applyTitleTruthNet(title: string, ctx: PhraseTruthCtx, protectHay = ''): string {
  if (!title || !title.trim()) return title
  let t = title.trim()
  const words = (s: string): string[] => s.toLowerCase().match(/[a-z0-9]+/g) ?? []
  const protectedWords = new Set(words(protectHay).filter((w) => w.length > 2))
  /** Would dropping `seg` erase a design word the rest of the title no longer carries? */
  const carriesSoleDesignWord = (seg: string, rest: string): boolean => {
    const restWords = new Set(words(rest))
    return words(seg).some((w) => protectedWords.has(w) && !restWords.has(w))
  }

  // 1. The audience tail is its own phrase — judge and drop it WITHOUT taking its segment's content
  //    with it ("… Fall Crewneck for Women" must lose only " for Women").
  const tailMatch = t.match(AUDIENCE_TAIL_RE)
  if (tailMatch) {
    const verdict = phraseTruthVerdict(tailMatch[0], ctx)
    if (!verdict.ok && TITLE_NET_REASONS.has(verdict.reason)) {
      t = t.slice(0, t.length - tailMatch[0].length).replace(/[\s,|]+$/g, '').trim()
    }
  }

  // 2. Segment sweep. Split KEEPING the separators so the survivors rejoin exactly as written.
  const parts = t.split(/\s*([|,])\s*/)
  if (parts.length <= 1) return t
  const kept: string[] = [parts[0]]                    // segment 0 = the money phrase, never dropped
  // A dropped segment's separator is INHERITED by the next survivor. Dropping the phrase after the
  // pipe must not demote the title from the PO's gold "BRAND Design Noun | keyphrase" shape to a
  // comma list — the lie goes, the structure stays.
  let carried: string | null = null
  for (let i = 1; i + 1 < parts.length; i += 2) {
    const sep = parts[i]
    const seg = parts[i + 1]
    if (sep === undefined || seg === undefined || !seg.trim()) continue
    const verdict = phraseTruthVerdict(seg, ctx)
    if (!verdict.ok && TITLE_NET_REASONS.has(verdict.reason)) {
      // Everything that would remain if this segment went — segment 0 + the kept tail + the segments
      // still ahead. The design must survive the net; a redundant restatement need not.
      const rest = [parts[0], ...kept.slice(1), ...parts.slice(i + 2)].join(' ')
      if (!carriesSoleDesignWord(seg, rest)) {
        carried = carried === '|' || sep === '|' ? '|' : (carried ?? sep)
        continue                                                          // drop the untrue phrase
      }
    }
    // Rejoin in the shape the producers write: " | " around a pipe, ", " after a comma.
    const useSep = carried === '|' || sep === '|' ? '|' : sep
    carried = null
    kept.push(useSep === '|' ? ` | ${seg}` : `, ${seg}`)
  }
  return kept.join('').replace(/\s{2,}/g, ' ').replace(/[\s,|]+$/g, '').trim()
}
