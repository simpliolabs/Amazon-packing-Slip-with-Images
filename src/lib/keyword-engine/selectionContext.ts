/**
 * selectionContext.ts — THE ONE derivation of `SelectionContext` for every KEYWORD_TARGET_SET site.
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * `resolveRankingTargets` requires `ctx: SelectionContext { haystack, isApparel, designSeasons }`
 * (selection-core.ts:152-167). Seven call sites need one and they have wildly different things in
 * scope. Eight bespoke derivations is how this repo grew SEVEN disagreeing definitions of "covered".
 * So there is exactly ONE derivation, here, and it is the same one listingPipeline's SeasonPolicy
 * runs on (deriveDesignSeasons became a 3-line adapter over `deriveSeasonsFrom` below).
 *
 * THE ASYMMETRY THAT DICTATES THE DESIGN (PO 2026-07-23):
 *   designSeasons WRONGLY EMPTY      → the design's own occasion reads as somebody else's holiday
 *                                      and is routed to BACKEND ⇒ "Valentine not in the description",
 *                                      the bug the PO just paid to fix.
 *   designSeasons WRONGLY POPULATED  → an unrelated holiday becomes placeable in customer copy ⇒ the
 *                                      unfixable dock the blanket strip existed to prevent.
 * Both are unacceptable, so the ONLY safe rule is: read the SAME four design signals the generator
 * reads, from their persisted homes, and nothing else.
 *
 * WHY NOT `seasonsIn(theme_card)` (which selection-core.ts suggests, and which is one query
 * cheaper): `theme_card` is LLM free text and PO-hand-editable, so it can both hallucinate a season
 * the artwork does not have AND drift from what the generator strips against. It is a DERIVED
 * artifact of the sources below, which we read directly. EXCLUDED, deliberately.
 *
 * (Until 2026-08-09 there was a second, sharper reason: the card was built from design NAMES only,
 * so a vision-only design got no card at all. That asymmetry is now closed in the other direction —
 * `loadSelectionContextWithSources` hands the SAME four sources to `buildThemeCard` — but the
 * exclusion above stands on the drift argument alone and is unaffected.)
 *
 * ZERO 049 DEPENDENCY: this module never selects theme_card / selection_rank / theme_fit, so it is
 * safe to deploy BEFORE migration 049 is applied by hand.
 *
 * CYCLES: imports ./seasonalTerms (zero-import leaf), ./selection-core (imports only calculateScore /
 * nicheGuards / seasonalTerms) and ./loadListingContent (type-only import of checkPresence). It does
 * NOT import listingPipeline — listingPipeline imports THIS. Server-only by construction:
 * selectionMode() reads a non-NEXT_PUBLIC env var (selection-core.ts:198).
 */

import { seasonsIn } from './seasonalTerms'
import { RANKING_CANDIDATE_POOL, selectionEaseWeight, selectionMode, selectionSha, type SelectionContext } from './selection-core'
import { loadCoverageHaystack } from './loadListingContent'

/* ── APPAREL ─────────────────────────────────────────────────────────────────────────────────── */

/**
 * THE pool-apparel predicate — the gate on `selectRankingTargets`' apparel-only niche nets
 * (selection-core.ts:367). This is NOT `looksApparel` (listingPipeline.ts:1250), which answers a
 * different question ("should the COPY be framed as clothing?") from the SP-API productType and is
 * module-private inside a 9.2k-line OpenAI-importing module.
 *
 * The regex is transcribed VERBATIM from the four sites that already agree on it byte-for-byte and
 * already pair it with isOffNicheKeyword — syncKeywordIntelligence.ts:348, syncListingContent.ts:551,
 * rankAnalysis.ts:242, ai-recommendations/route.ts:263. Sharing it consolidates four copies into
 * one; it introduces no new rule. Do NOT "improve" the alternation here without migrating all four.
 */
export const POOL_APPAREL_RE = /\b(?:t-?shirts?|tshirts?|shirts?|hoodies?|sweatshirts?|apparel)\b/i

export function isApparelPool(text: string | null | undefined): boolean {
  return POOL_APPAREL_RE.test(text ?? '')
}

/* ── DESIGN SEASONS (the pure core — shared with listingPipeline) ─────────────────────────────── */

/**
 * The four design signals, decoupled from where they were loaded. `PipelineInput` supplies them
 * live; `loadDesignSeasonSources` reads the SAME four out of the DB. That is what makes the
 * generator's strip and the selector's slotting provably the same rule.
 */
