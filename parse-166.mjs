import { readFileSync } from 'node:fs'
const lines = readFileSync('regen-166-sn.ndjson', 'utf8').split('\n').filter(Boolean)
let result = null, errors = []
for (const l of lines) {
  try {
    const o = JSON.parse(l)
    if (o.type === 'result') result = o
    if (o.type === 'error') errors.push(o)
  } catch {}
}
if (!result) { console.log('NO RESULT. errors:', JSON.stringify(errors)); process.exit(1) }
const r = result.recommendations ?? result
const APPAREL = /\b(t-?shirts?|tees?|graphic tee|hoodie|sweatshirt|apparel|clothing|comfort colors|unisex|men and women|fabric|cotton)\b/i
const title = r.recommended_title ?? ''
console.log('TITLE (' + title.length + ' chars):', title)
console.log('TITLE apparel-contaminated:', APPAREL.test(title))
console.log('')
const bullets = r.recommended_bullets ?? []
bullets.forEach((b, i) => console.log(`B${i + 1} contaminated=${APPAREL.test(b)}: ${b.slice(0, 110)}`))
console.log('')
const pdi = r.product_details_improvements ?? []
console.log('PRODUCT DETAILS (' + pdi.length + ' rows):')
for (const p of pdi) {
  console.log(` - ${p.field_name} | pushable=${p.pushable} | key=${p.sp_api_key ?? '-'} | scope=${p.attr_scope ?? '-'} | enum=${p.is_enum ? (p.enum_valid ? 'valid' : 'INVALID') : 'free'} | val="${String(p.recommended_value).slice(0, 60)}"`)
}
console.log('')
const desc = (r.recommended_description ?? '').replace(/<[^>]+>/g, ' ')
console.log('DESC contaminated:', APPAREL.test(desc), '| snippet:', desc.slice(0, 160))
const dbg = r.debug ?? {}
console.log('debug designName:', dbg.designName, '| titleProblems:', JSON.stringify(dbg.titleProblems ?? []))
