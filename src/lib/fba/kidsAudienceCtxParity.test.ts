/**
 * Pins for the kids-audience-on-title fix (PO-approved 2026-08-23, live B0DP5H8QBT: 12 children, ALL
 * blank 64000B — a Gildan KIDS tee, `garment_family='kids_tee'`, source `family-assignment`,
 * `audience_lean='unisex'`). A regen shipped:
 *
 *   THE CEO Don't Quit Motivational T-Shirt for Men & Women | Short Sleeve
 *
 * — adult-audience wording on a KIDS garment. `audience-adult-on-kids` already convicted this on the
 * READ path (`lockedTitleTruth.ts`, via `phraseTruthVerdict` directly) but stayed silent during
 * GENERATION. THREE layers, all pinned here:
 *
 *   (A) ONE ctx builder — `buildPhraseTruthCtx`, called by BOTH `listingPipeline.ts`'s `truthCtxFor`
 *       and `lockedTitleTruth.ts`'s `resolveLockedTitleTruthCtx`, so the two paths can never
 *       structurally disagree about ctx shape again (they already had: `designTokens: []` hardcoded
 *       on the read path vs the real family names on generation).
 *   (B) `titleNetActsOn` — makes the `TITLE_NET_REASONS` allowlist's own stated precondition (an
 *       UNRESOLVED design name is a false-positive factory) executable instead of just documented.
 *   (C) `scrubMoneyPhrase` (contentTruth.ts) gained a kids/adult AUDIENCE branch for SEGMENT 0 — the
 *       `$`-anchored `AUDIENCE_TAIL_RE` only ever caught a tail at the very end of the string, and the
 *       live title's lie sat BEFORE the first `|`, where nothing was judging it.
 *   (D) `preferredAudience` (listingPipeline.ts) no longer resolves an adult audience string for a
 *       family the blank truth says is KIDS — the two brief-building sites that defaulted a falsy
 *       audience into the literal 'Men and Women' now respect that same verdict.
 *
 * Env vars nulled defensively (CI trap, `build.yml`'s placeholder Supabase env makes an eagerly-
 * instantiated lazy client attempt a real ~4s network call) — this file never calls a DB-touching
 * function, but every symbol it imports transitively imports `blankSpecs.ts`'s lazy client Proxy.
 */
process.env.NEXT_PUBLIC_SUPABASE_URL = ''
process.env.SUPABASE_SERVICE_ROLE_KEY = ''

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  phraseTruthVerdict,
  applyTitleTruthNet,
  audienceOfGarmentFamily,
  titleNetActsOn,
  buildPhraseTruthCtx,
  type PhraseTruthCtx,
  type PhraseTruthFacts,
  type PhraseTruthReason,
} from './contentTruth'
import { verdictForAssembledTitle } from './titleBand'

/* ── The B0DP5H8QBT family, as the resolver reports it ─────────────────────────────────────────── */

const KIDS_CTX: PhraseTruthCtx = {
  garmentFamily: 'kids_tee',
  spec: { weightNote: 'midweight cotton' },
  allowedBrand: null,
  audience: audienceOfGarmentFamily('kids_tee'),
  audienceLean: 'unisex',
  // The live family's design DID resolve — "Don't Quit" is quoted verbatim in the defective title
  // itself. A NON-empty designTokens is also the TITLE net's own precondition for acting on an
  // audience-adult-on-kids reason (`titleNetActsOn`) — see the "unresolved name" describe block
  // below for the complementary case where this is deliberately empty.
  designTokens: ["Don't Quit"],
  field: 'title',
}

/** An adult tee family with the SAME unisex lean — the control group: nothing here may change. */
const ADULT_UNISEX_CTX: PhraseTruthCtx = {
  garmentFamily: 'tee',
  spec: { weightNote: 'midweight 6.1 oz garment-dyed' },
  allowedBrand: 'Comfort Colors',
  audience: audienceOfGarmentFamily('tee'),
  audienceLean: 'unisex',
  field: 'title',
}

/* ── (i) the exact live specimen ────────────────────────────────────────────────────────────────── */

