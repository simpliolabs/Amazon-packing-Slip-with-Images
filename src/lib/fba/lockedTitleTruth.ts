/**
 * lockedTitleTruth.ts — makes a LOCKED title's lies VISIBLE without ever rewriting them.
 *
 * PO-approved 2026-08-22, live case B0DSCDZC6K: the parent title was locked (`title_source='manual'`)
 * as "THE CEO Motivational Entrepreneur Tee Shirt | Funny Business Tshirt for Men" while the family's
 * resolved blank is a Gildan 18000 sweatshirt (+18500 hoodie), `audience_lean='unisex'`. A locked
 * title is passed through untouched by every regen — BY DESIGN, to protect the seller's wording from
 * AI rewrites — so this title called a fleece sweatshirt a "Tee Shirt" and asserted "for Men" on a
 * unisex family, and would have done so FOREVER. The PO's words: a lock currently protects a lie as
 * effectively as it protects their wording.
 *
 * A LOCK MUST STILL PREVENT REWRITING. This module never edits, drops, or regenerates a single byte
 * of a locked title — it only REPORTS what is wrong with it, in the reason codes the content-truth
 * spine already uses (contentTruth.ts), so a human can decide whether to unlock.
 *
 * NO NEW RULE LOGIC, NO DUPLICATED LEXICONS. Every verdict comes from `phraseTruthVerdict` — the ONE
 * garment/audience/competitor-brand/capability truth predicate the whole content pipeline already
 * asks. This module never re-derives a garment noun regex, an audience-word list, or a brand list; it
 * only varies the CTX it hands to that one predicate (see `lockedTitleViolations` below) and, for the
 * garment message, reads the already-exported `garmentNounConstraint` (built from the SAME class table
 * the predicate itself gates on) to say which forbidden word the title used.
 *
 * `lockedTitleViolations` is pure (no I/O) and takes an already-resolved `PhraseTruthCtx` — building
 * that ctx from the DB (blank resolution, audience_lean) is the caller's job (see the ai-recommendations
 * GET route, which is the one place today that builds it, via `resolveLockedTitleTruthCtx` below).
 */
import {
  phraseTruthVerdict, garmentNounConstraint,
  normalizeAudienceLean, buildPhraseTruthCtx,
  type PhraseTruthCtx, type PhraseTruthReason,
} from './contentTruth'
import {
  loadBlankSpecRows, loadBlankAssignments, resolveFamilyBlank, familyGarmentUnion,
} from './blankSpecs'

export interface LockedTitleViolation {
  reason: PhraseTruthReason
  /** Plain-English, ready to show the seller. Never prose the predicate wrote — built here from the
   *  structured reason + the resolved blank facts. */
  message: string
}

/** Human display label for a resolved garment family, for the message text only. */
const FAMILY_LABEL: Record<string, string> = {
  tee: 'tee', long_sleeve_tee: 'long sleeve tee', kids_tee: 'kids tee',
  sweatshirt: 'sweatshirt', hoodie: 'hoodie', hat: 'hat',
}

/** DISPLAY-ONLY (does not participate in any verdict — phraseTruthVerdict already decided this title
 *  is a forced-gender lie before this ever runs). Finds a "for Men"/"for Women" style snippet to quote
 *  in the warning copy; falls back to a generic sentence when the phrasing doesn't match. */
