import { readFileSync } from 'node:fs'
const v = JSON.parse(readFileSync('v-fit.json', 'utf8'))
console.log(`attribute_key=${v.attribute_key} total=${v.total} matched=${v.matched} stale=${v.stale}${v.error ? ' ERROR=' + v.error : ''}`)
const rows = v.results ?? []
const byLive = {}
for (const r of rows) {
  const k = `live="${String(r.currentLive ?? '')}" expected="${String(r.expected ?? '')}" match=${r.matches}`
  byLive[k] = (byLive[k] ?? 0) + 1
}
for (const [k, n] of Object.entries(byLive)) console.log(`  ${n} SKUs -> ${k}`)
console.log('sample:', JSON.stringify(rows[0]))
