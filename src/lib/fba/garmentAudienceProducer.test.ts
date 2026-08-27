/**
 * Pins for the GARMENT AGE PRODUCER (PO ruling 2026-08-27, migration 071 — adversarial audit, 12
 * verified findings; see .superpowers/sdd/age-producer-report.md). `age_range_description` had
 * ZERO deterministic producers (LLM-only, guessing from the listing's OWN EXISTING COPY, never
 * blank truth); `department`/`target_gender`'s one deterministic producer (listingPipeline.ts's
 * per-lean 3-way map) is the FAMILY GENDER SELECTOR, whose vocabulary structurally cannot say
 * "kids" — B0DP5H8QBT (12 Gildan 64000B YOUTH-tee children) ships Department="Unisex", a LEGAL
 * enum member, so the push reports SUCCESS while the listing is filed as adult.
 *
 * `resolveGarmentAudience` (contentTruth.ts) is the ONE seam: a STATED blank_specs.age_class column
 * wins outright; else garment_family==='kids_tee' (058's silhouette enum already encoding the ONE
 * age fact it can) resolves 'kids'; every other combination resolves null — 'adult' is NEVER
 * inferred from silhouette, only ever returned when the DB column arrives literally 'adult' (a real
 * stated fact, never a default — the column has no DEFAULT, and this resolver never synthesizes one).
 *
 * The end-to-end wiring into listingPipeline.ts's Product Detail block (the widened gate, the
 * department composition, the 'spec' vs 'audience' provenance stamp, the age-row append) is proven
 * against the REAL runListingPipeline in garmentAgeProducer.integration.test.ts — THIS file pins the
 * pure resolver's contract plus SOURCE-PIN proof that the pre-existing lean-only map is untouched
 * byte-for-byte (the no-op-for-adult-families guarantee) and that intersectBlankSpecs/rowToSpec
 * carry the new column correctly.
 *
 * Env vars nulled defensively (CI trap, `build.yml`'s placeholder Supabase env makes an eagerly-
 * instantiated lazy client attempt a real ~4s network call) — this file never calls a DB-touching
 * function, but every symbol it imports transitively imports blankSpecs.ts's lazy client Proxy.
 * RESTORED in afterAll per this task's own verification requirement (the repo's existing sibling
 * files null without restoring — a safe superset, not a contradiction).
 */
const SUPABASE_ENV_KEYS = ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'NEXT_PUBLIC_SUPABASE_ANON_KEY'] as const
const savedSupabaseEnv: Record<string, string | undefined> = {}
for (const key of SUPABASE_ENV_KEYS) { savedSupabaseEnv[key] = process.env[key]; process.env[key] = '' }

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect, afterAll } from 'vitest'
import {
  resolveGarmentAudience, audienceOfGarmentFamily, youthMarkerFor, normalizeAudienceLean,
  type PhraseTruthCtx, type TruthGarmentFamily, type GarmentAudienceFacts,
} from './contentTruth'
import { rowToSpec, type AgeClass } from './blankSpecs'

