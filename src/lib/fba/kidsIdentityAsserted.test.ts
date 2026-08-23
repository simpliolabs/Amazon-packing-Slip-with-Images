/**
 * Pins for fix/kids-identity-asserted (PO-approved 2026-08-23, live B0DP5H8QBT: 12 blank-64000B
 * kids-tee children, `audience_lean='unisex'`). PR #642 cured the SUBTRACTIVE half of the
 * kids-audience defect (an adult clause like "for Men & Women" no longer survives on a kids_tee
 * family). A LATER regen on the #642 build still shipped:
 *
 *   THE CEO Don't Quit Motivational T-Shirt Graphic Tee Shirt | Short Sleeve   (72 chars, in band)
 *
 * — two residual defects, both whole-string properties no per-phrase gate can see:
 *
 *   DEFECT 1 — the kids identity is never ASSERTED. Removing the lie is not stating the truth: this
 *   title never says Kids/Youth/Boys/Girls, so a shopper reading it reasonably assumes an adult
 *   garment. `verdictForAssembledTitle` (titleBand.ts) now requires a kids family's title to
 *   POSITIVELY carry a youth marker; `youthMarkerFor` (contentTruth.ts) derives which one — 'Kids'
 *   for a unisex (or undeclared) lean, 'Girls'/'Boys' only for an explicitly gendered lean — from the
 *   BLANK-grounded ctx alone, never the title or the pool.
 *
 *   DEFECT 2 — "T-Shirt", "Tee" and "Shirt" all name the SAME garment in one segment.
 *   `titleHasDuplicateConcept` (titleBand.ts) already caught "Crewneck" + "Crew Neck" but could not
 *   see three GENUINELY DIFFERENT spellings of the same class; it now also runs
 *   `hasRedundantGarmentMention` (contentTruth.ts) PER SEGMENT, reusing the garment-noun vocabulary
 *   `phraseTruthVerdict`/`garmentGroupsIn` already share (no second table). `scrubMoneyPhrase`
 *   (contentTruth.ts) gained the matching SUBTRACTIVE repair for the money phrase (segment 0), so a
 *   title arriving with this defect shrinks back under band and the additive search below re-fills it
 *   — with the youth marker leading every other candidate.
 *
 * ONE SEAM: both fixes live in `contentTruth.ts`/`titleBand.ts`, the same shared truth+band door
 * `buildPhraseTruthCtx`/`enforceTitleTruthBand` already own — no third path, no new synonym table.
 *
 * Env vars nulled defensively (CI trap, `build.yml`'s placeholder Supabase env makes an eagerly-
 * instantiated lazy client attempt a real ~4s network call) — this file never calls a DB-touching
 * function, but every symbol it imports transitively imports `blankSpecs.ts`'s lazy client Proxy.
 */
process.env.NEXT_PUBLIC_SUPABASE_URL = ''
process.env.SUPABASE_SERVICE_ROLE_KEY = ''

import { describe, it, expect } from 'vitest'
import {
  enforceTitleTruthBand, verdictForAssembledTitle, titleHasDuplicateConcept, type TitleBandCtx,
} from './titleBand'
import {
  applyTitleTruthNet, phraseTruthVerdict, youthMarkerFor, titleAssertsYouthAudience,
  hasRedundantGarmentMention, type PhraseTruthCtx,
} from './contentTruth'

/* ── The B0DP5H8QBT family, as the resolver reports it (same shape as kidsAudienceCtxParity.test.ts's
 * KIDS_CTX, so the two files can never structurally drift about what this family's ctx looks like). */
const KIDS_CTX: PhraseTruthCtx = {
  garmentFamily: 'kids_tee',
  spec: { weightNote: 'midweight cotton' },
  allowedBrand: null,
  audience: 'kids',
  audienceLean: 'unisex',
  designTokens: ["Don't Quit"],
  field: 'title',
}

/** An adult tee family with the SAME garment vocabulary — the control group: no youth marker may
 *  ever appear, and the ONLY change permitted is the genuine duplicate-concept removal (defect 2 is
 *  not kids-specific — it is a real defect on any family). */
const ADULT_CTX: PhraseTruthCtx = {
  garmentFamily: 'tee',
  spec: { weightNote: 'midweight 6.1 oz garment-dyed' },
  allowedBrand: 'Comfort Colors',
  audience: 'adult',
  audienceLean: 'unisex',
  designTokens: ["Don't Quit"],
  field: 'title',
}

const LIVE = "THE CEO Don't Quit Motivational T-Shirt Graphic Tee Shirt | Short Sleeve"

/** A band ctx built the way the real pipeline builds one for this family: `truthOk` is the SAME
 *  spine predicate the terminal net judges with (`bandTruthOkFor` in listingPipeline.ts), never a
 *  stub — so a phrase this family may not truthfully say can never win the pad's search either. */