describe('live specimen — B0DP5H8QBT (12 kids-tee children, unisex lean)', () => {
  const LIVE = "THE CEO Don't Quit Motivational T-Shirt for Men & Women | Short Sleeve"

  it('regression sentinel: the ORIGINAL live string is NOT true against the kids ctx', () => {
    expect(verdictForAssembledTitle(LIVE, { truth: KIDS_CTX }).ok).toBe(false)
  })

  it('the net removes the adult-audience CLAUSE as one unit — no dangling "for" or "&"', () => {
    const out = applyTitleTruthNet(LIVE, KIDS_CTX)
    expect(out).toBe("THE CEO Don't Quit Motivational T-Shirt | Short Sleeve")
    expect(out).not.toMatch(/\bfor\b/i)
    expect(out).not.toMatch(/&/)
    expect(out).not.toMatch(/\s{2,}/)          // no double space left behind
  })

  it('what remains no longer carries a LIE, but is still INCOMPLETE — no youth marker asserted (fix/kids-identity-asserted, PO 2026-08-23)', () => {
    // #642 (this file, pre-existing) cured the SUBTRACTIVE half: the adult clause is gone, so the net
    // is idempotent on it (nothing left for `applyTitleTruthNet` to touch — no lie survives). But
    // "removed the lie" is not "stated the truth": this string never says Kids/Youth/Boys/Girls, so a
    // shopper reading it reasonably assumes an adult garment. `verdictForAssembledTitle` now requires
    // a kids family's title to POSITIVELY assert its audience, closing that gap.
    const out = applyTitleTruthNet(LIVE, KIDS_CTX)
    expect(applyTitleTruthNet(out, KIDS_CTX)).toBe(out)   // still idempotent — nothing left to NET
    expect(verdictForAssembledTitle(out, { truth: KIDS_CTX })).toEqual({ ok: false, reason: 'missing-youth-marker' })
  })

  it('once the marker is present, the SAME string is fully true', () => {
    const out = applyTitleTruthNet(LIVE, KIDS_CTX)
    expect(verdictForAssembledTitle(`${out} Kids`, { truth: KIDS_CTX })).toEqual({ ok: true })
  })

  it('the segment-0 phrase itself now fails the plain predicate, matching the READ path finding', () => {
    // This is the exact convict `lockedTitleViolations` already reported on this family — generation
    // is now asking the SAME question of the SAME phrase, not a different one.
    expect(phraseTruthVerdict(LIVE, KIDS_CTX)).toEqual({ ok: false, reason: 'audience-adult-on-kids' })
  })
})

/* ── the false-positive-factory guard: an UNRESOLVED design name is never over-stripped ─────────── */

describe('segment-0 audience scrub is gated by titleNetActsOn — an unresolved name is not a lie', () => {
  /** An ADULT family (kids words are the foreign vocabulary here) with NO resolved design name —
   *  the exact shape of the PRE-EXISTING pin `contentTruthSpine.test.ts`'s "DELIBERATELY leaves
   *  kids/adult words alone" test guards on the segment-sweep half of the net; this is its segment-0
   *  twin, and an early version of this fix broke that pin by skipping this gate. */
  const ADULT_UNRESOLVED: PhraseTruthCtx = {
    garmentFamily: 'sweatshirt',
    spec: { weightNote: 'heavyweight 8.0 oz fleece' },
    allowedBrand: null,
    audience: 'adult',
    audienceLean: null,
    field: 'title',
    // designTokens deliberately absent — mirrors every caller before the family's design resolves.
  }

  it('leaves "Baby Shark" alone in segment 0 when no design name resolved (regression control)', () => {
    const t = 'THE CEO Baby Shark Sweatshirt | Fall Crewneck'
    expect(applyTitleTruthNet(t, ADULT_UNRESOLVED)).toBe(t)
  })

  it('the SAME phrase, with the name resolved, still keeps its own word but drops a foreign one', () => {
    const resolved: PhraseTruthCtx = { ...ADULT_UNRESOLVED, designTokens: ['Baby Shark'] }
    const t = 'THE CEO Baby Shark Sweatshirt for Toddlers | Fall Crewneck'
    const out = applyTitleTruthNet(t, resolved)
    expect(out).not.toMatch(/toddler/i)
    expect(out).toContain('Baby Shark')
  })
})

/* ── (ii) an adult unisex family is UNAFFECTED — no over-generalization ────────────────────────── */

describe('adult unisex family — "for Men & Women" is a TRUE inclusive tail, never stripped', () => {
  const LIVE = "THE CEO Don't Quit Motivational T-Shirt for Men & Women | Short Sleeve"

  it('applyTitleTruthNet is a byte-identical no-op', () => {
    expect(applyTitleTruthNet(LIVE, ADULT_UNISEX_CTX)).toBe(LIVE)
  })

  it('the plain predicate agrees: this title is TRUE for an adult unisex family', () => {
    expect(phraseTruthVerdict(LIVE, ADULT_UNISEX_CTX)).toEqual({ ok: true })
  })

  it('a single declared gender is still forced-gender-rejected (rule (c2) is untouched)', () => {
    const single = "THE CEO Don't Quit Motivational T-Shirt for Women | Short Sleeve"
    expect(applyTitleTruthNet(single, ADULT_UNISEX_CTX)).toBe("THE CEO Don't Quit Motivational T-Shirt | Short Sleeve")
  })
})

