#!/usr/bin/env node
/**
 * check-title.mjs — score a shipped title against the seller's standard, mechanically.
 *
 *   node scripts/check-title.mjs "THE CEO 2026 World Soccer Cup Tee Shirt | USA Mexico Canada Football Tee"
 *   node scripts/check-title.mjs --design "world soccer cup" "<title>"
 *
 * WHY THIS EXISTS. "Is the title right?" has been settled by eye for months, which is how a 12-word
 * left segment and a spec fact in the money position shipped twice. These are the eight criteria
 * derived from the seller's own rulings and their own measured corpus (2026-08-10), expressed so the
 * answer is a verdict rather than an opinion.
 *
 * Deliberately DEPENDENCY-FREE: it must run against a title pasted from the live site without a
 * build, a DB, or an API key.
 *
 * THIS IS A DIAGNOSTIC MIRROR, NOT A GATE. src/lib/fba/titleBand.ts is authoritative for what ships;
 * the vocabulary below is a copy kept for portability, and a copy is exactly the drift this codebase
 * keeps being bitten by. `checkTitleScriptDrift.test.ts` fails the build if this file's ban list and
 * the door's TITLE_WASTE_SOURCE stop agreeing — so the copy cannot rot silently.
 */

const args = process.argv.slice(2)
let design = ''
const di = args.indexOf('--design')
if (di >= 0) { design = (args[di + 1] || '').toLowerCase(); args.splice(di, 2) }
const title = (args.join(' ') || '').trim()
if (!title) {
  console.error('usage: node scripts/check-title.mjs [--design "<design subject>"] "<title>"')
  process.exit(2)
}

const BAND_LO = 70   // OURS — scoreTitleQuality's golden band (contentContract.title.goldenBandLo)
const BAND_HI = 75   // AMAZON'S — they rewrite a longer title; error 100476 (contentContract.title.hardCap)
const MAX_LEFT_WORDS = 10   // the seller's measured max over their PIPED locked titles (n≈7 of 23)
const BRAND = 'THE CEO'

// The door's own ban list (titleBand.ts TITLE_WASTE_SOURCE) — kept verbatim, not paraphrased.
const WASTE_RE = /\bunisex\b|\bclassic\s+fit\b/i
// Spec facts that must never be the WHOLE money position. Derived from blank_specs columns
// (fit/sleeve/neck) plus the weight/fit claim regexes; a tail is only condemned if EVERY
// significant token in it is one of these — "Long Sleeve Comfort Colors Shirt" survives, which is
// PO gold #1's own shape.
const SPEC_TOK = new Set(['crew', 'neck', 'classic', 'relaxed', 'regular', 'slim', 'fit', 'short',
  'long', 'sleeve', 'sleeveless', 'unisex', 'heavyweight', 'midweight', 'lightweight', 'cotton', 'blend'])
const CONNECTOR = new Set(['for', 'and', 'the', 'a', 'an', 'of', 'with', 'to', 'in', 'on', 'at', 'by', '&', '|'])

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9\s|&-]/g, ' ').split(/\s+/).filter(Boolean)
const sig = (s) => norm(s).filter((t) => !CONNECTOR.has(t) && t.length > 1)

const pipe = title.indexOf(' | ')
const hasPipe = pipe >= 0
const left = hasPipe ? title.slice(0, pipe).trim() : title
const right = hasPipe ? title.slice(pipe + 3).trim() : null
const leftWords = left.split(/\s+/).filter(Boolean).length

const checks = []
const add = (id, pass, detail, note = '') => checks.push({ id, pass, detail, note })

add('C1 length 70-75', title.length >= BAND_LO && title.length <= BAND_HI,
  `${title.length} chars`,
  title.length < BAND_LO ? `under OUR floor (${BAND_LO}) — Amazon does not punish this; a clean short title is legitimate`
    : title.length > BAND_HI ? `OVER AMAZON'S CAP (${BAND_HI}) — Amazon will rewrite it` : '')

add('C2 brand at position 0', title.toLowerCase().startsWith(BRAND.toLowerCase()), `"${title.slice(0, BRAND.length)}"`)

add('C3 left segment <= 10 words', !hasPipe || leftWords <= MAX_LEFT_WORDS,
  hasPipe ? `${leftWords} words: "${left}"` : 'no separator — vacuous (an unpiped title has no left segment)',
  hasPipe && leftWords > MAX_LEFT_WORDS ? `${leftWords - MAX_LEFT_WORDS} over the seller's measured max` : '')

const rightSig = right ? sig(right) : []
const allSpec = rightSig.length > 0 && rightSig.every((t) => SPEC_TOK.has(t))
add('C4 money position is a keyword', !hasPipe || (rightSig.length > 0 && !allSpec),
  hasPipe ? `"${right}"` : 'no separator — vacuous',
  allSpec ? 'EVERY token is a spec fact — this belongs in Item Highlights, not the highest-value real estate' : '')

add('C5 no waste vocabulary', !WASTE_RE.test(title), WASTE_RE.test(title) ? `found "${title.match(WASTE_RE)[0]}"` : 'clean')

const dToks = design ? sig(design) : []
add('C6 design subject present', dToks.length === 0 || dToks.some((d) => sig(title).includes(d)),
  dToks.length === 0 ? 'no --design given — skipped' : `looking for any of [${dToks.join(', ')}]`)

const counts = new Map()
for (const t of sig(title)) {
  const n = t.replace(/s$/, '').replace(/^tshirt$/, 'shirt')
  counts.set(n, (counts.get(n) || 0) + 1)
}
const over = [...counts].filter(([, n]) => n > 2)
add('C7 no word more than twice', over.length === 0, over.length ? over.map(([w, n]) => `${w}×${n}`).join(', ') : 'clean')

add('C8 pipe not required', true, hasPipe ? 'piped (fine — 30% of the seller\'s titles are)' : 'unpiped (fine — 70% of the seller\'s titles are)')

const failed = checks.filter((c) => !c.pass)
console.log(`\n  ${title}\n  ${'─'.repeat(Math.min(title.length, 78))}`)
for (const c of checks) {
  console.log(`  ${c.pass ? 'PASS' : 'FAIL'}  ${c.id.padEnd(30)} ${c.detail}`)
  if (c.note) console.log(`        ${'↳'} ${c.note}`)
}
console.log(`\n  ${failed.length === 0 ? 'MEETS THE STANDARD' : `${failed.length} FAILING: ${failed.map((f) => f.id.split(' ')[0]).join(', ')}`}\n`)
process.exit(failed.length === 0 ? 0 : 1)
