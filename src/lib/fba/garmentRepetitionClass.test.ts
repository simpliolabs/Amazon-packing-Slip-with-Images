/**
 * garmentRepetitionClass.test.ts — closes the DEFECT CLASS: two title segments asserting the SAME
 * garment concept in different SURFACE FORMS, past every admission guard because they compared
 * surface tokens instead of the folded garment concept.
 *
 * LIVE, 2026-09-02, family B0DSCDZC6K (fresh regen, main @ 109d8f1, right after the fabric-vocab/
 * ship-floor work landed and every child hit the 70-75 band):
 *   "THE CEO Business B*tch | Funny Work Shirts Shirt Long Sleeve for Women"            (70 chars)
 *   "THE CEO Business B*tch Tee Shirt | Mind Your Graphic Top Tshirt for Women"         (prior regen)
 * "Funny Work Shirts" is a live pool keyword (2,035 vol, CORE #5); "Shirt" is the title's own correct
 * garment noun for this Comfort Colors 6014 long-sleeve tee — the pool phrase is what collided.
 *
 * ROOT CAUSE (verified by direct repro against `main` before any edit, not theorised): every
 * admission guard on this path — `verdictForAssembledTitle` → `titleHasDuplicateConcept` →
 * `hasRedundantGarmentMention` — IS wired at every exit that can ship a title (`enforceMoneyTail`
 * :1183, the DFS refill search :1616/:1647, the prior-fallback check :1684, the settle-title finish
 * :1858/:1875, the V4 shadow probe :2770 — grep `verdictForAssembledTitle(` in titleBand.ts). The
 * BRIEF THAT OPENED THIS TASK GUESSED THE WIRE MIGHT BE MISSING ("determine whether
 * hasRedundantGarmentMention is wired at this exit at all ... that is the missing wire and is the
 * smallest correct cure") — that guess was WRONG. `hasRedundantGarmentMention` (contentTruth.ts) was
 * called everywhere it needed to be; its OWN internal logic was unsound. It carried an "adjacency
 * exemption" — same folded class, matches ≤1 char apart ⇒ collapse to ONE mention — built so "Tee"
 * immediately followed by "Shirt" would read as the PO's sanctioned two-word "Tee Shirt" noun and not
 * a false repeat. But "adjacent" is a POSITION proxy standing in for a VOCABULARY fact, and a
 * position proxy cannot tell a genuine two-word noun from an ACCIDENTAL collision of two distinct
 * same-class words that simply happen to sit next to each other — which is exactly what "Shirts"
 * next to "Shirt", and "Top" next to "Tshirt", are.
 *
 * THE CURE (contentTruth.ts): move compound recognition to where it structurally belongs — the
 * TOKENIZER, not a downstream position heuristic. `GARMENT_NOUN_RE` gained `tee[\s-]?shirts?` as its
 * own multi-word alternative, the same tier "tank top" and "hooded sweatshirt" already occupy, so
 * "Tee Shirt" is captured as ONE regex match, not two, by construction. With the one genuine compound
 * handled at the tokenizer, the position-based exemption in `hasRedundantGarmentMention` was deleted
 * outright: ANY two SEPARATE matches of the same folded class within one segment — adjacent or not,
 * a bare plural of the same word or a wholly different alias — are now what they plainly are, two
 * mentions of one concept. No blocklist of bad pairs, no regex of specific strings: the fold is the
 * SAME `GARMENT_NOUN_RE`/`garmentNounClass` map `phraseTruthVerdict`'s wrong-garment-noun rule and
 * every other truth check in this file already share, so any future alias — plural, hyphen, glued —
 * is caught the moment it is added to that ONE map, with zero new code at the call site.
 *
 * A SECOND, PREVIOUSLY-UNFLAGGED INSTANCE THIS FIX ALSO CLOSED (found empirically, not searched for):
 * the pinned `truthBandGate.test.ts` fixture for scope ED used to ship "Graphic Sweatshirts Pullover"
 * — "Sweatshirts" + "Pullover" are two DIFFERENT surface forms of the SAME sweatshirt concept, the
 * identical defect class, just never observed live. Once closed, the additive search backtracked to
 * an equally-good, non-redundant candidate at the SAME length (73 chars) — see that file's updated
 * pin and comment for the full account. No length was spent to fix it.
 */