export interface DesignSeasonSources {
  /** listing_seo_scores.design_name_override (migration 031) — the seller's scalar design name. */
  designNameOverride?: string | null
  /** listing_seo_scores.design_name_overrides (migration 034) — {designKey: name}. UNION across the
   *  whole family, so a Valentine+Christmas parent carries BOTH occasions. */
  designNameOverridesByKey?: Record<string, string> | null
  /** product_identity.identity_data — what is literally PRINTED on the garment. Safe by
   *  construction: vision says "christmas" only when the artwork IS christmas. */
  visionDesign?: { designTheme?: string | null; visualElements?: string[] | null; seedKeywords?: string[] | null } | null
  /** extractDesignName's resolved name. Live in the pipeline; persisted as
   *  listing_seo_recommendations.keyword_plan.designName for every other caller. */
  resolvedDesignName?: string | null
}

/**
 * The design's OWN theme text → canonical occasions. Body transcribed from listingPipeline.ts:1328-1339
 * so the two cannot drift; that function now delegates here.
 *
 * DELIBERATELY EXCLUDED, unchanged from :1324-1327: `visionDesign.suggestedSearchTerms` and
 * `nicheSeeds` (shopper-QUERY shaped — "valentines day gift for her" would hand a non-seasonal design
 * a season it does not have), and the LIVE LISTING TITLE (an incidental "Christmas Gift for Golfers"
 * tail re-creates the exact misfire the blanket strip was written to prevent).
 */
export function deriveSeasonsFrom(src: DesignSeasonSources): string[] {
  const parts: string[] = [
    (src.designNameOverride ?? '').trim(),
    ...Object.values(src.designNameOverridesByKey ?? {}).map((v) => (v ?? '').trim()),
    (src.visionDesign?.designTheme ?? '').trim(),
    ...(src.visionDesign?.visualElements ?? []),
    ...(src.visionDesign?.seedKeywords ?? []),
    (src.resolvedDesignName ?? '').trim(),
  ].filter(Boolean)
  // UNION across every design in the family, de-duplicated, insertion-ordered (stable logs).
  return [...new Set(seasonsIn(parts.join(' | ')))]
}

/* ── CONTEXT ASSEMBLY ────────────────────────────────────────────────────────────────────────── */

/**
 * The flag-OFF context. `off` must make ZERO network calls (doctrine 2), and at `off`
 * resolveRankingTargets returns the caller's legacy list before ctx is ever read — so an inert value
 * is not merely safe, it is unobservable.
 *
 * It is ALSO the fail-open value: `isApparel:false` skips the apparel niche nets entirely
 * (selection-core.ts:367 short-circuits), and `designSeasons:[]` makes every seasonal keyword
 * off-season, which is the historical blanket behaviour preserved byte-for-byte
 * (seasonalTerms.ts:118-122). A degraded context can therefore only ever be MORE conservative than
 * today; it can never invent a season.
 */
export const INERT_SELECTION_CONTEXT: SelectionContext = { haystack: '', isApparel: false, designSeasons: [], lean: null, easeWeight: 0 }

/** Assembly from pieces the caller already has. No I/O, no queries — callers that hold every
 *  input (the scorer, the rank panel) use this and pay zero extra queries.
 *  ONE deliberate call-time flag read lives here: `selectionEaseWeight()` (KEYWORD_EASE_WEIGHT,
 *  PO 2026-08-08 ease-aware priority). It is read in THE one derivation precisely so no two sites
 *  can ever disagree on the weight — and at the unset default it returns 0, which keeps every
 *  verdict byte-identical (selection-core's easeBonus contributes nothing at 0). */
export function buildSelectionContext(
  parts: { haystack?: string | null; audienceLean?: string | null } & DesignSeasonSources,
): SelectionContext {
  const haystack = (parts.haystack ?? '').toLowerCase()
  // isApparel is DERIVED FROM the haystack, never supplied independently, so `{isApparel: true,
  // haystack: ''}` — the inverted-rescue case selection-core.ts:365-366 warns about — is
  // structurally unconstructible by any caller.
  // lean: only the two HARD values pass through (selection-core's contract); soft leans
  // ('lean_female' etc.) and absence normalize to null = no exclusion, today's behaviour.
  const lean = parts.audienceLean === 'female' || parts.audienceLean === 'male' ? parts.audienceLean : null
  return { haystack, isApparel: isApparelPool(haystack), designSeasons: deriveSeasonsFrom(parts), lean, easeWeight: selectionEaseWeight() }
}

/* ── PARITY ORACLE ───────────────────────────────────────────────────────────────────────────── */

