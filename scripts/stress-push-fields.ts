/**
 * Local stress test for src/lib/fba/pushFields.ts — run with:  npx tsx scripts/stress-push-fields.ts
 *
 * Mirrors exactly the composition the push-content route uses (dedup → resolve →
 * current → compare → changed → patch body) over synthetic data, so a green run
 * means the field math is correct without touching Amazon or Supabase.
 */
import {
  FIELD_CONFIG, PUSH_FIELDS, isPushField,
  buildPatchValue, resolveProposed, currentValue, asCompare,
  dedupByAsin, capForField, capBytes, getByteLength, cacheUpdateFor,
  type PushField,
} from '../src/lib/fba/pushFields'

let pass = 0, fail = 0
const fails: string[] = []
function ok(cond: boolean, msg: string) {
  if (cond) { pass++ } else { fail++; fails.push(msg); console.error('  ✗ ' + msg) }
}
function eq(a: unknown, b: unknown, msg: string) {
  const A = JSON.stringify(a), B = JSON.stringify(b)
  ok(A === B, `${msg}  (got ${A}  expected ${B})`)
}

const MP = 'ATVPDKIKX0DER'

// Simulate the route's per-field preview/diff over content rows.
interface Row { sku: string; asin: string; title?: string; bullet_1?: string; bullet_2?: string; bullet_3?: string; bullet_4?: string; bullet_5?: string; description?: string; backend_keywords?: string }
function simulate(field: PushField, rec: any, perChild: Map<string, string>, rows: Row[]) {
  const cfg = FIELD_CONFIG[field]
  // Mirror the route: push to EVERY SKU (no ASIN dedup). Keywords resolve by ASIN so both
  // the FBA and FBM SKU of a pair get the same per-color string.
  const asinToKw = new Map<string, string>()
  if (field === 'keywords') {
    const skuToAsin = new Map(rows.map((r) => [r.sku, r.asin]))
    for (const [sku, kw] of perChild) { const a = skuToAsin.get(sku); if (a) asinToKw.set(a, kw) }
  }
  const diff = rows.map((row) => {
    const proposed = field === 'keywords'
      ? (asinToKw.has(row.asin) ? asinToKw.get(row.asin)! : null)
      : resolveProposed(field, rec, new Map(), row.sku)
    const proposedStr = asCompare(proposed)
    const current = currentValue(field, row as any)
    return { sku: row.sku, current, proposed: proposedStr, raw: proposed, changed: proposedStr.length > 0 && current !== proposedStr }
  }).filter((d) => d.raw != null)
  return { count: diff.length, changed: diff.filter((d) => d.changed).length, diff, broadcast: cfg.broadcast }
}

console.log('\n=== pushFields stress test ===\n')

// ── 1. FIELD_CONFIG wiring ───────────────────────────────────────────────────
console.log('1. FIELD_CONFIG attribute + broadcast wiring')
eq(FIELD_CONFIG.title.attribute, 'item_name', 'title → item_name')
eq(FIELD_CONFIG.bullets.attribute, 'bullet_point', 'bullets → bullet_point')
eq(FIELD_CONFIG.description.attribute, 'product_description', 'description → product_description')
eq(FIELD_CONFIG.keywords.attribute, 'generic_keyword', 'keywords → generic_keyword')
ok(FIELD_CONFIG.title.broadcast && FIELD_CONFIG.bullets.broadcast && FIELD_CONFIG.description.broadcast, 'title/bullets/description are broadcast')
ok(!FIELD_CONFIG.keywords.broadcast, 'keywords is per-child (not broadcast)')
ok(FIELD_CONFIG.bullets.isArray && !FIELD_CONFIG.title.isArray, 'only bullets is an array field')
eq(PUSH_FIELDS.length, 4, '4 push fields')
ok(isPushField('title') && !isPushField('nonsense'), 'isPushField guard')

