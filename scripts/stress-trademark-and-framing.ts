/**
 * Stress test for PR #77 — TRADEMARK_PHRASES drop + per-occurrence framing.
 * Run with: npx tsx scripts/stress-trademark-and-framing.ts
 *
 * Live-verified bugs covered:
 *   - B0G884ZJ27 regen produced bare "Florida Gators" in title/bullets/description
 *   - Previous isBrandProperlyFramed gave a free pass when ANY occurrence was framed
 */
import {
  findTrademarkPhrases, findThirdPartyBrands, isBrandProperlyFramed,
  validateTitle, validateBullets, validateDescription,
} from '../src/lib/fba/listingPipeline'

let pass = 0, fail = 0
const fails: string[] = []
function ok(cond: boolean, msg: string) {
  if (cond) pass++
  else { fail++; fails.push(msg); console.error('  ✗ ' + msg) }
}
function eq<T>(a: T, b: T, msg: string) {
  ok(JSON.stringify(a) === JSON.stringify(b), `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`)
}

const BRAND = 'THE CEO'

console.log('[1] findTrademarkPhrases detects sports teams + media + universities')
ok(findTrademarkPhrases('Florida Gators Cool Shirt').includes('florida gators'),  'Florida Gators detected')
ok(findTrademarkPhrases('dallas cowboys fan tee').includes('dallas cowboys'),    'Dallas Cowboys detected')
ok(findTrademarkPhrases('Marvel themed tshirt').includes('marvel'),              'Marvel (single token) detected')
ok(findTrademarkPhrases('classic harry potter print').includes('harry potter'),  'Harry Potter detected')
ok(findTrademarkPhrases('star wars merch').includes('star wars'),                'Star Wars detected')

console.log('[2] findTrademarkPhrases does NOT flag generic words')
eq(findTrademarkPhrases('classic alligator graphic vintage tee'), [], 'generic "alligator" passes')
eq(findTrademarkPhrases('lions cool shirt design'),               [], 'generic "lions" (alone) passes')
eq(findTrademarkPhrases('cowboys hat western style'),             [], 'generic "cowboys" (alone) passes')
eq(findTrademarkPhrases('gator fans love this design'),           [], 'generic "gator" alone passes')

console.log('[3] Per-occurrence framing — first bare occurrence fails')
ok(!isBrandProperlyFramed('GoPro is great. Compatible with GoPro Hero.', 'gopro'),
   'first bare occurrence flagged even when later framed')
ok(!isBrandProperlyFramed('GoPro storage solution', 'gopro'),
   'bare GoPro alone flagged')

console.log('[4] Per-occurrence framing — list-with-shared-framing accepted')
ok(isBrandProperlyFramed('for Canon, Nikon, and Sony cameras', 'canon'),
   '"for Canon" framed at start of list')
ok(isBrandProperlyFramed('for Canon, Nikon, and Sony cameras', 'nikon'),
   '"Nikon" in middle of list framed via leading "for"')
ok(isBrandProperlyFramed('for Canon, Nikon, and Sony cameras', 'sony'),
   '"Sony" at end of list framed via leading "for"')
ok(isBrandProperlyFramed('compatible with GoPro Hero and Insta360 cameras', 'insta360'),
   '"Insta360" framed by shared "compatible with"')

console.log('[5] Per-occurrence framing — proper single-occurrence framing accepted')
ok(isBrandProperlyFramed('SD Card for GoPro Hero camera', 'gopro'),
   'simple "for GoPro" passes')
ok(isBrandProperlyFramed('works with Canon EOS R5', 'canon'),
   '"works with Canon" passes')

console.log('[6] validateTitle catches bare trademark — Florida Gators in title (B0G884ZJ27 bug)')
const tmTitle = 'THE CEO See You Later Alligator Shirt Comfort Colors Florida Gators Cool Shirt for Men and Women'
const tmTitleProblems = validateTitle(tmTitle, BRAND).filter((p) => /TRADEMARK INFRINGEMENT/.test(p))
ok(tmTitleProblems.length === 1 && /florida gators/i.test(tmTitleProblems[0]),
   'Florida Gators in title flagged with trademark warning')

