// Runtime proof of the shared bullet-coverage predicate. BKW_STOP / bulletTokens / missingBulletKeywords
// are copied VERBATIM from src/lib/keyword-engine/bulletCoverage.ts (the module is pure, no imports), so this
// tests the EXACT token logic the scorer, the bullet validator, and the deterministic backstop all share.
// This predicate is the single source of truth that killed the 9/18 "three rulebooks" divergence — if it
// drifts, all three layers drift together. Run: node scripts/verify-bullet-coverage.mjs
const BKW_STOP = new Set([
  'for', 'the', 'a', 'an', 'and', 'with', 'of', 'to', 'in', 'on', 'your', 'you', 'that', 'this',
])
const bulletTokens = (s) =>
  (s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((t) => t.length > 1 && !BKW_STOP.has(t))
function missingBulletKeywords(bullets, oppKw) {
  const have = new Set(bulletTokens(bullets.join(' ')))
  return oppKw.filter((k) => {
    const t = bulletTokens(k)
    return t.length === 0 || !t.every((x) => have.has(x))
  })
}

let pass = 0, fail = 0
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) pass++; else { fail++; console.log(`  FAIL: ${name}\n    got : ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}`) }
}

// 1. A keyword whose every significant token is present anywhere across the joined bullets → COVERED.
check('all tokens present → covered',
  missingBulletKeywords(['PREMIUM COTTON - Soft alligator graphic tee', 'Great gift for kids'], ['alligator graphic tee']),
  [])

// 2. Paraphrase / split across bullets still counts (token-based, not substring) — the core fix.
check('paraphrase split across bullets → covered',
  missingBulletKeywords(['See you later vibes', 'A fun alligator shirt'], ['see you later alligator shirt']),
  [])

// 3. A missing token → the keyword is reported missing.
check('one token absent → missing',
  missingBulletKeywords(['Soft cotton alligator tee'], ['alligator crocodile tee']),
  ['alligator crocodile tee'])

// 4. Stopwords + 1-char tokens are ignored on BOTH sides (your/you/that/this/for/a…).
check('stopwords ignored on keyword side → covered',
  missingBulletKeywords(['Comfortable alligator design'], ['alligator design for you']),
  [])

// 5. Multi-keyword: only the genuinely-uncovered ones come back.
check('mixed set → only uncovered returned',
  missingBulletKeywords(['Soft alligator tee with bold print'], ['alligator tee', 'crocodile hoodie', 'bold print']),
  ['crocodile hoodie'])

// 6. An all-stopword keyword tokenizes to [] → treated as "missing" by the predicate (the scorer keeps
//    docking). The BACKSTOP separately skips bulletTokens(kw).length===0 so it never appends a useless tail —
//    asserted here so a future predicate change that hides this case is caught.
check('all-stopword keyword → reported missing (predicate); backstop must skip it',
  missingBulletKeywords(['Soft alligator tee'], ['you and the']),
  ['you and the'])
check('all-stopword keyword tokenizes to empty',
  bulletTokens('you and the'),
  [])

// 7. Case + punctuation normalised.
check('case/punct insensitive → covered',
  missingBulletKeywords(["Later-Gator, T-SHIRT!"], ['later gator t shirt']),
  [])

// 8. Empty bullets → everything missing.
check('empty bullets → all missing',
  missingBulletKeywords(['', '  '], ['alligator tee', 'crocodile shirt']),
  ['alligator tee', 'crocodile shirt'])

if (fail === 0) {
  console.log(`PASS — ${pass}/${pass} bullet-coverage predicate assertions held (token coverage, paraphrase, stopword, all-stopword, multi-keyword, case/punct, empty).`)
  process.exit(0)
} else {
  console.log(`FAIL — ${fail} assertion(s) failed, ${pass} passed.`)
  process.exit(1)
}