/* ── (iii) a design that OWNS an audience word keeps it ─────────────────────────────────────────── */

describe('design-token exemption reaches segment 0 too — "Girl Dad" / "Boys Trip" keep their word', () => {
  const GIRL_DAD: PhraseTruthCtx = {
    garmentFamily: 'tee',
    spec: { weightNote: 'midweight 6.1 oz garment-dyed' },
    allowedBrand: null,
    audience: 'adult',
    audienceLean: null,
    designTokens: ['Girl Dad'],
    field: 'title',
  }

  it('keeps "for Girls" in segment 0 when the design owns the word', () => {
    const t = 'THE CEO Girl Dad Tee for Girls | Best Dad Ever'
    expect(applyTitleTruthNet(t, GIRL_DAD)).toBe(t)
  })

  it('a design named "Boys Trip" keeps "Boys" in segment 0', () => {
    const BOYS_TRIP: PhraseTruthCtx = { ...GIRL_DAD, designTokens: ['Boys Trip'] }
    const t = 'THE CEO Boys Trip Tee for the Boys | Weekend Getaway'
    expect(applyTitleTruthNet(t, BOYS_TRIP)).toBe(t)
  })

  it('a DIFFERENT resolved design (not owning "girls") still loses the clause — the exemption is per-word, not per-resolved-name', () => {
    const t = 'THE CEO Weekend Vibes Tee for Girls | Best Dad Ever'
    const out = applyTitleTruthNet(t, { ...GIRL_DAD, designTokens: ['Weekend Vibes'] })
    expect(out).toBe('THE CEO Weekend Vibes Tee | Best Dad Ever')
  })

  it('an UNRESOLVED name (empty designTokens) leaves segment 0 alone — the false-positive-factory guard', () => {
    // titleNetActsOn gates this branch exactly like the tail/segment-sweep act-points: no resolved
    // name ⇒ no action, so a genuinely unresolved family is never turned into a false-positive
    // factory at the word level either (see the dedicated describe block above for the full case).
    const t = 'THE CEO Girl Dad Tee for Girls | Best Dad Ever'
    const out = applyTitleTruthNet(t, { ...GIRL_DAD, designTokens: [] })
    expect(out).toBe(t)
  })

  it('a foreign kids word ALONGSIDE the owned one still dies — one hit is enough (matches rule (c))', () => {
    const t = 'THE CEO Girl Dad Tee for Girls and Toddlers | Best Dad Ever'
    const out = applyTitleTruthNet(t, GIRL_DAD)
    expect(out).not.toMatch(/toddler/i)
  })
})

/* ── (iv) both ctx builders now return identical ctx for the same facts ────────────────────────── */

describe('buildPhraseTruthCtx — ONE builder, structurally impossible to drift again', () => {
  const facts: PhraseTruthFacts = {
    garmentFamily: 'kids_tee',
    mixedFamilies: ['kids_tee'],
    spec: { weightNote: 'midweight cotton' },
    allowedBrand: null,
    designTokens: ["Don't Quit"],
    audienceLean: 'unisex',
  }

  it('is pure and deterministic for the same facts', () => {
    expect(buildPhraseTruthCtx(facts, 'title')).toEqual(buildPhraseTruthCtx({ ...facts }, 'title'))
  })

  it('assembles every field exactly as the two call sites used to by hand', () => {
    expect(buildPhraseTruthCtx(facts, 'title')).toEqual({
      garmentFamily: 'kids_tee',
      mixedFamilies: undefined,          // a length-1 union collapses, same as every prior caller
      spec: facts.spec,
      allowedBrand: null,
      audience: 'kids',
      designTokens: ["Don't Quit"],
      audienceLean: 'unisex',
      field: 'title',
    })
  })

  it('collapses mixedFamilies only when >1 (mixed-blank family survives as a union)', () => {
    const mixed = buildPhraseTruthCtx({ ...facts, mixedFamilies: ['kids_tee', 'tee'] }, 'title')
    expect(mixed?.mixedFamilies).toEqual(['kids_tee', 'tee'])
  })

  it('a null/undefined garmentFamily fails open, same doctrine as every blank-truth site', () => {
    expect(buildPhraseTruthCtx({ ...facts, garmentFamily: null }, 'title')).toBeNull()
    expect(buildPhraseTruthCtx({ ...facts, garmentFamily: undefined }, 'bullets')).toBeNull()
  })

  it('an unpopulated designTokens still builds a valid ctx (the read-path shape, no new resolver)', () => {
    const ctx = buildPhraseTruthCtx({ ...facts, designTokens: [] }, 'title')
    expect(ctx?.designTokens).toEqual([])
  })

  it('source pin: BOTH listingPipeline.ts and lockedTitleTruth.ts build the ctx through this ONE function', () => {
    const pipelineSrc = readFileSync(join(process.cwd(), 'src', 'lib', 'fba', 'listingPipeline.ts'), 'utf8')
    const lockedSrc = readFileSync(join(process.cwd(), 'src', 'lib', 'fba', 'lockedTitleTruth.ts'), 'utf8')

    const at1 = pipelineSrc.indexOf('const truthCtxFor = ')
    expect(at1, 'truthCtxFor not found').toBeGreaterThan(0)
    expect(pipelineSrc.slice(at1, at1 + 400)).toContain('buildPhraseTruthCtx(')

    const at2 = lockedSrc.indexOf('export async function resolveLockedTitleTruthCtx')
    expect(at2, 'resolveLockedTitleTruthCtx not found').toBeGreaterThan(0)
    const lockedBody = lockedSrc.slice(at2, at2 + 2500)
    expect(lockedBody).toContain('buildPhraseTruthCtx(')
    // No hand-built object literal ctx survives at this seam — the whole point of the extraction.
    expect(lockedBody).not.toContain('const ctx: PhraseTruthCtx = {')
  })
})

