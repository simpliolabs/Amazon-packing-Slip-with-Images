/**
 * Runnable proof for coverage-core (Coherence Invariant 1). No test runner is configured in this repo,
 * so this is a tsx-runnable assertion script (mirrors scripts/verify-*.mjs). Run:
 *   node_modules/.bin/tsx scripts/verify-coverage-core.ts
 * Asserts: garment unification, the strict-superset property (no coverage regresses), stopword +
 * digit-letter handling, and that the LEGACY export is byte-identical to the old bulletTokens rule.
 */
import {
  isCovered, coverageTokens, bulletTokens, missingCoverage, missingBulletKeywordsLegacy, foldGarment,
  coverageAcrossRows,
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

// ── coverageAcrossRows: the single field+union read predicate (RANK + Intelligence) ──────────
{
  const rows = [{ title: 'Comfort Colors Graphic Tee for Women', bullet_1: 'Soft ringspun cotton', description: null, backend_keywords: 'golf mom retirement gift' }]
  const a = coverageAcrossRows('graphic tee', rows)
  ok(a.covered && a.inTitle && a.coveredIn.includes('title'), 'coverageAcrossRows: title phrase inTitle+covered')
  const b = coverageAcrossRows('retirement gift', rows)
  ok(b.covered && b.inBackend && !b.inTitle, 'coverageAcrossRows: backend-only phrase covered via backend')
  const c = coverageAcrossRows('unicorn spaceship', rows)
  ok(!c.covered && c.coveredIn.length === 0, 'coverageAcrossRows: absent phrase not covered')
  // CROSS-FIELD (the seam): "cotton women" — "women" only in title, "cotton" only in a bullet.
  // Field-agnostic union ⇒ covered:true, yet NO single field carries both ⇒ every per-field flag false.
  const d = coverageAcrossRows('cotton women', rows)
  ok(d.covered, 'coverageAcrossRows: cross-field keyword IS covered (field-agnostic union)')
  ok(!d.inTitle && !d.inBullets, 'coverageAcrossRows: cross-field keyword has no single-field flag (correct)')
  // Twin OR: a keyword present in EITHER twin row's field counts.
  const twins = [{ title: 'Golf Shirt' }, { title: 'Funny Golf Tee for Men', backend_keywords: 'fathers day' }]
  const e = coverageAcrossRows('golf tee for men', twins)
  ok(e.covered && e.inTitle, 'coverageAcrossRows: twin-2 title satisfies the phrase')
}

console.log(`\ncoverage-core verify: ${pass} passed, ${fail} failed`)
console.log('sample coverageTokens("Graphic TShirt for Women"):', JSON.stringify(coverageTokens('Graphic TShirt for Women')))
process.exit(fail === 0 ? 0 : 1)
