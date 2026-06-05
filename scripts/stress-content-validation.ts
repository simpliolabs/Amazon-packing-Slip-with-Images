/**
 * Stress test for validateBullets + validateDescription — run with:
 *   npx tsx scripts/stress-content-validation.ts
 *
 * Closes the parent/child coverage gap. validateTitle has been the lone validator+retry
 * surface; this verifies the bullets and description validators behave the same way for
 * brand-safety, length, and (bullets) opportunity coverage.
 */
import { validateBullets, validateDescription } from '../src/lib/fba/listingPipeline'

let pass = 0, fail = 0
const fails: string[] = []
function ok(cond: boolean, msg: string) {
  if (cond) pass++
  else { fail++; fails.push(msg); console.error('  ✗ ' + msg) }
}

const BRAND = 'THE CEO'

console.log('[1] validateBullets — clean bullets, no brand violation, length OK')
const cleanBullets = [
  'RELIABLE HIGH SPEED - Experience fast and efficient data transfer with this Class 10 UHS-I memory card, ideal for use as sd hc memory cards in various devices requiring quick access.',
  'ULTRA HD COMPATIBILITY - Designed to support high-resolution content, this 8k memory card ensures smooth recording and playback for ultra-high-definition videos.',
  'OPTIMAL CAMERA PERFORMANCE - These memory cards for cameras deliver consistent performance and compatibility with DSLR and mirrorless models, making them a trusted choice for photography and videography.',
  'DURABLE AND PROTECTED - Built to withstand harsh conditions, this memory card is waterproof, shockproof, and temperature-resistant, ensuring your data stays safe in any environment.',
  'VERSATILE STORAGE SOLUTION - Offering ample capacity and reliable speed, this memory card is perfect for photographers and videographers seeking dependable storage for their camera files.',
]
ok(validateBullets(cleanBullets, BRAND).length === 0, 'clean bullets pass with no problems')

console.log('[2] validateBullets — bare brand name in a bullet triggers a problem')
const bareBrandBullets = [
  cleanBullets[0],
  'GoPro Hero Compatible - Works as memory cards for action cameras and adventure gear.', // bare GoPro → fail
  cleanBullets[2],
  cleanBullets[3],
  cleanBullets[4],
]
const bareProblems = validateBullets(bareBrandBullets, BRAND)
ok(bareProblems.some((p) => /LISTING-SUPPRESSION/.test(p) && /gopro/i.test(p)),
   'bare GoPro in bullet 2 flagged')

console.log('[3] validateBullets — properly framed brand passes')
const framedBrandBullets = [
  cleanBullets[0],
  'PROVEN COMPATIBILITY - Tested and verified for GoPro Hero action cameras and works with Canon EOS DSLRs for vlogging.',
  cleanBullets[2],
  cleanBullets[3],
  cleanBullets[4],
]
const framedProblems = validateBullets(framedBrandBullets, BRAND).filter((p) => /LISTING-SUPPRESSION/.test(p))
ok(framedProblems.length === 0, '"for GoPro" + "works with Canon" passes brand check')

console.log('[4] validateBullets — short bullets get flagged')
const shortBullets = [
  cleanBullets[0],
  'FAST SPEEDS - Quick storage.',  // too short
  'GREAT QUALITY - Reliable card.', // too short
  cleanBullets[3],
  cleanBullets[4],
]
const shortProblems = validateBullets(shortBullets, BRAND)
ok(shortProblems.some((p) => /under 100 chars/.test(p)), 'short bullets reported')

console.log('[5] validateBullets — own brand never flagged')
const ownBrandBullets = [
  'PREMIUM QUALITY - This THE CEO memory card delivers reliable performance for all your storage needs across multiple devices.',
  cleanBullets[1],
  cleanBullets[2],
  cleanBullets[3],
  cleanBullets[4],
]
const ownProblems = validateBullets(ownBrandBullets, BRAND).filter((p) => /LISTING-SUPPRESSION/.test(p))
ok(ownProblems.length === 0, 'own brand "THE CEO" exempt from brand-safety')

