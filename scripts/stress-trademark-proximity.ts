/**
 * Stress test for PR #79 — token-proximity trademark detection + helpers verification.
 * Run with: npx tsx scripts/stress-trademark-proximity.ts
 *
 * Live-verified gaps from B0G884ZJ27 + B0GCF11RKL regens that this PR closes:
 *   - "Florida gator" (singular) → was missed by exact-phrase TRADEMARK_PHRASES check
 *   - "Gator Florida" (reversed) → same
 *   - "love for Florida gators" (plural, embedded) → exact-phrase already worked
 *   - "this 128gb sd card alternative" → backstop strips programmatically
 *
 * The backstop and stricter-retry behaviors live inside runBulletsAgent's retry loop
 * and depend on the LLM — those are verified live on the next regen, not here.
 */
import { findTrademarkPhrases } from '../src/lib/fba/listingPipeline'

let pass = 0, fail = 0
const fails: string[] = []
function ok(cond: boolean, msg: string) {
  if (cond) pass++
  else { fail++; fails.push(msg); console.error('  ✗ ' + msg) }
}

console.log('[1] Token proximity — Florida gator (SINGULAR) caught')
ok(findTrademarkPhrases('vintage 90s Florida gator shirt').includes('florida gators'),
   '"Florida gator" singular flagged as florida gators')

console.log('[2] Token proximity — Gator Florida (REVERSED) caught')
ok(findTrademarkPhrases('Vintage 90s Gator Florida Tee').includes('florida gators'),
   'reversed "Gator Florida" flagged')

console.log('[3] Exact-phrase plural still works')
ok(findTrademarkPhrases('love for Florida gators with family').includes('florida gators'),
   '"Florida gators" plural still flagged')

console.log('[4] Generic "gator" or "alligator" ALONE NOT flagged')
ok(findTrademarkPhrases('classic alligator graphic design').length === 0,
   '"alligator" alone passes')
ok(findTrademarkPhrases('cute gator shirt for kids').length === 0,
   '"gator" alone (no Florida nearby) passes')
ok(findTrademarkPhrases('later gator vintage tee').length === 0,
   '"later gator" passes')

console.log('[5] Other sports teams — singular + plural + reversed')
ok(findTrademarkPhrases('Dallas Cowboy fan tee').includes('dallas cowboys'),
   'Dallas Cowboy singular flagged')
ok(findTrademarkPhrases('Cowboys Dallas style').includes('dallas cowboys'),
   'Cowboys Dallas reversed flagged')
ok(findTrademarkPhrases('Texas Longhorn pride shirt').includes('texas longhorns'),
   'Texas Longhorn singular flagged')

console.log('[6] Generic words paired with non-trademark companions stay clean')
ok(findTrademarkPhrases('texas style cooking apron').length === 0,
   '"texas style" without longhorn(s) passes')
ok(findTrademarkPhrases('cowboy boots country style').length === 0,
   '"cowboy" alone (no Dallas) passes')

console.log('[7] Proximity window doesnt fire across paragraph distance')
const farApart = 'A premium classic shirt featuring high quality cotton designed for outdoor wear including hiking camping kayaking fishing and traveling all in one go pro stuff. Florida sun-faded color goes well with everything. The breathable fabric features long-sleeve gator-inspired design elements.'
// "florida" is far from "gator" (~30 words) → should NOT match within a 4-token window
// (intent: catch the phrase appearance only, not co-occurrence anywhere in long copy).
ok(!findTrademarkPhrases(farApart).includes('florida gators'),
   'florida + gator separated by 30+ tokens NOT flagged')

console.log('[8] Single-word trademark tokens still work')
ok(findTrademarkPhrases('Marvel inspired graphic tee').includes('marvel'), 'Marvel token flagged')
ok(findTrademarkPhrases('Harvard alumni shirt').includes('harvard'), 'Harvard token flagged')

console.log('[9] singularize helper handles edge cases (no over-strip on short words)')
import('../src/lib/fba/listingPipeline').then(() => {})
ok(findTrademarkPhrases('sd cards storage').length === 0,
   'short word "cards" not over-stemmed into something matching')
ok(findTrademarkPhrases('classes for sports fans').length === 0,
   'no trademark inferred from "classes for sports"')

console.log(`\n→ ${pass} passed, ${fail} failed`)
if (fail > 0) {
  console.error('\nFAILURES:')
  for (const f of fails) console.error('  - ' + f)
  process.exit(1)
}
