import { readFileSync } from 'node:fs'
const r = JSON.parse(readFileSync('rec-now.json', 'utf8')).recommendations
if (!r) { console.log('NO rec'); process.exit(0) }
console.log('=== B0FKKN8XKV current state ===')
console.log('generated_at:', r.generated_at)
console.log('TITLE:', r.recommended_title)
console.log('len:', (r.recommended_title || '').length)
const blob = (r.recommended_bullets || []).join(' ').toLowerCase()
console.log('"comfort colors" count in bullets:', (blob.match(/comfort colors?/g) || []).length)
console.log('"christian" in bullets:', /christian/i.test(blob))
console.log('"psalm" in bullets:', /psalm/i.test(blob))
console.log('DESCRIPTION len:', (r.recommended_description || '').length)
console.log('desc head:', (r.recommended_description || '').slice(0, 160))
const pd = r.product_details_improvements || []
console.log('product_details_improvements COUNT:', pd.length)
pd.slice(0, 12).forEach((p) => console.log('  ', p.field_name || '?', '=', p.recommended_value || '?'))
const ap = r.action_plan || []
console.log('action_plan items:', ap.length)
ap.forEach((it) => console.log('  ', it.element, ':', it.verdict, '— priority', it.priority))
