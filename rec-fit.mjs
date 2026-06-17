import { readFileSync } from 'node:fs'
const j = JSON.parse(readFileSync('rec-gator.json', 'utf8'))
const rec = j.recommendations ?? j
const pdi = rec.product_details_improvements ?? []
console.log('rows:', pdi.length)
for (const p of pdi) {
  console.log(`- [${p.field_name}] key=${p.sp_api_key ?? '-'} pushable=${p.pushable} rec="${String(p.recommended_value ?? '').slice(0, 50)}" cur="${String(p.current_value ?? '').slice(0, 50)}" enum=${p.is_enum ? (p.enum_valid ? 'valid' : 'INVALID') : 'free'}`)
}
const fit = pdi.find((p) => /fit/i.test(String(p.field_name)))
console.log('\nFIT ROW full:', JSON.stringify(fit))