/**
 * Content hash of a context. Reuses selection-core's exported pure FNV-1a — NEVER a second hash.
 *
 * This is the shadow-acceptance gate: every site touching ONE listing must print the SAME `ctxSha`.
 * `[KW_TARGET_SET].shaNext` proves two sites picked the same 30; `ctxSha` proves they were ASKED
 * the same question. Without it a shaNext match on a saturated pool (persistedIsComplete's
 * `ranks.length < poolSize` test fails ⇒ permanent recompute on thin pools) is not evidence of
 * agreement at all.
 */
export function ctxSha(c: SelectionContext): string {
  // `lean` is a selection input, so it MUST be in the sha: two sites disagreeing on the lean would
  // pick different sets, and the oracle's whole job is to make that disagreement loud.
  // `easeWeight` is DELIBERATELY excluded: like `selectionMode` itself (also absent), it is ONE
  // process-wide env value read at exactly one place (`buildSelectionContext`), so per-site
  // disagreement is structurally impossible — and excluding it keeps every existing ctxSha stable
  // across the KEYWORD_EASE_WEIGHT rollout. The weight in force is visible on the same log lines
  // via `[KW_TARGET_SET].easeWeight` instead.
  return selectionSha([c.haystack, c.isApparel ? 'apparel' : 'non-apparel', c.lean ?? 'no-lean', ...c.designSeasons])
}

/* ── READ WINDOW (§P PRECONDITION) ───────────────────────────────────────────────────────────── */

/**
 * THE read-window helper. Every consumer that reads keyword_analysis passes
 * `readWindow(<its own legacy limit>)`.
 *
 * At `off` the caller's legacy limit is returned UNCHANGED. That is REQUIRED, not polish:
 * syncListingContent's criticalSeen loop consumes its window IN ORDER and caps at 10, so widening
 * 100 → 120 can move criticalCount 6 → 9 and the keyword dock -5 → -8 with no seller action. `off`
 * must be byte-identical.
 *
 * Math.max, not a replacement: ai-recommendations already reads 150 and must keep it.
 *
 * ⚠️ GATED ON `=== 'on'`, NOT `!== 'off'` (2026-07-24, adversarial review — this was a FATAL).
 * Doctrine 2 says `shadow` WRITES the new columns while every READ stays legacy; that is the entire
 * reason a flip is a pure read-side change and a rollback is env+restart with no data surgery. A
 * window that widens at shadow reorders and re-sizes what `criticalSeen` consumes IN ORDER, so the
 * keyword dock moves at shadow — a seller-visible change from a flag that is supposed to be silent,
 * and one that a rollback to `off` would then move BACK. Every widening in this PR (this limit, the
 * getStoredAnalysis ORDER, the projection, the fingerprint inputs) is gated the same way.
 *
 * The cost is accepted and named: at shadow, thin/truncated pools can fail
 * `persistedIsComplete`'s saturation test, so `[KW_TARGET_SET].shaNext` is noisy there. Use
 * `[KW_SEL_CTX].ctxSha` agreement as the shadow oracle instead — it proves every site asked the
 * SAME question, which is the property that actually needs proving before the flip.
 *
 * NOTE this only fixes the SIZE half of the precondition. The ORDER half —
 * `.order('selection_rank', { ascending: true, nullsFirst: false })` as the PRIMARY key, gated
 * identically on `=== 'on'` — lives in getStoredAnalysis and must land in the same PR, or a caller
 * can hold rank 1 but not 2..N, pass BOTH contiguity and saturation, and ship a one-keyword target
 * set with a perfectly matching ctxSha.
 */
export function readWindow(legacyLimit: number): number {
  return selectionMode() === 'on' ? Math.max(legacyLimit, RANKING_CANDIDATE_POOL) : legacyLimit
}

/* ── DB LOADING ──────────────────────────────────────────────────────────────────────────────── */

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = any // any supabase client — same convention as loadListingContent.ts:25 / resolveAsin.ts:15

/** Every field is optional: pass what you already have, the loader queries only for the rest.
 *  `parentAsin: null` triggers a listing_content lookup; pass it when you know it (all seven sites
 *  do) so the loader costs one query less. */
