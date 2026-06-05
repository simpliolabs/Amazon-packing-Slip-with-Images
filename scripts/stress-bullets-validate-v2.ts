/**
 * Stress test for PR #76 — capacity-family + CAPS-hook + awkward-forced-keyword
 * checks added to validateBullets. Run with:
 *   npx tsx scripts/stress-bullets-validate-v2.ts
 *
 * Each test case below maps to a live-verified bug found in the B0GCF11RKL or
 * B0G884ZJ27 audit. Passing here means the retry loop will catch it next regen.
 */
import { validateBullets } from '../src/lib/fba/listingPipeline'

let pass = 0, fail = 0
const fails: string[] = []
function ok(cond: boolean, msg: string) {
  if (cond) pass++
  else { fail++; fails.push(msg); console.error('  ✗ ' + msg) }
}

const BRAND = 'THE CEO'

console.log('[1] CAPS hook detection — bullets WITH hook pass')
const withHook = [
  'HIGH-SPEED PERFORMANCE - Class 10 UHS-I technology ensures fast read/write speeds for smooth 8K video recording and quick file transfers.',
  'LARGE STORAGE CAPACITY - Ample space to store high-resolution photos and videos without compromise across long shoots and travel days.',
  'WIDE COMPATIBILITY - Works with most DSLR and mirrorless cameras, action cameras, drones, dash cams, and portable recorders alike.',
  'DURABLE DESIGN - Built to withstand harsh conditions for outdoor shoots while keeping every megabyte of footage and photos safe.',
  'EASY TO USE - Plug-and-play convenience expands your camera storage instantly without any setup, drivers, or extra software.',
]
const okHookProblems = validateBullets(withHook, BRAND).filter((p) => /CAPS benefit hook/.test(p))
ok(okHookProblems.length === 0, 'bullets with proper CAPS hooks pass')

console.log('[2] CAPS hook detection — sentence-prose bullets fail (B0G884ZJ27 bug)')
const proseBullets = [
  'Made from soft, breathable Comfort Colors fabric for all-day comfort and durability.',
  'Features a playful "See You Later Alligator" graphic design that adds a fun, casual vibe.',
  'Unisex fit suitable for both men and women, offering a relaxed and comfortable style.',
  'Perfect for casual wear, outdoor activities, or as a unique gift for anyone who loves quirky tees.',
  'Available in multiple sizes to ensure a great fit for everyone who enjoys lighthearted apparel.',
]
const proseHookProblems = validateBullets(proseBullets, BRAND).filter((p) => /CAPS benefit hook/.test(p))
ok(proseHookProblems.length > 0, 'sentence-prose bullets without hooks flagged')

console.log('[3] Awkward forced keyword — "CRITICAL UPGRADE" hook fails (B0GCF11RKL bug)')
const awkward = [
  'HIGH-SPEED PERFORMANCE - Class 10 UHS-I technology ensures fast read/write speeds for smooth 8K video recording and quick file transfers.',
  'LARGE STORAGE CAPACITY - Ample space to store high-resolution photos and videos without compromise across long shoots and travel days.',
  'WIDE COMPATIBILITY - Works with most DSLR and mirrorless cameras, action cameras, drones, dash cams, and portable recorders alike.',
  'CRITICAL UPGRADE - Upgrade your storage with this 8K memory card designed to handle demanding video formats effortlessly.',
  'DURABLE AND SECURE - Built to withstand harsh conditions, protecting your important data during outdoor shoots and travel.',
]
const awkwardProblems = validateBullets(awkward, BRAND).filter((p) => /pipeline action-type label/.test(p))
ok(awkwardProblems.length > 0, '"CRITICAL UPGRADE" hook flagged as forced')
ok(/CRITICAL/.test(awkwardProblems[0] || '') && /UPGRADE/.test(awkwardProblems[0] || ''), 'detail names both bad tokens')

console.log('[4] Awkward forced keyword — "OPPORTUNITY KEYWORDS" hook fails')
const oppHook = [...withHook]
oppHook[2] = 'OPPORTUNITY KEYWORDS - Wide compatibility with cameras and devices for various photography uses around the home and outdoors.'
const oppProblems = validateBullets(oppHook, BRAND).filter((p) => /pipeline action-type label/.test(p))
ok(oppProblems.length > 0, '"OPPORTUNITY KEYWORDS" hook flagged')

console.log('[5] Awkward check — benefit-only hooks pass cleanly')
const benefitOnly = [
  'PROVEN DURABILITY - This SD card handles harsh outdoor conditions and protects every byte of footage for years to come.',
  ...withHook.slice(1),
]
const benefitOk = validateBullets(benefitOnly, BRAND).filter((p) => /pipeline action-type label/.test(p))
ok(benefitOk.length === 0, 'PROVEN DURABILITY (clean benefit) accepted')