const GENDER_DISPLAY_RE = /\bfor\s+(?:m[ae]n|wom[ae]n)(?:['’]s)?\b/i

/** Which ctx field gates a given reason — i.e. which field, when nulled, turns that rule OFF so a
 *  second call to `phraseTruthVerdict` can surface whatever it was masking. `capability-claim`,
 *  `competitor-brand` and `weight-class-lie` have no ctx gate (they are unconditional regex checks in
 *  the predicate), so they cannot be safely "peeled" without re-deriving which text matched — which
 *  would duplicate the lexicon this module is forbidden from touching. Peeling stops there; a segment
 *  that stacks one of those under something else may under-report, which is a known, accepted limit. */
function withGateDisabled(ctx: PhraseTruthCtx, reason: PhraseTruthReason): PhraseTruthCtx | null {
  switch (reason) {
    case 'wrong-garment-noun':
    case 'garment-vocab-on-non-apparel':
      return { ...ctx, garmentFamily: null, mixedFamilies: undefined }
    case 'audience-adult-on-kids':
    case 'audience-kids-on-adult':
      return { ...ctx, audience: null }
    case 'audience-lean-lie':
      return { ...ctx, audienceLean: null }
    default:
      return null
  }
}

function messageFor(reason: PhraseTruthReason, title: string, ctx: PhraseTruthCtx, blankLabel: string | null | undefined): string {
  const suffix = blankLabel ? ` (${blankLabel})` : ''
  switch (reason) {
    case 'wrong-garment-noun':
    case 'garment-vocab-on-non-apparel': {
      const trueLabel = ctx.garmentFamily === 'none'
        ? 'non-apparel product'
        : FAMILY_LABEL[ctx.garmentFamily ?? ''] ?? 'different garment'
      const { forbidden } = garmentNounConstraint(ctx)
      const hits: { word: string; at: number }[] = []
      for (const w of forbidden) {
        const m = title.match(new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'))
        if (m && m.index !== undefined && !hits.some((h) => h.word.toLowerCase() === m[0].toLowerCase())) {
          hits.push({ word: m[0], at: m.index })
        }
      }
      const quoted = hits.sort((a, b) => a.at - b.at).map((h) => h.word).join(' ')
      return quoted
        ? `Locked title says '${quoted}' but this family is a ${trueLabel}${suffix}.`
        : `Locked title names a garment this family is not — the resolved blank is a ${trueLabel}${suffix}.`
    }
    case 'audience-lean-lie': {
      const hit = title.match(GENDER_DISPLAY_RE)?.[0]
      return hit
        ? `Locked title says '${hit.trim()}' but this family is unisex.`
        : `Locked title asserts a single gender but this family's audience lean is unisex.`
    }
    case 'competitor-brand':
      return `Locked title names another blank maker's brand instead of this family's own${suffix}.`
    case 'capability-claim':
      return 'Locked title makes a capability claim (e.g. moisture-wicking, UPF, water-resistant) this blank does not state.'
    case 'audience-adult-on-kids':
      return 'Locked title uses adult-audience wording, but this family is a kids blank.'
    case 'audience-kids-on-adult':
      return 'Locked title uses kids-audience wording, but this family is an adult blank.'
    case 'weight-class-lie':
      return 'Locked title states a fabric weight class this blank does not back.'
    default:
      return 'Locked title conflicts with the resolved product facts.'
  }
}

/**
 * THE predicate this feature ships. Returns every distinct violation reason the locked `title` carries
 * against the family's truth `ctx`, or `[]` when there is nothing to report.
 *
 * FAIL-OPEN AND LOCK-GATED, on purpose:
 *   - `titleSource !== 'manual'` → `[]` — an unlocked (AI-owned) title is never analyzed; the terminal
 *     title-truth net already keeps THAT title honest on every regen, so a second opinion here would
 *     be noise at best and a second source of truth at worst. UNLESS `opts.forceAnalyze` (PO ruling
 *     2026-08-24): the `TITLE_TRUTHFUL_SHIP_FLOOR` fix in titleBand.ts introduced exactly one AI-owned
 *     path where that assumption no longer holds — `settleTruthBand`'s `refused-kept-lying-prior`
 *     decision deliberately ships (keeps) a prior it KNOWS fails truth, when the honest replacement
 *     would be shorter than the 65-char floor. The caller (route.ts) sets `forceAnalyze: true` only
 *     for that complementary (non-manual) case, so this stays the SAME predicate/SAME ctx-building —
 *     never a second rulebook — just no longer gated to locked titles alone.
 *   - `ctx === null` (the family's blank did not resolve) → `[]` — same fail-open doctrine as the rest
 *     of the truth spine (contentTruth.ts's `truthCtxFor`): no ground truth, nothing to judge against.
 *
 * HOW MULTIPLE VIOLATIONS ARE FOUND WITHOUT A SECOND RULEBOOK: `phraseTruthVerdict` returns only the
 * FIRST rule it hits (garment → capability → audience → forced-gender → competitor-brand → weight, in
 * that order), so a title that is wrong in two ways at once (the live case: a garment lie AND a forced
 * gender in the same breath) needs more than one call to surface both. Each call here uses the exact
 * same predicate and the exact same ctx, with only the ALREADY-FOUND reason's gate turned off (a data
 * change to `ctx`, never a rule rewrite) — see `withGateDisabled`.
 *
 * KNOWN LIMIT (unchanged by the `forceAnalyze` addition): this predicate is `phraseTruthVerdict`
 * (garment/audience/brand/capability/weight) only — it does not see a sibling-design-name defect,
 * which needs `foreignTokens`/`reject` (`verdictForAssembledTitle`'s richer ctx, not built here). A
 * title that fails ONLY on a sibling name will report no violations. Accepted for the same reason the
 * `withGateDisabled` peeling stops where it does: a second, hand-rolled foreign-name resolver at read
 * time is a second partition, which this module's whole doctrine forbids.
 */
export function lockedTitleViolations(
  title: string,
  titleSource: string | null | undefined,
  ctx: PhraseTruthCtx | null,
  blankLabel?: string | null,
  opts?: { forceAnalyze?: boolean },
): LockedTitleViolation[] {
  if (titleSource !== 'manual' && !opts?.forceAnalyze) return []
  if (!ctx || !title || !title.trim()) return []
  const reasons: PhraseTruthReason[] = []
  let probeCtx: PhraseTruthCtx = ctx
  for (let i = 0; i < 6; i++) {
    const verdict = phraseTruthVerdict(title, probeCtx)
    if (verdict.ok) break
    if (reasons.includes(verdict.reason)) break
    reasons.push(verdict.reason)
    const next = withGateDisabled(probeCtx, verdict.reason)
    if (!next) break
    probeCtx = next
  }
  return reasons.map((reason) => ({ reason, message: messageFor(reason, title, ctx, blankLabel) }))
}

/**
 * Builds the `PhraseTruthCtx` (+ a display-only blank label like "Gildan 18000") for a parent ASIN's
 * LOCKED title analysis — the DB-touching half `lockedTitleViolations` deliberately has none of.
 *
 * BLANK-GROUNDED, NEVER TITLE-DERIVED (contentTruth.ts's own doctrine: "a title cannot vouch for
 * itself"): the hay fed to `resolveFamilyBlank` is built from `listing_content` (the live child SKUs
 * and their OWN stored titles) — never from the locked `recommended_title` being analyzed. Composes
 * the exact same exported resolver functions `listingPipeline.ts` and `resolveFamilyBlankForNet` call
 * (`resolveFamilyBlank`, `familyGarmentUnion`, `loadBlankSpecRows`, `loadBlankAssignments`) — no new
 * resolution algorithm, just this feature's own assembly of the existing ones.
 *
 * `ctx.allowedBrand` follows the customer-copy rule (brand_in_copy:false blanks like Gildan carry an
 * empty allowedBrand there, because the brand may never SHIP), but `blankLabel` is INTERNAL/seller-
 * facing only — this is a portal warning, not customer copy — so it may still name the maker + style
 * code even for a brand_in_copy:false blank (that's the whole point of "(Gildan 18000)" in the copy).
 *
 * Fail-open: any read/resolution failure, or an unresolved blank, returns `{ ctx: null, blankLabel:
 * null }` — same doctrine as every other blank-truth site in this repo.
 */
export async function resolveLockedTitleTruthCtx(
  // Any supabase-js client (the caller constructs its own); the minimal surface used here.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  opts: { parentAsin: string; audienceLean?: string | null },
): Promise<{ ctx: PhraseTruthCtx | null; blankLabel: string | null }> {
  try {
    const { data, error } = await db
      .from('listing_content')
      .select('sku, title')
      .eq('parent_asin', opts.parentAsin)
      .limit(500)
    if (error) console.warn(`[lockedTitleTruth] listing_content read failed for ${opts.parentAsin}: ${error.message}`)
    const rows = Array.isArray(data) ? (data as { sku?: string | null; title?: string | null }[]) : []
    const liveTitle = rows.find((r) => (r.title ?? '').trim())?.title ?? ''
    const skuHay = rows.map((r) => r.sku).filter(Boolean).join(' ')
    const hay = [liveTitle, skuHay].filter(Boolean).join(' ')

    const [catalog, assignments] = await Promise.all([loadBlankSpecRows(), loadBlankAssignments()])
    const override = assignments.family.get(opts.parentAsin.trim().toUpperCase()) ?? null
    const res = resolveFamilyBlank(catalog, rows, override, hay, assignments.child)
    if (!res.garmentFamily) return { ctx: null, blankLabel: null }   // unresolved blank — fail open

    const union = familyGarmentUnion(catalog, res, hay)
    const ctx = buildPhraseTruthCtx({
      garmentFamily: res.garmentFamily,
      mixedFamilies: union,
      spec: res.spec,
      allowedBrand: res.spec?.brandInCopy === false ? '' : (res.spec?.brand ?? null),
      // No design-name source on this DB-light read path (listing_content carries sku/title only,
      // no design-name column) — [] is the pre-existing behavior, now flowing through the SAME
      // builder generation uses instead of a silently duplicated literal. Wiring a real source is a
      // separate change (would need a new resolver, which this fix deliberately does not add).
      designTokens: [],
      audienceLean: opts.audienceLean as Parameters<typeof normalizeAudienceLean>[0],
    }, 'title')
    if (!ctx) return { ctx: null, blankLabel: null }   // defensive; res.garmentFamily was checked above
    const blankLabel = res.dominant ? [res.dominant.spec.brand, res.dominant.styleCode].filter(Boolean).join(' ').trim() || null : null
    return { ctx, blankLabel }
  } catch (e) {
    console.warn('[lockedTitleTruth] ctx resolution failed (fail-open):', e instanceof Error ? e.message : e)
    return { ctx: null, blankLabel: null }
  }
}
