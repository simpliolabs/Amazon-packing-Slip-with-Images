/**
 * Runnable proof for coverage-core (Coherence Invariant 1). No test runner is configured in this repo,
 * so this is a tsx-runnable assertion script (mirrors scripts/verify-*.mjs). Run:
 *   node_modules/.bin/tsx scripts/verify-coverage-core.ts
 * Asserts: garment unification, the strict-superset property (no coverage regresses), stopword +
 * digit-letter handling, and that the LEGACY export is byte-identical to the old bulletTokens rule.
 */
import {
  isCovered, coverageTokens, bulletTokens, missingCoverage, missingBulletKeywordsLegacy, foldGarment,
} from '../src/lib/keyword-engine/coverage-core'

let pass = 0, fail = 0
const ok = (cond: boolean, msg: string) => { if (cond) { pass++ } else { fail++; console.error('  ✗ FAIL:', msg) } }

// ── Garment unification (the actual score-mover) ─────────────────────────────
ok(isCovered('shirts for women', 'Comfort Colors Shirt for Women'), 'shirts for women ⊆ "…Shirt for Women"')
ok(isCovered('t shirt', 'Graphic Shirt'), 't shirt ⊆ "Graphic Shirt" (the "t" drops)')
ok(isCovered('tshirt', 'Graphic Shirt'), 'tshirt ⊆ "Graphic Shirt" (FIXED vs bulletTokens)')
ok(isCovered('tee', 'TShirt Graphic'), 'tee ⊆ "TShirt Graphic" (glued tshirt → shirt)')
ok(isCovered('graphic tees for women', 'Womens Graphic Shirt'), 'graphic tees for women ⊆ "Womens Graphic Shirt"')
ok(isCovered('t-shirt', 'Shirt'), 't-shirt ⊆ "Shirt"')
ok(!isCovered('oversized tshirt', 'Graphic Shirt for Women'), 'oversized NOT auto-covered (spec-grounded attribute)')

// ── Strict-superset: legacy-covered ⟹ core-covered (randomized-ish fixed corpus) ──
const HAYS = ['Comfort Colors Graphic Tee for Women', 'Funny Golf TShirt Mens', 'SanDisk 128GB SD Card', 'Retirement Gift Shirt', 'Later Gator Toddler Tee']
const KWS = ['graphic tee', 'golf tshirt for men', '128 gb sd card', 'retirement shirt', 'later gator tee', 'womens graphic t shirt', 'gifts for the golfer', 'blue widget nonsense']
for (const hay of HAYS) for (const kw of KWS) {
  const legacyCovered = missingBulletKeywordsLegacy([hay], [kw]).length === 0
  const coreCovered = missingCoverage([hay], [kw]).length === 0
  ok(!(legacyCovered && !coreCovered), `SUPERSET violated: legacy-covered but core-missing — kw="${kw}" hay="${hay}"`)
}

// ── Stopwords + digit-letter + empty ─────────────────────────────────────────
ok(isCovered('gifts for the golfer', 'golfer gift set'), 'stopwords dropped; plural folded')
ok(!isCovered('for the and with', 'anything'), 'all-stopword keyword ⇒ never covered')
ok(isCovered('128 gb sd card', 'SanDisk 128GB SD Card'), 'digit-letter split bridges 128GB ↔ 128 gb')

// ── LEGACY byte-identity: the exported legacy check must equal the old bulletTokens rule ──
const oldRule = (bullets: string[], oppKw: string[]) => {
  const have = new Set(bulletTokens(bullets.join(' ')))
  return oppKw.filter((k) => { const t = bulletTokens(k); return t.length === 0 || !t.every((x) => have.has(x)) })
}
for (const hay of HAYS) {
  const a = missingBulletKeywordsLegacy([hay], KWS).sort().join('|')
  const b = oldRule([hay], KWS).sort().join('|')
  ok(a === b, `LEGACY drift vs old bulletTokens rule for hay="${hay}"`)
}

// ── foldGarment identity on non-garment tokens (Step-4 safety) ────────────────
for (const t of ['oversized', 'graphic', 'women', 'golf', 'retirement', 'gb', 'card']) {
  ok(foldGarment(t) === t, `foldGarment must be identity on non-garment token "${t}"`)
}
for (const t of ['tee', 'tees', 'tshirt', 'tshirts', 'shirt', 'shirts']) {
  ok(foldGarment(t) === 'shirt', `foldGarment("${t}") must canonicalize to "shirt"`)
}

console.log(`\ncoverage-core verify: ${pass} passed, ${fail} failed`)
console.log('sample coverageTokens("Graphic TShirt for Women"):', JSON.stringify(coverageTokens('Graphic TShirt for Women')))
process.exit(fail === 0 ? 0 : 1)