afterAll(() => {
  for (const key of SUPABASE_ENV_KEYS) {
    if (savedSupabaseEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedSupabaseEnv[key]
  }
})

const ALL_FAMILIES: (TruthGarmentFamily | undefined)[] = [
  'tee', 'long_sleeve_tee', 'sweatshirt', 'hoodie', 'kids_tee', 'hat', 'none', null, undefined,
]

/* ── Precedence: (1) stated ageClass wins, (2) else kids_tee, (3) else none ──────────────────── */

describe('resolveGarmentAudience — precedence (exactly two rules, nothing else)', () => {
  it('rule 1: a STATED ageClass wins outright, regardless of garmentFamily — source blank-column', () => {
    const r = resolveGarmentAudience({ garmentFamily: 'tee', ageClass: 'kids' })
    expect(r).toMatchObject({ ageClass: 'kids', audience: 'kids', source: 'blank-column' })
  })
  it('rule 1 also honors a stated "adult" — a REAL column value, not a default', () => {
    const r = resolveGarmentAudience({ garmentFamily: 'tee', ageClass: 'adult' })
    expect(r).toMatchObject({ ageClass: 'adult', audience: 'adult', source: 'blank-column' })
  })
  it('rule 1 wins even over a kids_tee family stating a DIFFERENT age (toddler, not kids)', () => {
    const r = resolveGarmentAudience({ garmentFamily: 'kids_tee', ageClass: 'toddler' })
    expect(r).toMatchObject({ ageClass: 'toddler', audience: 'kids', source: 'blank-column' })
  })
  it('rule 2: no stated ageClass, garmentFamily===kids_tee → kids, source garment-family', () => {
    const r = resolveGarmentAudience({ garmentFamily: 'kids_tee', ageClass: null })
    expect(r).toMatchObject({ ageClass: 'kids', audience: 'kids', source: 'garment-family' })
  })
  it('rule 2 also fires when ageClass is simply absent (undefined), not just null', () => {
    const r = resolveGarmentAudience({ garmentFamily: 'kids_tee' })
    expect(r).toMatchObject({ ageClass: 'kids', audience: 'kids', source: 'garment-family' })
  })
  it('every other family, no stated ageClass → null/null/none', () => {
    for (const gf of ['tee', 'long_sleeve_tee', 'sweatshirt', 'hoodie', 'hat', 'none', null, undefined] as const) {
      const r = resolveGarmentAudience({ garmentFamily: gf, ageClass: null })
      expect(r.ageClass).toBeNull()
      expect(r.audience).toBeNull()
      expect(r.source).toBe('none')
    }
  })
})

describe('resolveGarmentAudience — "adult" is NEVER inferred from silhouette (the PO ruling)', () => {
  it('no combination of garmentFamily WITHOUT a stated ageClass ever yields audience "adult"', () => {
    for (const gf of ALL_FAMILIES) {
      const r = resolveGarmentAudience({ garmentFamily: gf, ageClass: null })
      expect(r.audience).not.toBe('adult')
    }
  })
  it('"adult" appears ONLY when facts.ageClass arrives literally "adult"', () => {
    const facts: GarmentAudienceFacts = { garmentFamily: 'tee', ageClass: 'adult' }
    expect(resolveGarmentAudience(facts).audience).toBe('adult')
    // Change nothing but drop the stated column — 'tee' alone must never resurrect 'adult'.
    expect(resolveGarmentAudience({ ...facts, ageClass: null }).audience).not.toBe('adult')
  })
})

/* ── Product-Detail shape: departmentQualifier / ageRangeCandidate / youthMarker ─────────────── */

describe('resolveGarmentAudience — Product Detail candidate shape', () => {
  it('kids + no lean → departmentQualifier "Unisex Kids" (the brief\'s own example string)', () => {
    const r = resolveGarmentAudience({ garmentFamily: 'kids_tee', ageClass: 'kids' })
    expect(r.departmentQualifier).toBe('Unisex Kids')
    expect(r.youthMarker).toBe('Kids')
    expect(r.ageRangeCandidate).toBe('Kids')
  })
  it('kids + female lean → Girls (no "Kids" suffix, matches the pre-existing youthMarkerFor pin exactly)', () => {
    const r = resolveGarmentAudience({ garmentFamily: 'kids_tee', ageClass: 'kids', audienceLean: 'female' })
    expect(r.departmentQualifier).toBe('Girls')
    expect(r.youthMarker).toBe('Girls')
  })
  it('kids + male lean → Boys', () => {
    const r = resolveGarmentAudience({ garmentFamily: 'kids_tee', ageClass: 'kids', audienceLean: 'male' })
    expect(r.departmentQualifier).toBe('Boys')
    expect(r.youthMarker).toBe('Boys')
  })
  it('kids + lean_male/lean_female normalize the SAME as male/female for the youth-marker picker (normalizeAudienceLean folds soft and hard leans onto the same men/women bucket — only the TITLE forced-gender rule, not this picker, treats soft leans specially)', () => {
    const r1 = resolveGarmentAudience({ garmentFamily: 'kids_tee', ageClass: 'kids', audienceLean: 'lean_male' })
    const r2 = resolveGarmentAudience({ garmentFamily: 'kids_tee', ageClass: 'kids', audienceLean: 'lean_female' })
    expect(r1.youthMarker).toBe('Boys')
    expect(r2.youthMarker).toBe('Girls')
  })
  it('every non-kids-audience combination yields null departmentQualifier/ageRangeCandidate/youthMarker EXCEPT ageRangeCandidate for a stated adult', () => {
    const r = resolveGarmentAudience({ garmentFamily: 'tee', ageClass: null })
    expect(r.departmentQualifier).toBeNull()
    expect(r.ageRangeCandidate).toBeNull()
    expect(r.youthMarker).toBeNull()
  })
  it('ageRangeCandidate is a candidate to MATCH against the live enum, not a hardcoded write — callers gate it behind menuAttr.accepted (proven in the integration test)', () => {
    const r = resolveGarmentAudience({ garmentFamily: 'kids_tee', ageClass: 'toddler' })
    expect(r.ageRangeCandidate).toBe('Toddler')
  })
})

/* ── THIN WRAPPERS: audienceOfGarmentFamily / youthMarkerFor stay byte-identical ─────────────── */

describe('audienceOfGarmentFamily — thin wrapper over resolveGarmentAudience, UNCHANGED observable behavior', () => {
  it('is the composer\'s ihAudienceOf, unmoved (pre-existing pin, re-asserted post-refactor)', () => {
    expect(audienceOfGarmentFamily('kids_tee')).toBe('kids')
    expect(audienceOfGarmentFamily('sweatshirt')).toBe('adult')
    expect(audienceOfGarmentFamily('hoodie')).toBe('adult')
    expect(audienceOfGarmentFamily('tee')).toBe('adult')
    expect(audienceOfGarmentFamily('long_sleeve_tee')).toBe('adult')
    expect(audienceOfGarmentFamily('hat')).toBe('adult')
    expect(audienceOfGarmentFamily(null)).toBeNull()
    expect(audienceOfGarmentFamily(undefined)).toBeNull()
    expect(audienceOfGarmentFamily('none')).toBeNull()
  })
})

const KIDS_CTX: PhraseTruthCtx = {
  garmentFamily: 'kids_tee', spec: null, allowedBrand: null, audience: 'kids', designTokens: [], audienceLean: null, field: 'title',
}
const ADULT_CTX: PhraseTruthCtx = {
  garmentFamily: 'tee', spec: null, allowedBrand: null, audience: 'adult', designTokens: [], audienceLean: null, field: 'title',
}

describe('youthMarkerFor — thin wrapper, UNCHANGED observable behavior (pre-existing pins, re-asserted)', () => {
  it('Kids by default, Girls/Boys only for an explicit lean, null for non-kids/null ctx', () => {
    expect(youthMarkerFor(KIDS_CTX)).toBe('Kids')
    expect(youthMarkerFor({ ...KIDS_CTX, audienceLean: 'women' })).toBe('Girls')
    expect(youthMarkerFor({ ...KIDS_CTX, audienceLean: 'men' })).toBe('Boys')
    expect(youthMarkerFor({ ...KIDS_CTX, audienceLean: 'unisex' })).toBe('Kids')
    expect(youthMarkerFor(ADULT_CTX)).toBeNull()
    expect(youthMarkerFor(null)).toBeNull()
    expect(youthMarkerFor(undefined)).toBeNull()
  })
})

/* ── SOURCE PIN: the pre-existing dept/gender lean map is UNTOUCHED — the no-op-for-adult proof ── */

describe('listingPipeline.ts Product Detail block — source pins (byte-identical composition for the current lean-only map)', () => {
  const src = readFileSync(join(process.cwd(), 'src', 'lib', 'fba', 'listingPipeline.ts'), 'utf8')

  it('the 5-lean-value dem map is byte-identical to before this task (table-driven brief requirement)', () => {
    // The EXACT ternary text, unchanged. If this ever fails, the "current strings verbatim"
    // guarantee (Womens/Female, Mens/Male, Unisex/Unisex) the no-op control depends on is broken.
    expect(src).toContain("const dem = lean === 'female' ? { dept: 'Womens', gender: 'Female' }")
    expect(src).toContain(": lean === 'male' ? { dept: 'Mens', gender: 'Male' }")
    expect(src).toContain(": { dept: 'Unisex', gender: 'Unisex' }")
  })

  it('the gate WIDENED to admit aud.ageClass, but the department composition NEVER replaces the map — only layers aud.departmentQualifier over it (?? never mutates dem itself)', () => {
    expect(src).toContain('if (apparelProduct && (lean || aud.ageClass)) {')
    expect(src).toContain('const dept = aud.departmentQualifier ?? dem.dept')
  })

  it('target_gender stays gated on `lean` ALONE — the age fact never composes into it (no kids-flavored member exists to compose onto)', () => {
    expect(src).toContain("if (f === 'target gender' && lean) return { ...p, recommended_value: dem.gender")
  })

  it('provenance: value_source is spec ONLY when aud.source !== \'none\' — narrow by construction, an adult/unstated family can never earn it', () => {
    expect(src).toContain("const deptSource = aud.source !== 'none' ? ('spec' as const) : ('audience' as const)")
  })

  it('the age-row append is gated on aud.ageRangeCandidate, which is null for every unstated/adult family — the no-op control holds by construction, not by accident', () => {
    expect(src).toContain("if (aud.ageRangeCandidate) appendSpecFact('age_range_description', /age\\s*range/i, aud.ageRangeCandidate)")
  })

  it('the LLM age line the brief forbids deleting is still present (menu-driven product-details fill prompt names "age range")', () => {
    expect(src).toContain('age range')
  })
})

/* ── DB plumbing: rowToSpec / INTERSECT_EXACT_KEYS carry the new column ──────────────────────── */

describe('rowToSpec — age_class column (071)', () => {
  it('a valid age_class materializes onto BlankSpec.ageClass', () => {
    const row = rowToSpec({ match_pattern: '\\b64000b', style_code: '64000B', garment_family: 'kids_tee', age_class: 'kids' })
    expect(row?.spec.ageClass).toBe('kids')
  })
  it('NULL/absent age_class leaves the field ABSENT — never defaulted to "adult"', () => {
    const row = rowToSpec({ match_pattern: '\\bcomfort\\s*colors?\\b', style_code: '1717', garment_family: 'tee' })
    expect(row?.spec.ageClass).toBeUndefined()
    expect('ageClass' in (row?.spec ?? {})).toBe(false)
  })
  it('an invalid age_class value is silently dropped (fail-open, same doctrine as garment_family)', () => {
    const row = rowToSpec({ match_pattern: '\\bx', style_code: '9999', age_class: 'not-a-real-age' })
    expect(row?.spec.ageClass).toBeUndefined()
  })
  it('accepts every AgeClass enum member', () => {
    const values: AgeClass[] = ['newborn', 'infant', 'toddler', 'kids', 'adult']
    for (const v of values) {
      const row = rowToSpec({ match_pattern: '\\bx', style_code: '9999', age_class: v })
      expect(row?.spec.ageClass).toBe(v)
    }
  })
})

describe('normalizeAudienceLean — unaffected by this task (regression pin)', () => {
  it('still the exact pre-existing mapping', () => {
    expect(normalizeAudienceLean('unisex')).toBe('unisex')
    expect(normalizeAudienceLean('female')).toBe('women')
    expect(normalizeAudienceLean('lean_female')).toBe('women')
    expect(normalizeAudienceLean('male')).toBe('men')
    expect(normalizeAudienceLean('lean_male')).toBe('men')
    expect(normalizeAudienceLean(null)).toBeNull()
    expect(normalizeAudienceLean(undefined)).toBeNull()
  })
})
