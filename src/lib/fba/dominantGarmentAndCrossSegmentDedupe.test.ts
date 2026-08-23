/**
 * dominantGarmentAndCrossSegmentDedupe.test.ts — focused pins for two related live title defects,
 * both measured on production 2026-08-23 06:34Z on build f1f26a6.
 *
 * DEFECT 1 (root cause: SCOPE). B0DSCDZC6K — 25 Gildan 18000 (sweatshirt) + 9 Gildan 18500 (hoodie)
 * + 1 stray Comfort Colors 6014 (long_sleeve_tee) children under one parent. Shipped:
 *   "THE CEO Motivational Entrepreneur | Long Sleeve Men Business Casual Hoodie"   (74)
 * "Hoodie" passed `verdictForAssembledTitle` because hoodie IS in the family's garment UNION
 * (`familyGarmentUnion`, 9/34 ≈ 26% ≥ GARMENT_UNION_DOMINANCE.minShare), but the BROADCAST/parent
 * title is answerable to every child and must therefore commit to the DOMINANT class alone
 * (sweatshirt, ~74%). The fix (listingPipeline.ts's `broadcastTruthCtx`/`broadcastGarmentFamilies`,
 * mirrored in truthBandHarness.ts's `broadcastCtx`/`broadcastUnion`) narrows `mixedFamilies` to the
 * dominant class ONLY on the broadcast exit; a genuine per-child hoodie exit is untouched — it
 * builds its OWN ctx from its OWN resolved blank (`buildGroupTruthCtx`/`perDesignTruthCtx`), which
 * never carried the family union restriction to begin with.
 *
 * DEFECT 2 (root cause: GRANULARITY). B0DP5H8QBT — 12 children, all Gildan 64000B (kids_tee).
 * Shipped:
 *   "THE CEO Don't Quit Motivational T-Shirt, Graphic Tees | Kids Toddler Tee"   (72)
 * PR #643's `hasRedundantGarmentMention` (inside `titleHasDuplicateConcept`) collapses a repeated
 * garment noun CLASS only WITHIN one comma/pipe-delimited segment; here "T-Shirt" and "Tees" sit in
 * different comma clauses on the SAME side of the ONE pipe, so the per-segment split hid the
 * redundancy from the gate entirely. The gate fix splits on `|` only (a comma inside one side is
 * ordinary coordination, not a second side the PO's noun-×2 shape is entitled to) — this ALONE makes
 * `hasRedundantGarmentMention` see both "T-Shirt" and "Tees" in one segment and flag it. But no
 * function in this file previously REPAIRED a duplicate-concept title (only `verdictForAssembledTitle`
 * GATED one) — so `collapseRedundantGarmentMention` (contentTruth.ts, wired into the tail of
 * `applyTitleTruthNet`, right after `enforceSingleGarmentClass`) actively drops the SECOND, redundant
 * mention's own comma-clause (not just the bare noun — "do not blindly delete the last if that leaves
 * a dangling fragment") on each pipe side independently.
 *
 * WHY THE REPAIRED KIDS TITLE STILL NAMES THE TEE CLASS TWICE (once per side), NOT ONCE TOTAL: the
 * PO's own sanctioned noun-×2 gold shape — "Tee Shirt | … TShirt", one mention on EACH side of the
 * ONE pipe — is pinned in `titleBand.test.ts` ("does NOT flag the golds' noun ×2 pattern") and
 * exercised end-to-end in `truthBandGate.test.ts`/`truthBandHarness.ts`. "Kids Toddler Tee" is
 * exactly that shape's post-pipe half; collapsing it too would fight an invariant this repo has
 * pinned and reverted-for before. The actual defect — TWO mentions crammed onto the SAME side
 * ("T-Shirt, Graphic Tees") — is what gets cured down to one; the result is 70-75-band-shaped
 * "noun … | … noun", not a single bare mention.
 */
import { describe, it, expect } from 'vitest'
import {
  applyTitleTruthNet, phraseTruthVerdict, audienceOfGarmentFamily, titleAssertsYouthAudience,
  type PhraseTruthCtx,
} from './contentTruth'
import { verdictForAssembledTitle, titleHasDuplicateConcept } from './titleBand'

const BASE = { spec: null, allowedBrand: null, designTokens: [], audienceLean: null, field: 'title' as const }

/* ── DEFECT 1 fixtures — B0DSCDZC6K, sweatshirt-dominant / hoodie-minority ───────────────────────── */

const LIVE_PARENT = 'THE CEO Motivational Entrepreneur | Long Sleeve Men Business Casual Hoodie'

