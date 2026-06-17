import { readFileSync } from 'node:fs'
const v = JSON.parse(readFileSync('v-hl.json', 'utf8'))
console.log(`key=${v.attribute_key} matched=${v.matched}/${v.total} stale=${v.stale}${v.error ? ' ERROR=' + v.error : ''}`)
for (const r of v.results ?? []) console.log(`  ${r.sku}: live="${String(r.currentLive ?? '').slice(0, 95)}" match=${r.matches}`)