export interface SelectionContextRequest {
  supabase: Db
  /** The ASIN keyword_analysis rows are keyed on — the coverage haystack is this child's own twins. */
  childAsin: string
  parentAsin?: string | null
  /** A pre-fetched listing_seo_scores row. THE CONTRACT: it must have been selected with BOTH
   *  design-name columns. A row missing either KEY is treated as NOT SUPPLIED and re-queried — see
   *  the structural check in `loadSelectionContextWithSources`, which exists because this contract
   *  was violated in prose for months (syncKeywordIntelligence selected 3 columns, not 4) and every
   *  field being optional made the violation invisible to tsc. */
  scoreRow?: { design_name_override?: string | null; design_name_overrides?: Record<string, string> | null; audience_lean?: string | null } | null
  /** Pre-computed coverage haystack (loadCoverageHaystack / rankAnalysis.buildHaystack output). */
  haystack?: string | null
  /** Pre-read listing_seo_recommendations.keyword_plan.designName. */
  planDesignName?: string | null
  /** Pre-read product_identity.identity_data. */
  visionDesign?: DesignSeasonSources['visionDesign']
  /** Log tag only. */
  site?: string
}

/**
 * Load whatever the caller did not supply, then assemble. EVERY read is independently try/caught and
 * degrades to the inert value for that ONE field — a missing product_identity row must not cost the
 * haystack, and a listing_seo_recommendations miss must not cost the design names.
 *
 * Worst case (nothing pre-supplied, parent unknown) is 5 index-covered reads. That is once per
 * storeAnalysis on the write path — negligible next to the rater's OpenAI call — and the two GET
 * surfaces (scorer, rank panel) already hold the score row and the haystack, so they pay 2.
 * No process-level memo: this runs in a warm Coolify process where a stale design name would
 * silently outlive a seller edit, and that is exactly the class of bug this module exists to end.
 */
export interface SelectionContextResult {
  ctx: SelectionContext
  /**
   * The FOUR design signals this loader resolved, returned so a SECOND consumer of the same design
   * identity does not have to re-derive them from a narrower set of sources.
   *
   * WHY THIS EXISTS (live defect, 2026-08-09). `buildThemeCard` sat EIGHT LINES below a
   * `loadSelectionContext` call and read one-and-a-half of these four (the scalar override plus a
   * per-design map its caller never selected), while the season derivation immediately above read
   * all four. A design whose name the seller never typed into that one box therefore produced NO
   * theme card, NO ratings, and a silently volume-ordered target set. Handing the resolved sources
   * back closes that asymmetry at ZERO extra queries — every one of these was already loaded.
   */
  sources: DesignSeasonSources
}

/** Thin wrapper — the ctx-only shape the seven existing call sites use. */
export async function loadSelectionContext(req: SelectionContextRequest): Promise<SelectionContext> {
  return (await loadSelectionContextWithSources(req)).ctx
}