// ── 2. buildPatchValue → Amazon patch shape ──────────────────────────────────
console.log('2. buildPatchValue Amazon shape')
eq(buildPatchValue('My Title', MP), [{ value: 'My Title', marketplace_id: MP, language_tag: 'en_US' }], 'single field → 1 entry')
const bp = buildPatchValue(['a', 'b', '', '  ', 'c'], MP)
eq(bp.length, 3, 'bullets: empty/whitespace entries filtered')
eq(bp.map((e) => e.value), ['a', 'b', 'c'], 'bullets: order preserved')
ok(bp.every((e) => e.marketplace_id === MP && e.language_tag === 'en_US'), 'every entry has marketplace + language tag')
eq(buildPatchValue('kw string', MP), [{ value: 'kw string', marketplace_id: MP, language_tag: 'en_US' }], 'keywords → 1 entry')

// ── 3. resolveProposed broadcast vs per-child + caps ──────────────────────────
console.log('3. resolveProposed broadcast / per-child / caps')
const rec = {
  recommended_title: 'THE CEO See You Later Alligator Shirt Comfort Colors Vintage 90s',
  recommended_bullets: ['VINTAGE 90S STYLE - retro flair', 'UNIQUE GRAPHIC - crocodile shirt', 'VERSATILE FASHION - jeans or shorts', 'PREMIUM COMFORT - ringspun', 'EASY CARE - relaxed fit', 'SIXTH BULLET should be dropped'],
  recommended_description: '<p>Step back into the 90s.</p>',
}
const pcMap = new Map<string, string>([
  ['AQS-L-LG-FBA', 'see you later alligator shirt later gator men women comfort colors light green'],
  ['AQS-L-MOS-FBA', 'see you later alligator shirt later gator men women comfort colors moss olive'],
])
// broadcast: same title for any sku
eq(resolveProposed('title', rec, pcMap, 'AQS-L-LG-FBA'), rec.recommended_title, 'title broadcast value for sku A')
eq(resolveProposed('title', rec, pcMap, 'AQS-L-MOS-FBA'), rec.recommended_title, 'title broadcast value identical for sku B')
// bullets: max 5, non-empty, order
const rb = resolveProposed('bullets', rec, pcMap, 'any') as string[]
eq(rb.length, 5, 'bullets capped at 5 (6th dropped, empty removed → 5 kept)')
ok(!rb.includes(''), 'no empty bullet survives')
eq(rb[0], 'VINTAGE 90S STYLE - retro flair', 'bullet order preserved')
ok(!rb.includes('SIXTH BULLET should be dropped'), '6th non-empty bullet dropped by slice(0,5)')
eq(resolveProposed('bullets', { recommended_bullets: ['a', '', '  ', 'b'] }, pcMap, 's'), ['a', 'b'], 'empty/whitespace bullets filtered out')
// description broadcast
eq(resolveProposed('description', rec, pcMap, 'x'), '<p>Step back into the 90s.</p>', 'description broadcast value')
// keywords per-child
eq(resolveProposed('keywords', rec, pcMap, 'AQS-L-LG-FBA'), pcMap.get('AQS-L-LG-FBA'), 'keywords sku A')
eq(resolveProposed('keywords', rec, pcMap, 'AQS-L-MOS-FBA'), pcMap.get('AQS-L-MOS-FBA'), 'keywords sku B')
eq(resolveProposed('keywords', rec, pcMap, 'NOT-IN-MAP'), null, 'keywords null when sku missing from map')
// caps
const longTitle = 'X'.repeat(300)
eq((resolveProposed('title', { recommended_title: longTitle }, pcMap, 's') as string).length, 200, 'title capped at 200 chars')
const longDesc = 'Y'.repeat(3000)
eq((resolveProposed('description', { recommended_description: longDesc }, pcMap, 's') as string).length, 2000, 'description capped at 2000 chars')
const longBullet = 'Z'.repeat(900)
const cappedBullets = resolveProposed('bullets', { recommended_bullets: [longBullet] }, pcMap, 's') as string[]
eq(cappedBullets[0].length, 500, 'each bullet capped at 500 chars')
// keyword byte cap (250)
const longKw = 'word '.repeat(120) // 600 bytes
ok(getByteLength(capForField('keywords', longKw)) <= 250, 'keyword capped to <=250 bytes')
ok(!capForField('keywords', longKw).endsWith(' '), 'keyword cap trims trailing space (word boundary)')
// empty recommendations → null (nothing to push)
eq(resolveProposed('title', { recommended_title: '' }, pcMap, 's'), null, 'empty title → null')
eq(resolveProposed('bullets', { recommended_bullets: [] }, pcMap, 's'), null, 'empty bullets → null')