console.log('[6] validateBullets — opportunity coverage flagged when 3+ missing')
const missingKwBullets = [
  'GREAT STORAGE - High capacity memory card with reliable performance for everyday use across many different devices.',
  'STRONG BUILD - Built tough to withstand drops and exposure to elements while keeping your files safe and secure.',
  'PROFESSIONAL GRADE - Designed for serious creators who need dependable performance from their storage media every day.',
  'FAST TRANSFER - Quick read and write speeds for hassle-free file management from your camera to your computer.',
  'WORRY-FREE WARRANTY - Backed by our quality guarantee so you can buy with confidence knowing we stand behind every card.',
]
const opportunityKws = ['4k video', 'dash cam', 'drone', 'vlogging', 'action camera']
const coverageProblems = validateBullets(missingKwBullets, BRAND, opportunityKws)
ok(coverageProblems.some((p) => /missing.*top opportunity/i.test(p)), 'missing-keyword coverage flagged')

console.log('[7] validateBullets — coverage OK when enough keywords present')
const coveredBullets = [
  'ULTRA FAST 4K VIDEO - Capture 4k video and dash cam footage with this high-speed card built for action camera workflows.',
  'DRONE READY STORAGE - Ideal for drone pilots and vlogging creators who need reliable storage during long shoots.',
  cleanBullets[2],
  cleanBullets[3],
  cleanBullets[4],
]
const coveredProblems = validateBullets(coveredBullets, BRAND, opportunityKws).filter((p) => /opportunity/i.test(p))
ok(coveredProblems.length === 0, 'bullets including 4+ keywords pass coverage')

console.log('[8] validateDescription — clean HTML passes')
const cleanDesc = `<p>The THE CEO 128GB SD Card is engineered for serious content creators who need dependable storage on every shoot. Built around UHS-I Class 10 technology, it delivers consistent read and write speeds so you never miss the moment that matters most.</p><ul><li>Ample 128GB capacity for long-form 4K video and high-resolution photos</li><li>Class 10 UHS-I rated for sustained burst photography and continuous record</li><li>Waterproof, shockproof, and temperature-resistant for travel and outdoor work</li></ul><p>Compatible with most DSLR and mirrorless cameras as well as dash cams and drones. Backed by our quality guarantee and engineered for everyday creators who demand reliability from every piece of gear they carry.</p>`
ok(validateDescription(cleanDesc, BRAND).length === 0, 'clean HTML description passes')

console.log('[9] validateDescription — bare brand triggers brand-safety problem')
// Insert a bare brand reference that has NO framing word in front of it. The original
// description's "Compatible with most DSLR..." would have framed any brand we substituted
// for "most DSLR" — that pattern is genuinely safe. Instead inject a bare reference into
// the first <p> where there is no "for"/"compatible with" prefix.
const bareDesc = cleanDesc.replace(
  'engineered for serious content creators',
  'engineered to outperform Sandisk Extreme cards for serious content creators',
)
const bareDescProblems = validateDescription(bareDesc, BRAND)
ok(bareDescProblems.some((p) => /LISTING-SUPPRESSION/.test(p) && /sandisk/i.test(p)),
   'bare "outperform Sandisk Extreme" in description flagged')

console.log('[10] validateDescription — properly framed brand passes')
const framedDesc = cleanDesc.replace(
  'engineered for serious content creators',
  'designed to work with GoPro Hero action cameras for serious content creators',
)
const framedDescProblems = validateDescription(framedDesc, BRAND).filter((p) => /LISTING-SUPPRESSION/.test(p))
ok(framedDescProblems.length === 0, '"work with GoPro" passes brand check')

console.log('[11] validateDescription — too short triggers length problem')
const shortDesc = `<p>Short description.</p>`
const shortDescProblems = validateDescription(shortDesc, BRAND)
ok(shortDescProblems.some((p) => /only \d+ chars/.test(p)), 'short description flagged')

console.log(`\n→ ${pass} passed, ${fail} failed`)
if (fail > 0) {
  console.error('\nFAILURES:')
  for (const f of fails) console.error('  - ' + f)
  process.exit(1)
}