const bandFor = (truth: PhraseTruthCtx, pool: readonly string[]): TitleBandCtx => ({
  apparel: true,
  garmentBrand: null,
  spec: { fit: null, sleeve: 'Short Sleeve', neck: null },
  garmentSecond: null,
  factSegments: [],
  poolSegments: pool,
  truthOk: (s: string) => phraseTruthVerdict(s, truth).ok,
  youthMarker: youthMarkerFor(truth),
})

/* ── (i) the exact live specimen: gains a youth marker, loses the duplicate garment nouns ───────── */

describe('live specimen — B0DP5H8QBT, a LATER regen than #642 fixed (72 chars, in band, still defective)', () => {
  it('titleHasDuplicateConcept now catches "T-Shirt … Tee Shirt" (three spellings, one segment)', () => {
    expect(titleHasDuplicateConcept(LIVE)).toBe(true)
    // The window-flattening check this predicate already had is untouched — still catches the
    // ORIGINAL "Crewneck"/"Crew Neck" class of defect (regression guard for the pre-existing rule).
    expect(titleHasDuplicateConcept('THE CEO Fall Crewneck | Long Sleeve Crew Neck')).toBe(true)
    // …and still does NOT flag the PO's own sanctioned noun-x2 gold shape.
    expect(titleHasDuplicateConcept('THE CEO Alligator Tee Shirt | Comfort Colors TShirt for Women')).toBe(false)
  })

  it('regression sentinel: the string is NOT true against the kids ctx (whole-string verify)', () => {
    expect(verdictForAssembledTitle(LIVE, { truth: KIDS_CTX }).ok).toBe(false)
  })

  it('the SUBTRACTIVE repair collapses the redundant mention (keeps the FIRST, "T-Shirt") and stays under band', () => {
    const netted = applyTitleTruthNet(LIVE, KIDS_CTX)
    expect(netted).toBe("THE CEO Don't Quit Motivational T-Shirt Graphic | Short Sleeve")
    expect(titleHasDuplicateConcept(netted)).toBe(false)
    expect(netted.length).toBeLessThan(70)              // freed characters for the additive door below
    expect(applyTitleTruthNet(netted, KIDS_CTX)).toBe(netted)   // idempotent — nothing left to net
  })

  it('the FULL door (enforceTitleTruthBand) ships a title that is IN BAND, carries "Kids", and has no duplicate', () => {
    const band = bandFor(KIDS_CTX, ['Gift For Kids', 'Family Matching', 'Squad'])
    const r = enforceTitleTruthBand({ produced: LIVE, prior: null, apparel: true, band, truth: KIDS_CTX, protect: "Don't Quit" })
    expect(r.hold).toBe(false)
    expect(r.decision).toBe('refilled')
    expect(r.title.length).toBeGreaterThanOrEqual(70)
    expect(r.title.length).toBeLessThanOrEqual(75)
    expect(titleAssertsYouthAudience(r.title)).toBe(true)
    expect(r.title).toMatch(/\bKids\b/)
    expect(titleHasDuplicateConcept(r.title)).toBe(false)
    expect(verdictForAssembledTitle(r.title, { truth: KIDS_CTX })).toEqual({ ok: true })
    // Exactly ONE mention of the shirt/tee concept survives — never three.
    expect((r.title.match(/\b(?:t-?shirts?|tees?)\b/gi) ?? []).length).toBe(1)
  })
})

/* ── (ii) an ADULT family: no youth marker, ever — and the duplicate-noun fix still applies ─────── */

describe('an ADULT family is unaffected beyond the genuine duplicate-concept removal', () => {
  it('youthMarkerFor is null for a non-kids family — the band pad never gains a "Kids" candidate', () => {
    expect(youthMarkerFor(ADULT_CTX)).toBeNull()
  })

  it('the SAME duplicate-noun repair still applies (defect 2 is not kids-specific)', () => {
    const netted = applyTitleTruthNet(LIVE, ADULT_CTX)
    expect(netted).toBe("THE CEO Don't Quit Motivational T-Shirt Graphic | Short Sleeve")
  })

  it('the full door never inserts a youth word for this family', () => {
    const band = bandFor(ADULT_CTX, ['Cute Graphic', 'Family Matching', 'Squad'])
    const r = enforceTitleTruthBand({ produced: LIVE, prior: null, apparel: true, band, truth: ADULT_CTX, protect: "Don't Quit" })
    expect(titleAssertsYouthAudience(r.title)).toBe(false)
    expect(r.tried).not.toContain('Kids')
  })

  it('a title that never had the redundant-mention defect is BYTE-UNCHANGED end to end (no over-generalization)', () => {
    const clean = "THE CEO Don't Quit Motivational T-Shirt | Short Sleeve for Men and Women"
    const band = bandFor(ADULT_CTX, [])
    const r = enforceTitleTruthBand({ produced: clean, prior: null, apparel: true, band, truth: ADULT_CTX, protect: "Don't Quit" })
    expect(r.title).toBe(clean)
    expect(r.decision).toBe('in-band')
  })
})