// ── 4. currentValue reads each field from a content row ───────────────────────
console.log('4. currentValue')
const row1 = { sku: 'A', asin: 'B0X', title: '  Old Title  ', bullet_1: 'b1', bullet_2: '', bullet_3: 'b3', description: '<p>old</p>', backend_keywords: 'old kw' }
eq(currentValue('title', row1 as any), 'Old Title', 'title trimmed')
eq(currentValue('bullets', row1 as any), 'b1\nb3', 'bullets join non-empty with newline')
eq(currentValue('description', row1 as any), '<p>old</p>', 'description read')
eq(currentValue('keywords', row1 as any), 'old kw', 'keywords read backend_keywords')

// ── 5. asCompare ─────────────────────────────────────────────────────────────
console.log('5. asCompare')
eq(asCompare(['a', '', 'b']), 'a\nb', 'array → newline-joined non-empty')
eq(asCompare('  hi  '), 'hi', 'string trimmed')
eq(asCompare(null), '', 'null → empty')

// ── 6. dedupByAsin: FBA+FBM share one ASIN → keep -FBA ────────────────────────
console.log('6. dedupByAsin')
const dupRows: Row[] = [
  { sku: 'AQS-L-LG', asin: 'ASIN1' },        // FBM
  { sku: 'AQS-L-LG-FBA', asin: 'ASIN1' },    // FBA (preferred)
  { sku: 'AQS-L-MOS-FBA', asin: 'ASIN2' },
  { sku: 'AQS-PARENT', asin: 'PARENT' },
]
const dd = dedupByAsin(dupRows)
eq(dd.length, 3, 'dedup 4 SKUs / 3 ASINs → 3 rows')
ok(dd.some((r) => r.sku === 'AQS-L-LG-FBA') && !dd.some((r) => r.sku === 'AQS-L-LG'), 'prefers -FBA over FBM for shared ASIN')
eq(dd.map((r) => r.sku), ['AQS-L-LG-FBA', 'AQS-L-MOS-FBA', 'AQS-PARENT'], 'deduped rows sorted by sku')

// ── 7. Full diff simulation (the route preview) ──────────────────────────────
console.log('7. diff/preview simulation')
// Title broadcast over 3 live versions, one child already matching the recommendation.
const titleRows: Row[] = [
  { sku: 'AQS-L-LG-FBA', asin: 'A1', title: 'Old child title one' },
  { sku: 'AQS-L-MOS-FBA', asin: 'A2', title: 'Different child title two' },
  { sku: 'AQS-M-PEP-FBA', asin: 'A3', title: 'Yet another title three' },
  { sku: 'AQS-S-WHT', asin: 'A4', title: rec.recommended_title }, // already matches → not changed
]
const tSim = simulate('title', rec, pcMap, titleRows)
eq(tSim.count, 4, 'title: 4 child ASINs in scope')
eq(tSim.changed, 3, 'title: 3 differ from recommendation, 1 already matches')
ok(tSim.broadcast, 'title flagged broadcast in preview')
ok(tSim.diff.every((d) => d.proposed === rec.recommended_title), 'title: every child proposed the SAME value (broadcast)')