/** The BROADCAST ctx after the fix: dominant class only, `mixedFamilies` omitted. */
const BROADCAST_CTX: PhraseTruthCtx = {
  ...BASE, garmentFamily: 'sweatshirt', mixedFamilies: undefined,
  audience: audienceOfGarmentFamily('sweatshirt'),
}
/** A genuine hoodie CHILD's own ctx — its own blank resolved to hoodie; no union needed. */
const CHILD_HOODIE_CTX: PhraseTruthCtx = {
  ...BASE, garmentFamily: 'hoodie', mixedFamilies: undefined,
  audience: audienceOfGarmentFamily('hoodie'),
}

describe('defect 1 — the BROADCAST/parent title commits to the DOMINANT class only', () => {
  it('"Hoodie" is UNTRUE for the broadcast (sweatshirt-dominant) ctx', () => {
    const v = phraseTruthVerdict('Hoodie', BROADCAST_CTX)
    expect(v.ok).toBe(false)
    expect(v.ok || v.reason).toBe('wrong-garment-noun')
  })

  it('applyTitleTruthNet strips "Hoodie" out of the live parent string on the broadcast ctx', () => {
    const cleaned = applyTitleTruthNet(LIVE_PARENT, BROADCAST_CTX, 'Motivational Entrepreneur')
    expect(cleaned.toLowerCase(), cleaned).not.toMatch(/\bhoodies?\b/)
  })

  it('verdictForAssembledTitle REFUSES to ship the live parent string as-is on the broadcast ctx', () => {
    const v = verdictForAssembledTitle(LIVE_PARENT, { truth: BROADCAST_CTX, protect: 'Motivational Entrepreneur' })
    expect(v.ok).toBe(false)
  })
})

describe('defect 1 — a PER-CHILD exit on a genuine hoodie child KEEPS "Hoodie"', () => {
  const CHILD_HOODIE_TITLE = 'THE CEO Mother Hustler Hoodie | Long Sleeve Hooded Sweatshirt Cozy Gift'

  it('"Hoodie" is TRUE on a hoodie child\'s own ctx', () => {
    expect(phraseTruthVerdict('Hoodie', CHILD_HOODIE_CTX).ok).toBe(true)
  })

  it('applyTitleTruthNet keeps "Hoodie" verbatim on a hoodie child\'s own ctx', () => {
    const cleaned = applyTitleTruthNet(CHILD_HOODIE_TITLE, CHILD_HOODIE_CTX, 'Mother Hustler')
    expect(cleaned).toContain('Hoodie')
  })

  it('verdictForAssembledTitle ACCEPTS the hoodie child\'s own title, unchanged', () => {
    const v = verdictForAssembledTitle(CHILD_HOODIE_TITLE, { truth: CHILD_HOODIE_CTX, protect: 'Mother Hustler' })
    expect(v.ok).toBe(true)
  })
})

/* ── DEFECT 2 fixtures — B0DP5H8QBT, kids_tee, all-64000B ───────────────────────────────────────── */

const LIVE_KIDS = "THE CEO Don't Quit Motivational T-Shirt, Graphic Tees | Kids Toddler Tee"
const KIDS_CTX: PhraseTruthCtx = {
  ...BASE, garmentFamily: 'kids_tee', mixedFamilies: undefined, audience: 'kids',
}