console.log('[7] validateTitle passes when trademark removed')
const cleanTitle = 'THE CEO See You Later Alligator Shirt Comfort Colors Vintage 90s Retro Tee for Men and Women'
const cleanTitleTmProblems = validateTitle(cleanTitle, BRAND).filter((p) => /TRADEMARK/.test(p))
ok(cleanTitleTmProblems.length === 0, 'clean title without trademark passes')

console.log('[8] validateBullets catches Florida Gators across multiple bullets')
const tmBullets = [
  'COMFORTABLE FIT - Soft fabric in this later gator design, perfect for all-day wear that keeps you comfortable in any setting.',
  'VERSATILE STYLE - This Florida Gators t shirt offers a classic look that works with cool mens collections for everyday wear.',
  'DURABLE MATERIAL - Crafted with high-quality Comfort Colors fabric so the shirt holds up to many washes through the seasons.',
  'UNISEX DESIGN - Designed for both men and women, this cool t-shirt fits true to size so anyone can show their Florida Gators pride.',
  'PERFECT GIFT - Ideal for fans of all ages, this shirt makes a great gift for birthdays or holidays so loved ones can celebrate.',
]
const tmBProblems = validateBullets(tmBullets, BRAND).filter((p) => /TRADEMARK INFRINGEMENT/.test(p))
ok(tmBProblems.length > 0, 'trademark bullets flagged')
ok(/bullet 2/.test(tmBProblems[0]) && /bullet 4/.test(tmBProblems[0]), 'flags multiple offending bullets')

console.log('[9] validateDescription catches Florida Gators')
const tmDesc = '<p>Premium fabric shirt with vintage style and a bold Florida Gators alligator graphic that captures attention for fans of classic sports culture across many seasons of wear and tear from outdoor use.</p>'
const tmDescProblems = validateDescription(tmDesc, BRAND).filter((p) => /TRADEMARK INFRINGEMENT/.test(p))
ok(tmDescProblems.length === 1 && /florida gators/i.test(tmDescProblems[0]),
   'Florida Gators in description flagged')

console.log('[10] Generic alligator/gator graphic passes (PR #77 doesnt over-block)')
const genericDesc = '<p>Classic vintage 90s tee with a playful retro alligator graphic for fans of bold animal-themed apparel. The relaxed fit and breathable fabric make it ideal for outdoor wear or casual everyday outings across many seasons.</p>'
const genericProblems = validateDescription(genericDesc, BRAND).filter((p) => /TRADEMARK/.test(p))
ok(genericProblems.length === 0, '"retro alligator graphic" without team mark passes')

console.log('[11] Mixed bare+framed brand bullet fails (per-occurrence framing fix)')
const mixedBullet = ['BRAND BENCHMARK - GoPro sets the standard for action cams. This SD card is compatible with GoPro Hero for serious creators on the go anywhere they travel.']
const mixedProblems = validateBullets(mixedBullet, BRAND).filter((p) => /LISTING-SUPPRESSION/.test(p))
ok(mixedProblems.length > 0, 'bare GoPro at start flagged even when later framed')

console.log('[12] Universities (Harvard / Stanford single tokens)')
const eduTitle = 'THE CEO Premium Tee Harvard Style Cool Shirt for Men and Women'
const eduProblems = validateTitle(eduTitle, BRAND).filter((p) => /TRADEMARK/.test(p))
ok(eduProblems.length > 0 && /harvard/i.test(eduProblems[0]), 'Harvard single-token trademark flagged')

console.log(`\n→ ${pass} passed, ${fail} failed`)
if (fail > 0) {
  console.error('\nFAILURES:')
  for (const f of fails) console.error('  - ' + f)
  process.exit(1)
}