/* ── (B) titleNetActsOn — the allowlist's own precondition is now executable ───────────────────── */

describe('titleNetActsOn — audience-adult/kids-on-adult act on the TITLE net only when the name resolved', () => {
  it('always acts on the original TITLE_NET_REASONS set, ctx notwithstanding', () => {
    for (const r of ['wrong-garment-noun', 'garment-vocab-on-non-apparel', 'audience-lean-lie'] as PhraseTruthReason[])
      expect(titleNetActsOn(r, { ...KIDS_CTX, designTokens: [] })).toBe(true)
  })
  it('audience-adult-on-kids acts ONLY when designTokens is non-empty', () => {
    expect(titleNetActsOn('audience-adult-on-kids', { ...KIDS_CTX, designTokens: [] })).toBe(false)
    expect(titleNetActsOn('audience-adult-on-kids', { ...KIDS_CTX, designTokens: undefined })).toBe(false)
    expect(titleNetActsOn('audience-adult-on-kids', { ...KIDS_CTX, designTokens: ["Don't Quit"] })).toBe(true)
  })
  it('same gate for the symmetric audience-kids-on-adult reason', () => {
    expect(titleNetActsOn('audience-kids-on-adult', { ...ADULT_UNISEX_CTX, designTokens: [] })).toBe(false)
    expect(titleNetActsOn('audience-kids-on-adult', { ...ADULT_UNISEX_CTX, designTokens: ['x'] })).toBe(true)
  })
  it('never acts on any other reason, regardless of designTokens', () => {
    for (const r of ['capability-claim', 'competitor-brand', 'weight-class-lie'] as PhraseTruthReason[])
      expect(titleNetActsOn(r, { ...KIDS_CTX, designTokens: ['x'] })).toBe(false)
  })
})

/* ── (D) preferredAudience never defaults a KIDS family into the adult tail ─────────────────────── */

describe('preferredAudience — a KIDS family never resolves an adult audience string (source pins)', () => {
  const src = readFileSync(join(process.cwd(), 'src', 'lib', 'fba', 'listingPipeline.ts'), 'utf8')

  it('preferredAudience is re-gated once the blank truth resolves', () => {
    expect(src).toContain("if (audienceOfGarmentFamily(truthGarmentFamily) === 'kids') preferredAudience = ''")
  })
  it('the gate runs AFTER truthGarmentFamily is computed and BEFORE either title producer is called', () => {
    const gateAt = src.indexOf("if (audienceOfGarmentFamily(truthGarmentFamily) === 'kids') preferredAudience = ''")
    const famAt = src.indexOf('const truthGarmentFamily: TruthGarmentFamily')
    const firstCallAt = src.indexOf('await buildTitleFor(')
    expect(gateAt).toBeGreaterThan(famAt)
    expect(gateAt).toBeLessThan(firstCallAt)
  })
  it('both the single-design humanizer and the broadcast/parent producer respect the same verdict', () => {
    const occurrences = src.match(/const aud = truth\?\.audience === 'kids' \? '' : \(preferredAudience \|\| 'Men and Women'\)/g) ?? []
    expect(occurrences.length).toBe(2)
    // No remaining unconditional fallback survives anywhere in the file.
    expect((src.match(/const aud = preferredAudience \|\| 'Men and Women'/g) ?? []).length).toBe(0)
  })
})