// Keywords per-child: 2 mapped SKUs, one already matching.
const kwRows: Row[] = [
  { sku: 'AQS-L-LG-FBA', asin: 'A1', backend_keywords: 'stale keywords here' },
  { sku: 'AQS-L-MOS-FBA', asin: 'A2', backend_keywords: pcMap.get('AQS-L-MOS-FBA') }, // already matches
  { sku: 'AQS-M-PEP-FBA', asin: 'A3', backend_keywords: 'unmapped sku — excluded' }, // not in map → excluded
]
const kwSim = simulate('keywords', rec, pcMap, kwRows)
eq(kwSim.count, 2, 'keywords: only SKUs present in per-child map are in scope (2)')
eq(kwSim.changed, 1, 'keywords: 1 changed, 1 already matches')
ok(!kwSim.broadcast, 'keywords flagged per-child in preview')
ok(kwSim.diff.find((d) => d.sku === 'AQS-L-LG-FBA')!.proposed !== kwSim.diff.find((d) => d.sku === 'AQS-L-MOS-FBA')!.proposed, 'keywords: per-child values differ between SKUs')

// Bullets broadcast: current differs → changed; identical 5 → not changed.
const bulletRows: Row[] = [
  { sku: 'A-FBA', asin: 'A1', bullet_1: 'old1', bullet_2: 'old2' },
  { sku: 'B-FBA', asin: 'A2', bullet_1: rb[0], bullet_2: rb[1], bullet_3: rb[2], bullet_4: rb[3], bullet_5: rb[4] }, // matches recommendation
]
const bSim = simulate('bullets', rec, pcMap, bulletRows)
eq(bSim.count, 2, 'bullets: 2 in scope')
eq(bSim.changed, 1, 'bullets: 1 differs, 1 already matches')

// FBA+FBM pair: ONE ASIN with both SKUs — the push must hit BOTH (the bug fix), not dedup to one.
const pairRows: Row[] = [
  { sku: 'AQS-L-LG-FBA', asin: 'PAIR', title: 'old title' },
  { sku: 'AQS-L-LG', asin: 'PAIR', title: 'old title' }, // FBM twin, same ASIN
]
const pairTitle = simulate('title', rec, pcMap, pairRows)
eq(pairTitle.count, 2, 'broadcast pushes to BOTH the FBA and FBM SKU of one ASIN (no dedup)')
eq(pairTitle.changed, 2, 'both SKUs of the pair differ and will change')
const pairKwMap = new Map<string, string>([['AQS-L-LG-FBA', 'see you later alligator light green lime']])
const pairKw = simulate('keywords', rec, pairKwMap, pairRows)
eq(pairKw.count, 2, 'keywords reach BOTH SKUs of the pair (resolved by ASIN, not just the mapped SKU)')
ok(pairKw.diff.every((d) => d.proposed === 'see you later alligator light green lime'), 'both SKUs of the pair get the same per-color keywords')

// ── 8. cacheUpdateFor: what we write back to listing_content ──────────────────
console.log('8. cacheUpdateFor')
eq(cacheUpdateFor('title', 'New Title'), { title: 'New Title' }, 'title cache update')
eq(cacheUpdateFor('description', '<p>d</p>'), { description: '<p>d</p>' }, 'description cache update')
eq(cacheUpdateFor('keywords', 'kw'), { backend_keywords: 'kw' }, 'keywords cache update')
eq(cacheUpdateFor('bullets', ['b1', 'b2', 'b3']), { bullet_1: 'b1', bullet_2: 'b2', bullet_3: 'b3', bullet_4: null, bullet_5: null }, 'bullets cache update pads to 5')

// ── summary ──────────────────────────────────────────────────────────────────
console.log(`\n=== ${pass} passed, ${fail} failed ===`)
if (fail > 0) { console.error('\nFAILURES:\n' + fails.map((f) => '  - ' + f).join('\n')); process.exit(1) }
console.log('All assertions passed ✓\n')