console.log('[6] Capacity-family — bullets with hardcoded 128GB fail (B0GCF11RKL bug)')
const capBullets = [
  'HIGH-SPEED PERFORMANCE - Class 10 UHS-I technology ensures fast read/write speeds for smooth 8K video recording and quick file transfers.',
  'LARGE STORAGE CAPACITY - This 128 GB SD card offers ample space to store high-resolution photos and videos without worry.',
  'RELIABLE COMPATIBILITY - Compatible with most cameras and devices, making it a versatile standard SD card 128GB for various uses.',
  'CRITICAL FEATURE - Built tough for the road ahead with reliable performance under stress and a long usable lifespan.',
  'DURABLE AND SECURE - Built to withstand harsh conditions, protecting your important data during outdoor shoots and travel.',
]
const capProblems = validateBullets(capBullets, BRAND, [], ['32GB', '64GB', '128GB']).filter((p) => /CAPACITY-FAMILY VIOLATION/.test(p))
ok(capProblems.length > 0, 'hardcoded "128 GB"/"128GB" in broadcast bullets flagged')
ok(/bullet 2/.test(capProblems[0]) && /bullet 3/.test(capProblems[0]), 'detail names both offending bullets')

console.log('[7] Capacity-family — capacity-agnostic bullets pass')
const agnosticBullets = [
  ...withHook,
]
const agnosticOk = validateBullets(agnosticBullets, BRAND, [], ['32GB', '64GB', '128GB']).filter((p) => /CAPACITY-FAMILY/.test(p))
ok(agnosticOk.length === 0, 'agnostic bullets accepted under capacity family')

console.log('[8] Capacity-family — single-capacity (apparel) skips the check')
const apparelBullets = [
  'PREMIUM FABRIC - Made from soft, breathable Comfort Colors fabric for all-day comfort and a relaxed retro feel.',
  'CLASSIC DESIGN - Features a playful Later Gator graphic that adds nostalgic charm to any casual outfit.',
  'UNISEX FIT - Designed to flatter every body, this Comfort Colors shirt suits both men and women in equal measure.',
  'DURABLE COTTON - 6.1 oz ring-spun cotton resists pilling and stays vibrant through repeated washes for seasons.',
  'GREAT GIFT - Perfect present for retro-style fans, vintage clothing collectors, and anyone who loves bold graphic tees.',
]
const apparelProblems = validateBullets(apparelBullets, BRAND, [], []).filter((p) => /CAPACITY/.test(p))
ok(apparelProblems.length === 0, 'no capacity check fires when capacityFamily is empty')

console.log('[9] Capacity-family — TB/MB tokens also caught')
const tbBullets = [
  'HIGH-SPEED PERFORMANCE - Reliable 1 TB capacity for endless 8K shoots without changing cards mid-session, ever.',
  ...withHook.slice(1),
]
const tbProblems = validateBullets(tbBullets, BRAND, [], ['1TB', '2TB']).filter((p) => /CAPACITY-FAMILY/.test(p))
ok(tbProblems.length > 0, 'hardcoded "1 TB" caught')

console.log('[10] All three new checks compose with existing ones (length / brand / coverage)')
const composedBad = [
  'short bullet missing all the things',  // no hook + short + no hook caps
  'SanDisk-style storage hardware for everyday photographers and videographers who want a reliable durable backup.',  // bare SanDisk (no framing anywhere in this bullet)
  'CRITICAL UPGRADE - This 128 GB SD card upgrade satisfies storage needs without hassle across all your devices.', // forced kw + capacity
  'DURABLE DESIGN - Solid and protective storage hardware for outdoor shoots and travel days across many use cases.',
  'EASY TO USE - Plug and play convenience with any SD card slot for instant capacity expansion across devices.',
]
const composedProblems = validateBullets(composedBad, BRAND, [], ['32GB', '64GB', '128GB'])
ok(composedProblems.some((p) => /CAPS benefit hook/.test(p)), 'composed: hook check fires')
ok(composedProblems.some((p) => /LISTING-SUPPRESSION/.test(p)), 'composed: brand check fires')
ok(composedProblems.some((p) => /pipeline action-type label/.test(p)), 'composed: forced-keyword check fires')
ok(composedProblems.some((p) => /CAPACITY-FAMILY/.test(p)), 'composed: capacity check fires')
ok(composedProblems.some((p) => /under 100/.test(p)), 'composed: length check fires')

console.log(`\n→ ${pass} passed, ${fail} failed`)
if (fail > 0) {
  console.error('\nFAILURES:')
  for (const f of fails) console.error('  - ' + f)
  process.exit(1)
}