export async function loadSelectionContextWithSources(req: SelectionContextRequest): Promise<SelectionContextResult> {
  // Doctrine 2: `off` is byte-identical AND makes zero network calls.
  if (selectionMode() === 'off') return { ctx: INERT_SELECTION_CONTEXT, sources: {} }

  const { supabase, childAsin } = req
  const tag = req.site ?? 'selection-context'

  // 1. Parent. listing_seo_scores / listing_seo_recommendations are BOTH keyed on parent_asin.
  //    .limit(1).maybeSingle() (never .single()): FBA+FBM twins share the ASIN and both carry the
  //    same parent_asin, so either row answers it — the resolveAsin.ts:22-25 / getParentAsin
  //    (syncKeywordIntelligence.ts:436-450) twin rule.
  let parentAsin = req.parentAsin ?? null
  if (!parentAsin) {
    try {
      const { data } = await supabase
        .from('listing_content').select('parent_asin').eq('asin', childAsin).limit(1).maybeSingle()
      parentAsin = (data as { parent_asin: string | null } | null)?.parent_asin ?? null
    } catch { /* unresolvable parent ⇒ design-name sources stay empty; vision still resolves on the child */ }
  }
  const scoreKey = parentAsin || childAsin

  // 2. Haystack — the child's OWN twins (title ∪ bullets ∪ description ∪ backend), Coherence
  //    Invariant 2. NOT the parent family, which over-credits sibling designs.
  let haystack = req.haystack ?? null
  if (haystack == null) {
    try { haystack = await loadCoverageHaystack(supabase, childAsin) } catch { haystack = '' }
  }

  // 3. Seller design names. NOTE the columns selected: design_name_override (031) and
  //    design_name_overrides (034) only — never a 049 column, so this select cannot error on a
  //    not-yet-migrated database (the themeRater.ts:515-519 precedent, avoided by construction).
  //    STRUCTURAL SUPPLY CHECK, not a truthiness check (the 2026-08-09 defect). `if (!scoreRow)`
  //    saw a truthy object and SKIPPED this query, so a caller that selected only
  //    `product_title, design_name_override, audience_lean` silently handed us
  //    `design_name_overrides: undefined` — and every multi-design family (scalar null, map
  //    populated, which is exactly what the per-design name UI writes) derived NO design names at
  //    all. Every field on the type is optional, so tsc could not see it. `in` asks the question
  //    that actually matters: was this column SELECTED? An explicit null answers yes; an absent key
  //    answers no, and we re-query rather than trust it.
  let scoreRow = req.scoreRow ?? null
  const scoreRowCarriesDesignNames = !!scoreRow
    && 'design_name_override' in scoreRow && 'design_name_overrides' in scoreRow
  if (!scoreRowCarriesDesignNames) {
    if (scoreRow) {
      console.warn(`[KW_SEL_CTX] site=${tag} asin=${childAsin} supplied scoreRow is MISSING a design-name column — re-querying (see SelectionContextRequest.scoreRow contract)`)
    }
    try {
      const { data } = await supabase
        .from('listing_seo_scores')
        .select('design_name_override, design_name_overrides, audience_lean')
        .eq('parent_asin', scoreKey)
        .maybeSingle()
      // Keep the caller's row as the fallback when the re-query finds nothing: a partial row still
      // carries audience_lean, and losing it would be a NEW degradation introduced by this heal.
      scoreRow = ((data as SelectionContextRequest['scoreRow']) ?? null) ?? scoreRow
    } catch { /* pre-034 or no score row ⇒ fall through to vision + plan name */ }
  }

  // 4. The RESOLVED design name — extractDesignName's output, persisted by the last regen. This is
  //    what closes the fourth source for every non-pipeline caller: without it a design whose name
  //    the LLM resolved (never typed by the seller, absent from vision) would derive [] here and a
  //    real season in the generator.
  let planDesignName = req.planDesignName ?? null
  if (planDesignName == null) {
    try {
      const { data } = await supabase
        .from('listing_seo_recommendations').select('keyword_plan').eq('parent_asin', scoreKey).maybeSingle()
      const kp = (data as { keyword_plan?: { designName?: string } | null } | null)?.keyword_plan
      planDesignName = typeof kp?.designName === 'string' ? kp.designName : null
    } catch { /* keyword_plan column absent pre-migration — same tolerance as syncListingContent.ts:641 */ }
  }

  // 5. Vision. product_identity is keyed on the ASIN THAT WAS SCANNED, and the two writers disagree:
  //    the regen route scans the PARENT (ai-recommendations/route.ts:701 scanProductImage(parent_asin))
  //    while keywordResearcher reads the research child (keywordResearcher.ts:1296-1302). Fetch both
  //    in ONE round trip and prefer the parent, matching the writer the generator actually uses.
  let visionDesign = req.visionDesign ?? null
  if (!visionDesign) {
    try {
      const wanted = [...new Set([parentAsin, childAsin].filter(Boolean) as string[])]
      const { data } = await supabase.from('product_identity').select('asin, identity_data').in('asin', wanted)
      const rows = (data ?? []) as { asin: string; identity_data?: DesignSeasonSources['visionDesign'] }[]
      const pick = rows.find((r) => r.asin === parentAsin) ?? rows.find((r) => r.asin === childAsin)
      visionDesign = pick?.identity_data ?? null
    } catch { /* product_identity may not exist for this asin — the historical tolerance */ }
  }

  // ONE resolved set of design signals, used for BOTH the seasons (here) and the theme card (the
  // caller's next line). Built once so the two can never read different sources again.
  const sources: DesignSeasonSources = {
    designNameOverride: scoreRow?.design_name_override ?? null,
    designNameOverridesByKey: scoreRow?.design_name_overrides ?? null,
    visionDesign,
    resolvedDesignName: planDesignName,
  }

  const ctx = buildSelectionContext({
    haystack,
    ...sources,
    audienceLean: scoreRow?.audience_lean ?? null,
  })

  // ONE structured line per build. This is the forensic that answers "why did this listing route its
  // own holiday to BACKEND?" without a repro — the four sources are named individually, so an empty
  // designSeasons is immediately attributable rather than mysterious.
  console.log(JSON.stringify({
    tag: 'KW_SEL_CTX',
    site: tag,
    inputAsin: childAsin,
    parentAsin,
    ctxSha: ctxSha(ctx),
    designSeasons: ctx.designSeasons,
    isApparel: ctx.isApparel,
    lean: ctx.lean ?? null,
    haystackLen: ctx.haystack.length,
    src: {
      override: Boolean(scoreRow?.design_name_override),
      overridesByKey: Object.keys(scoreRow?.design_name_overrides ?? {}).length,
      vision: Boolean(visionDesign?.designTheme),
      planName: Boolean(planDesignName),
    },
  }))

  return { ctx, sources }
}
