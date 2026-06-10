// Runtime proof of the broadened honesty validator. BANNED_SRC + sanitize/isOverPromise/cleanLlm are
// copied VERBATIM from src/lib/fba/rankAnalysis.ts (the validator is pure, no imports) so this tests the
// exact pattern. Run: node scripts/verify-rank-honesty.mjs
const BANNED_SRC = [
  '\\brank\\w*\\b[^.]{0,20}\\b(?:#?1|number\\s*one|top|first)\\b',
  '\\b(?:#?1|number\\s*one|top|first)\\b[^.]{0,20}\\brank\\w*\\b',
  '\\boutrank\\w*\\b',
  '\\bbeat\\b[^.]{0,20}\\bcompetitor',
  '\\bdominat\\w*\\b',
  '\\btop\\s+of\\s+amazon\\b',
  '\\b(?:page|pg)\\s*(?:one|1)\\b',
  '\\bfirst\\s+page\\b',
  '\\bbest[\\s-]?seller\\b',
  '\\bguarantee\\w*\\b[^.]{0,25}\\b(?:rank|#?1|top|first|page|sell)',
  '\\b(?:top|first)\\s+(?:spot\\s+|position\\s+)?(?:of|on|in)\\s+(?:the\\s+)?(?:search|results|amazon|page)',
].join('|')
const BANNED = new RegExp(BANNED_SRC, 'i')
const BANNED_G = new RegExp(BANNED_SRC, 'gi')
const isOverPromise = (s) => BANNED.test(s)
const sanitize = (s) => { let out = s; for (let i = 0; i < 5 && BANNED.test(out); i++) out = out.replace(BANNED_G, 'become indexed & competitive'); return out }
const cleanLlm = (s) => (isOverPromise(s) ? '' : s.trim())

// Phrases the OLD regex let through (per the adversarial review) — MUST now be caught.
const MUST_CATCH = [
  'outrank', 'outrank competitors', 'beat competitors', 'page one', 'first page', 'best seller',
  '#1 best seller', 'guaranteed #1', 'guaranteed top ranking', 'rank in the top 3', 'this will rank you #1',
  'rank you at the top', 'rank at the top of search', 'reach the first page of results', 'get to page one',
  'become a best seller', 'rank #1', 'dominate', 'top of amazon', 'we will rank first', 'top ranking',
]
// Honest copy the tool legitimately produces — MUST NOT be caught (no false positives that nuke real copy).
const MUST_PASS = [
  "Content makes you indexed & competitive on 5 of 12 top terms. Reaching the top ALSO needs reviews, conversion, sales velocity, and price — levers this tool can't change.",
  'Your top keywords are already covered in the title.',
  'Improving conversion requires better images, price, and reviews.',
  'Add this keyword to your title and bullets for indexing.',
  'A competitor holds a large share of clicks on this term.',
  'This is necessary but not sufficient for ranking.',
  // Apply-tab rank chip labels + tooltips (integration A increment 1b) — must stay honest.
  'Content-winnable',
  'High-opportunity keyword(s) to add here — this is where content can still move you.',
  'Content done here',
  'Top keywords already covered here — rank now depends on reviews, price, and sales velocity, not more copy.',
]

let fail = 0
for (const p of MUST_CATCH) if (!isOverPromise(p)) { console.log(`  ✗ MISSED over-promise: "${p}"`); fail++ }
for (const p of MUST_PASS) if (isOverPromise(p)) { console.log(`  ✗ FALSE POSITIVE on honest copy: "${p}"`); fail++ }

// Non-global bug: two banned phrases in one string — sanitize must strip BOTH (output clean).
const twoBad = 'Guarantee rank improvements and rank #1 fast.'
const cleaned = sanitize(twoBad)
if (isOverPromise(cleaned)) { console.log(`  ✗ sanitize left a banned phrase: "${cleaned}"`); fail++ }

// cleanLlm drops an over-promising headline entirely (fail-closed, no garbled splice).
if (cleanLlm('Optimized content will rank you at the very top of Amazon search.') !== '') { console.log('  ✗ cleanLlm did not drop an over-promise'); fail++ }
if (cleanLlm('Indexing this term is necessary but not sufficient.') === '') { console.log('  ✗ cleanLlm wrongly dropped honest copy'); fail++ }

console.log(fail === 0
  ? `PASS — ${MUST_CATCH.length}/${MUST_CATCH.length} over-promises caught, ${MUST_PASS.length}/${MUST_PASS.length} honest phrases passed, sanitize global + cleanLlm fail-closed verified.`
  : `FAIL — ${fail} assertion(s) failed.`)
process.exit(fail === 0 ? 0 : 1)