// Env vars nulled defensively (CI trap, `build.yml`'s placeholder Supabase env makes an eagerly-
// instantiated lazy client attempt a real ~4s network call and time out) — this file never calls a
// DB-touching function, but `truthBandHarness`/`listingPipeline`-adjacent imports transitively reach
// blankSpecs.ts's lazy client Proxy. RESTORED in afterAll per this task's own verification requirement.
const SUPABASE_ENV_KEYS = ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'NEXT_PUBLIC_SUPABASE_ANON_KEY'] as const
const savedSupabaseEnv: Record<string, string | undefined> = {}
for (const key of SUPABASE_ENV_KEYS) { savedSupabaseEnv[key] = process.env[key]; process.env[key] = '' }

import { describe, it, expect, afterAll } from 'vitest'
import {
  hasRedundantGarmentMention, garmentNounClass, GARMENT_NOUN_RE, GARMENT_NOUN_ALIASES,
} from './contentTruth'
import { verdictForAssembledTitle, titleHasDuplicateConcept, TITLE_BAND_LO, TITLE_BAND_HI } from './titleBand'
import { runTruthBandHarness } from './truthBandHarness'

afterAll(() => {
  for (const key of SUPABASE_ENV_KEYS) {
    if (savedSupabaseEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedSupabaseEnv[key]
  }
})

/* ── THE TWO LIVE SPECIMENS ─────────────────────────────────────────────────────────────────────── */

describe('the two LIVE specimens (B0DSCDZC6K, 2026-09-02) are refused, by construction', () => {
  const SPECIMEN_1 = 'THE CEO Business B*tch | Funny Work Shirts Shirt Long Sleeve for Women'
  const SPECIMEN_2 = 'THE CEO Business B*tch Tee Shirt | Mind Your Graphic Top Tshirt for Women'

  it('specimen 1 is exactly 70 chars, as measured live', () => {
    expect(SPECIMEN_1.length).toBe(70)
  })

  it('specimen 1: the colliding segment is flagged — PROVES THE BRANCH RAN, not merely that a string is absent', () => {
    const segment = 'Funny Work Shirts Shirt Long Sleeve for Women'
    expect(hasRedundantGarmentMention(segment)).toBe(true)
  })

  it('specimen 1: the whole-string terminal gate refuses it with reason duplicate-concept', () => {
    expect(titleHasDuplicateConcept(SPECIMEN_1)).toBe(true)
    const verdict = verdictForAssembledTitle(SPECIMEN_1, { truth: null })
    expect(verdict).toEqual({ ok: false, reason: 'duplicate-concept' })
  })

  it('specimen 2: the colliding segment ("Top" + "Tshirt") is flagged', () => {
    const segment = 'Mind Your Graphic Top Tshirt for Women'
    expect(hasRedundantGarmentMention(segment)).toBe(true)
  })

  it('specimen 2: the whole-string terminal gate refuses it with reason duplicate-concept', () => {
    expect(titleHasDuplicateConcept(SPECIMEN_2)).toBe(true)
    const verdict = verdictForAssembledTitle(SPECIMEN_2, { truth: null })
    expect(verdict).toEqual({ ok: false, reason: 'duplicate-concept' })
  })

  it('a CORRECTED specimen 1 (the pool phrase without the colliding bare noun) is accepted — the fix does not over-reject', () => {
    const corrected = 'THE CEO Business B*tch | Funny Work Shirts Long Sleeve for Women'
    expect(titleHasDuplicateConcept(corrected)).toBe(false)
    expect(verdictForAssembledTitle(corrected, { truth: null })).toEqual({ ok: true })
  })
})

/* ── THE SANCTIONED GOLD SURVIVES — "Tee Shirt" is ONE mention, by construction, not by exemption ─── */

describe('the PO\'s sanctioned noun-x2 gold ("Tee Shirt | … TShirt") is untouched', () => {
  it('"Tee Shirt" alone is ONE mention, not two — GARMENT_NOUN_RE now matches it as a single compound', () => {
    const matches = [...'Tee Shirt'.matchAll(GARMENT_NOUN_RE)]
    expect(matches.map((m) => m[0])).toEqual(['Tee Shirt'])
    expect(hasRedundantGarmentMention('Tee Shirt')).toBe(false)
  })

  it('the exact pinned gold string still passes the whole-title gate (dominantGarmentAndCrossSegmentDedupe.test.ts\'s own fixture, re-asserted here)', () => {
    const GOLD = 'THE CEO Alligator Tee Shirt | Comfort Colors TShirt for Women'
    expect(titleHasDuplicateConcept(GOLD)).toBe(false)
  })
})

/* ── THE ENUMERATION TEST — table-driven over the vocabulary ITSELF, the real deliverable ──────────
 *
 * This does not assert today's two known pairs. It reads `GARMENT_NOUN_ALIASES` — the SAME table
 * `GARMENT_NOUN_RE`/`garmentNounClass` are claimed to fold — and:
 *   (a) proves every alias in it is actually recognised and classified as claimed (so an alias added
 *       to the table without also teaching the regex/fold fails HERE, immediately, LOUDLY); then
 *   (b) for every class, builds every ordered pair of DISTINCT aliases in that class and proves
 *       `hasRedundantGarmentMention` catches the pair BOTH adjacent and separated by filler words.
 * Add one alias to `GARMENT_NOUN_ALIASES` in contentTruth.ts and this file automatically grows new
 * assertions for it on the next run — nothing here needs editing.
 */
describe('THE ENUMERATION TEST — every known garment alias, cross-checked against the fold itself', () => {
  const classes = Object.keys(GARMENT_NOUN_ALIASES)

  it('the vocabulary table itself covers at least tee/sweatshirt/crewneck/hoodie', () => {
    expect(classes.length).toBeGreaterThanOrEqual(4)
  })

  for (const cls of classes) {
    const aliases = GARMENT_NOUN_ALIASES[cls]

    describe(`class "${cls}" (${aliases.length} known aliases)`, () => {
      it('every alias is recognised by GARMENT_NOUN_RE and folds to its claimed class', () => {
        for (const alias of aliases) {
          const matches = [...alias.matchAll(GARMENT_NOUN_RE)]
          expect(matches.length, `"${alias}" was not matched by GARMENT_NOUN_RE at all`).toBeGreaterThan(0)
          expect(matches.length, `"${alias}" matched GARMENT_NOUN_RE more than once (${JSON.stringify(matches.map((m) => m[0]))}) — not a single noun`).toBe(1)
          expect(garmentNounClass(matches[0][0]), `"${alias}" folded to the wrong class`).toBe(cls)
        }
      })

      if (aliases.length >= 2) {
        it('every DISTINCT pair of aliases, SEPARATED by filler words in one segment, is caught as a redundant mention', () => {
          const filler = ['Graphic', 'Long', 'Sleeve', 'Funny', 'Work']
          let pairsChecked = 0
          for (const a of aliases) {
            for (const b of aliases) {
              if (a === b) continue
              pairsChecked++
              const separated = `${a} ${filler.join(' ')} ${b} for Women`
              expect(hasRedundantGarmentMention(separated), `class "${cls}": "${a}" + "${b}" separated was NOT flagged`).toBe(true)
              // Whole-string terminal gate too, with the reason code — proves the real ship-path branch ran,
              // not merely that the leaf predicate returns true in isolation.
              const verdict = verdictForAssembledTitle(`THE CEO Design | ${separated}`, { truth: null })
              expect(verdict, `class "${cls}": "${a}" + "${b}" separated was not refused by verdictForAssembledTitle`).toEqual({ ok: false, reason: 'duplicate-concept' })
            }
          }
          // Sanity: this test actually generated pairs (guards against an accidentally-empty alias list
          // silently making every assertion above vacuous).
          expect(pairsChecked).toBeGreaterThan(0)
        })

        it('every DISTINCT pair of aliases, ADJACENT (no separator) in one segment, is caught UNLESS the two aliases concatenate into ONE regex-recognised compound noun (the "Tee Shirt" shape — the ONLY exemption, and it is derived from GARMENT_NOUN_RE itself, never hand-listed)', () => {
          let pairsChecked = 0
          let recognisedCompoundsFound = 0
          for (const a of aliases) {
            for (const b of aliases) {
              if (a === b) continue
              pairsChecked++
              const joined = `${a} ${b}`
              // Ground truth for "is this ONE compound noun, not two mentions?" comes from the SAME
              // regex hasRedundantGarmentMention itself reads — never a second, hand-typed exception
              // list. If `a`+`b` collapses to a single GARMENT_NOUN_RE match, it is structurally one
              // noun (exactly how "Tee Shirt" now works); anything else is two distinct mentions.
              const isRecognisedCompound = [...joined.matchAll(GARMENT_NOUN_RE)].length === 1
              if (isRecognisedCompound) recognisedCompoundsFound++
              const adjacent = `${joined} for Women`
              expect(
                hasRedundantGarmentMention(adjacent),
                `class "${cls}": "${a}" + "${b}" adjacent — expected redundant=${!isRecognisedCompound} (recognised compound=${isRecognisedCompound})`,
              ).toBe(!isRecognisedCompound)
            }
          }
          expect(pairsChecked).toBeGreaterThan(0)
          if (cls === 'tee') {
            // Proves the exemption branch is genuinely exercised here, not vacuously true — "Tee"+"Shirt"
            // must be exactly the one pair GARMENT_NOUN_RE folds to a single match.
            expect(recognisedCompoundsFound, 'expected the "Tee"+"Shirt" compound to be found in the tee class').toBeGreaterThan(0)
          }
        })
      }
    })
  }
})

/* ── LENGTH — the whole B0DSCDZC6K family must still land 70-75 after the fix ──────────────────── */

describe('B0DSCDZC6K family — every title still lands in the 70-75 band', () => {
  const RESULT = runTruthBandHarness()

  it('all 7 rows (parent + 6 designs) are 70-75 chars', () => {
    expect(RESULT.rows.length).toBe(7)
    for (const r of RESULT.rows) {
      expect(r.len, `${r.scope}: "${r.title}" (${r.len} chars)`).toBeGreaterThanOrEqual(TITLE_BAND_LO)
      expect(r.len, `${r.scope}: "${r.title}" (${r.len} chars)`).toBeLessThanOrEqual(TITLE_BAND_HI)
    }
  })

  it('no shipped row carries a redundant garment mention on either side of the pipe', () => {
    for (const r of RESULT.rows) {
      expect(titleHasDuplicateConcept(r.title), `${r.scope}: "${r.title}"`).toBe(false)
    }
  })

  it('the 6 designs, by scope, with their post-fix character counts (report surface)', () => {
    const designs = RESULT.rows.filter((r) => r.scope !== 'broadcast')
    expect(designs.length).toBe(6)
    const report = designs.map((r) => `${r.scope}=${r.len}`).join(' ')
    // eslint-disable-next-line no-console
    console.log(`[B0DSCDZC6K post-fix lengths] ${report}`)
    for (const r of designs) {
      expect(r.len, `${r.scope}: "${r.title}"`).toBeGreaterThanOrEqual(TITLE_BAND_LO)
      expect(r.len, `${r.scope}: "${r.title}"`).toBeLessThanOrEqual(TITLE_BAND_HI)
    }
  })
})
