/**
 * Local stress test for the brand-safety helpers — run with:
 *   npx tsx scripts/stress-brand-safety.ts
 *
 * Verifies:
 *   1. Third-party brands are detected, the seller's own brand is not
 *   2. 'for [Brand]' / 'compatible with [Brand]' framing passes
 *   3. Bare references fail
 *   4. Multi-word brand phrases (Western Digital, Audio Technica) are handled
 *   5. The validator pushes a problem when a title has a bare brand reference
 */
import { validateTitle, findThirdPartyBrands, isBrandProperlyFramed } from '../src/lib/fba/listingPipeline'

let pass = 0, fail = 0
const fails: string[] = []
function ok(cond: boolean, msg: string) {
  if (cond) pass++
  else { fail++; fails.push(msg); console.error('  ✗ ' + msg) }
}

const own = new Set(['the', 'ceo'])

console.log('[1] Detect third-party brands, exempt own brand')
ok(findThirdPartyBrands('THE CEO SD Card for GoPro', own).includes('gopro'),  'GoPro detected')
ok(findThirdPartyBrands('THE CEO SD Card for Canon EOS', own).includes('canon'), 'Canon detected')
ok(!findThirdPartyBrands('THE CEO SD Card', own).includes('ceo'),               'own brand "ceo" exempt')
ok(findThirdPartyBrands('Compatible with Sandisk Extreme', own).includes('sandisk'), 'SanDisk detected')
ok(findThirdPartyBrands('Western Digital storage', own).includes('western digital'), 'multi-word brand detected')
ok(findThirdPartyBrands('iPhone 14 case', own).includes('iphone'),              'iPhone detected')

console.log('[2] Proper framing recognized')
ok(isBrandProperlyFramed('THE CEO SD Card for GoPro Hero', 'gopro'),            '"for GoPro" framed')
ok(isBrandProperlyFramed('compatible with Canon EOS R5', 'canon'),              '"compatible with Canon" framed')
ok(isBrandProperlyFramed('works with Sony Alpha', 'sony'),                      '"works with Sony" framed')
ok(isBrandProperlyFramed('for GoPro Hero 11 action camera', 'gopro'),           'for [Brand Model] framed')
ok(isBrandProperlyFramed('SD card for action camera GoPro', 'gopro'),           'framing with 2-word gap OK')

console.log('[3] Bare references rejected')
ok(!isBrandProperlyFramed('GoPro SD Card 128GB', 'gopro'),                      'bare brand-first rejected')
ok(!isBrandProperlyFramed('Sandisk-Style Storage Card', 'sandisk'),             'bare with hyphen rejected')
ok(!isBrandProperlyFramed('iPhone Memory 128GB', 'iphone'),                     'bare iPhone rejected')

console.log('[4] validateTitle pushes a problem when bare brand present')
const bareTitle = 'THE CEO GoPro Memory Card 128GB Class 10 UHS-I'
const bareProblems = validateTitle(bareTitle, 'THE CEO')
ok(bareProblems.some((p) => /LISTING-SUPPRESSION RISK/.test(p) && /gopro/i.test(p)),
   'validateTitle flags bare GoPro')

const safeTitle = 'THE CEO Memory Card 128GB Class 10 UHS-I for GoPro Hero Camera'
const safeProblems = validateTitle(safeTitle, 'THE CEO').filter((p) => /LISTING-SUPPRESSION/.test(p))
ok(safeProblems.length === 0, 'validateTitle accepts "for GoPro" framing')

const multiBare = 'THE CEO Canon Nikon Sony SD Card 128GB'
const multiProblems = validateTitle(multiBare, 'THE CEO').filter((p) => /LISTING-SUPPRESSION/.test(p))
ok(multiProblems.length === 1 && /canon/i.test(multiProblems[0]) && /nikon/i.test(multiProblems[0]) && /sony/i.test(multiProblems[0]),
   'validateTitle flags multiple bare brands at once')

console.log('[5] Own brand never flagged even when adjacent to risky words')
const ownTitle = 'THE CEO Premium SD Card 128GB Class 10 UHS-I for Cameras'
const ownProblems = validateTitle(ownTitle, 'THE CEO').filter((p) => /LISTING-SUPPRESSION/.test(p))
ok(ownProblems.length === 0, 'own brand never triggers brand-safety flag')

console.log(`\n→ ${pass} passed, ${fail} failed`)
if (fail > 0) {
  console.error('\nFAILURES:')
  for (const f of fails) console.error('  - ' + f)
  process.exit(1)
}