describe('defect 2 — a redundant same-class garment mention is collapsed, across the pipe', () => {
  it('the GATE: titleHasDuplicateConcept flags the raw live kids string', () => {
    expect(titleHasDuplicateConcept(LIVE_KIDS)).toBe(true)
  })

  it('applyTitleTruthNet cures the redundancy: the gate no longer flags the repaired string', () => {
    const cleaned = applyTitleTruthNet(LIVE_KIDS, KIDS_CTX, "Don't Quit")
    expect(titleHasDuplicateConcept(cleaned), cleaned).toBe(false)
  })

  it('the redundant SAME-SIDE clause ("Graphic Tees", the comma coordination) is gone; "T-Shirt" (the earlier, first mention) survives', () => {
    const cleaned = applyTitleTruthNet(LIVE_KIDS, KIDS_CTX, "Don't Quit")
    expect(cleaned).toContain('T-Shirt')
    expect(cleaned).not.toContain('Graphic Tees')
    expect(cleaned).not.toMatch(/,\s*\|/)   // no stray comma left dangling against the pipe
  })

  it('the repaired title still asserts Kids (PR #643 must survive untouched)', () => {
    const cleaned = applyTitleTruthNet(LIVE_KIDS, KIDS_CTX, "Don't Quit")
    expect(titleAssertsYouthAudience(cleaned), cleaned).toBe(true)
  })

  it('does NOT touch "Toddler" — no age ground truth exists yet to judge it (PO scope, out of bounds for this fix)', () => {
    const cleaned = applyTitleTruthNet(LIVE_KIDS, KIDS_CTX, "Don't Quit")
    expect(cleaned).toContain('Toddler')
  })

  it('the repaired title still names the garment class on EACH side of the pipe — the PO\'s pinned noun-×2 shape, not a single bare mention (see file header)', () => {
    const cleaned = applyTitleTruthNet(LIVE_KIDS, KIDS_CTX, "Don't Quit")
    const [before, after] = cleaned.split(/\s*\|\s*/)
    expect(before, cleaned).toMatch(/\bt-?shirts?\b/i)
    expect(after, cleaned).toMatch(/\btees?\b/i)
  })

  it('is idempotent — a second pass over the repaired string changes nothing further', () => {
    const once = applyTitleTruthNet(LIVE_KIDS, KIDS_CTX, "Don't Quit")
    const twice = applyTitleTruthNet(once, KIDS_CTX, "Don't Quit")
    expect(twice).toBe(once)
  })

  it('does NOT collapse the PO\'s own sanctioned noun-×2 gold ("Tee Shirt | … TShirt") on an adult ctx', () => {
    const GOLD = 'THE CEO Alligator Tee Shirt | Comfort Colors TShirt for Women'
    const ADULT_TEE_CTX: PhraseTruthCtx = { ...BASE, garmentFamily: 'tee', mixedFamilies: undefined, audience: 'adult', audienceLean: 'unisex' }
    expect(titleHasDuplicateConcept(GOLD)).toBe(false)
    const cleaned = applyTitleTruthNet(GOLD, ADULT_TEE_CTX, 'Alligator')
    // unchanged apart from the audience-lean net (unisex ctx strips a single-gender "for Women" tail
    // elsewhere in this file's own doctrine) — the garment-noun half must be byte-identical.
    expect(cleaned).toContain('Tee Shirt')
    expect(cleaned).toContain('TShirt')
  })
})

/* ── (iv) An adult, single-garment, healthy title is BYTE-UNCHANGED by both fixes ───────────────── */

describe('a healthy adult single-garment title is untouched by either fix', () => {
  const HEALTHY = 'THE CEO Business B*tch Sweatshirt | Long Sleeve Pullover Crewneck Gift'
  const ADULT_SWEATSHIRT_CTX: PhraseTruthCtx = {
    ...BASE, garmentFamily: 'sweatshirt', mixedFamilies: undefined, audience: 'adult',
  }

  it('applyTitleTruthNet returns it byte-identical', () => {
    expect(applyTitleTruthNet(HEALTHY, ADULT_SWEATSHIRT_CTX, 'Business B*tch')).toBe(HEALTHY)
  })

  it('verdictForAssembledTitle accepts it', () => {
    const v = verdictForAssembledTitle(HEALTHY, { truth: ADULT_SWEATSHIRT_CTX, protect: 'Business B*tch' })
    expect(v.ok).toBe(true)
  })
})

/* ── (v) PR #642's audience-adult-on-kids removal still works after both fixes ───────────────────── */

describe('PR #642 — an adult-audience claim on a kids family is still removed', () => {
  // The real #642 live specimen (kidsIdentityAsserted.test.ts's PRE_642_LIVE / kidsAudienceCtxParity
  // .test.ts's LIVE), reused verbatim rather than re-derived. `titleNetActsOn('audience-adult-on-kids',
  // ctx)` acts ONLY when `designTokens` is non-empty (kidsAudienceCtxParity.test.ts's own pin), so this
  // ctx needs a real design token — unlike the generic `KIDS_CTX` above, which never exercises this rule.
  const KIDS_CTX_WITH_DESIGN: PhraseTruthCtx = { ...KIDS_CTX, designTokens: ["Don't Quit"] }
  const LIVE = "THE CEO Don't Quit Motivational T-Shirt for Men & Women | Short Sleeve"

  it('phraseTruthVerdict still rejects the live adult-on-kids specimen', () => {
    expect(phraseTruthVerdict(LIVE, KIDS_CTX_WITH_DESIGN)).toEqual({ ok: false, reason: 'audience-adult-on-kids' })
  })

  it('applyTitleTruthNet still strips the adult clause "for Men & Women" as one unit', () => {
    // `applyTitleTruthNet` only ever SHORTENS (it does not itself add "Kids" back in — that is
    // `verdictForAssembledTitle`'s missing-youth-marker gate + the band pad's job, pinned separately
    // in truthBandGate.test.ts), so the expectation here is the exact #642 pin: the adult clause is
    // gone and nothing else changed — same output `kidsIdentityAsserted.test.ts` already pins.
    const cleaned = applyTitleTruthNet(LIVE, KIDS_CTX_WITH_DESIGN, "Don't Quit")
    expect(cleaned).toBe("THE CEO Don't Quit Motivational T-Shirt | Short Sleeve")
  })
})