/* ── (iii) youthMarkerFor — neutral for unisex, gendered ONLY when the lean says so ──────────────── */

describe('youthMarkerFor — derived from the blank ctx alone, never Boys/Girls on a unisex family', () => {
  it('unisex (this family) gets the neutral "Kids"', () => {
    expect(youthMarkerFor(KIDS_CTX)).toBe('Kids')
    expect(youthMarkerFor({ ...KIDS_CTX, audienceLean: null })).toBe('Kids')   // no declared lean, same neutral default
  })

  it('a declared "women" lean gets "Girls"; a declared "men" lean gets "Boys" — never on a unisex family', () => {
    expect(youthMarkerFor({ ...KIDS_CTX, audienceLean: 'women' })).toBe('Girls')
    expect(youthMarkerFor({ ...KIDS_CTX, audienceLean: 'men' })).toBe('Boys')
    expect(youthMarkerFor(KIDS_CTX)).not.toBe('Boys')
    expect(youthMarkerFor(KIDS_CTX)).not.toBe('Girls')
  })

  it('null for a non-kids audience and for no ctx at all', () => {
    expect(youthMarkerFor(ADULT_CTX)).toBeNull()
    expect(youthMarkerFor(null)).toBeNull()
    expect(youthMarkerFor(undefined)).toBeNull()
  })
})

/* ── (iv) the audience-adult-on-kids removal from #642 still works — no regression ───────────────── */

describe('#642 regression guard — an adult clause is still removed from a kids-family title', () => {
  const PRE_642_LIVE = "THE CEO Don't Quit Motivational T-Shirt for Men & Women | Short Sleeve"

  it('the adult-audience clause is still stripped as one unit', () => {
    const out = applyTitleTruthNet(PRE_642_LIVE, KIDS_CTX)
    expect(out).toBe("THE CEO Don't Quit Motivational T-Shirt | Short Sleeve")
    expect(out).not.toMatch(/\bfor\b/i)
    expect(out).not.toMatch(/&/)
  })

  it('the plain predicate still convicts the original phrase the same way', () => {
    expect(phraseTruthVerdict(PRE_642_LIVE, KIDS_CTX)).toEqual({ ok: false, reason: 'audience-adult-on-kids' })
  })
})

/* ── (v) the "Baby Shark" false-positive guard still holds — a design that OWNS an audience word ─── */

describe('design-token exemption is untouched — a design that OWNS an audience word keeps it', () => {
  const GIRL_DAD: PhraseTruthCtx = {
    garmentFamily: 'tee', spec: { weightNote: 'midweight 6.1 oz garment-dyed' }, allowedBrand: null,
    audience: 'adult', audienceLean: null, designTokens: ['Girl Dad'], field: 'title',
  }

  it('"for Girls" survives in segment 0 when the design owns the word', () => {
    const t = 'THE CEO Girl Dad Tee for Girls | Best Dad Ever'
    expect(applyTitleTruthNet(t, GIRL_DAD)).toBe(t)
  })

  it('my new redundant-garment-mention check does not confuse a design-owned audience word for a garment noun', () => {
    // "Girls"/"Dad" are not garment nouns at all — hasRedundantGarmentMention only ever matches
    // GARMENT_NOUN_RE, so an audience word can never trip it.
    expect(hasRedundantGarmentMention('Girl Dad Tee for Girls')).toBe(false)
  })

  it('an ADULT family never gains a youth marker even when its OWN design name contains a kids word', () => {
    // "Baby Shark" is the design's own name on an ADULT family — youthMarkerFor is gated on
    // ctx.audience === 'kids' alone, so it can never fire here regardless of design vocabulary.
    const BABY_SHARK: PhraseTruthCtx = { ...GIRL_DAD, designTokens: ['Baby Shark'] }
    expect(youthMarkerFor(BABY_SHARK)).toBeNull()
  })
})

/* ── unit coverage: hasRedundantGarmentMention — the shared predicate both defect-2 checks reuse ─── */

describe('hasRedundantGarmentMention — same garment vocabulary as garmentGroupsIn, no second table', () => {
  it('flags three spellings of the same class in one segment', () => {
    expect(hasRedundantGarmentMention('T-Shirt Graphic Tee Shirt')).toBe(true)
  })

  it('does not flag the compound "Tee Shirt" alone (adjacent = one mention)', () => {
    expect(hasRedundantGarmentMention('Alligator Tee Shirt')).toBe(false)
  })

  it('does not flag "Pullover … Crewneck" — different CLASSES, the PO\'s sanctioned variety, even though they fold to the same GROUP elsewhere', () => {
    expect(hasRedundantGarmentMention('Long Sleeve Pullover Fall Crewneck')).toBe(false)
  })

  it('does not flag a single mention', () => {
    expect(hasRedundantGarmentMention('Mother Hustler Sweatshirt')).toBe(false)
  })
})
