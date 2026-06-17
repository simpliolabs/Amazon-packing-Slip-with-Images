import { readFileSync } from 'node:fs'

// regen stream tail — did the partial regen complete or throw the honest-failure error?
try {
  const lines = readFileSync('regen209.ndjson', 'utf8').trim().split('\n')
  const events = lines.map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  const err = events.find((e) => e.type === 'error')
  const last = events[events.length - 1]
  console.log(`regen events: ${events.length}; last type: ${last?.type}`)
  if (err) console.log('REGEN ERROR:', err.error)
} catch (e) { console.log('regen stream unreadable:', String(e).slice(0, 120)) }

const j = JSON.parse(readFileSync('kw-final.json', 'utf8'))
const rows = (j.diff ?? []).filter((r) => r.proposed)
const proposed = rows.map((r) => String(r.proposed))
const uniq = [...new Set(proposed)]
const bytes = proposed.map((p) => Buffer.byteLength(p, 'utf8'))
console.log(`\nrows ${rows.length} | changed ${j.changed} | unique strings ${uniq.length}`)
console.log(`bytes min ${Math.min(...bytes)} max ${Math.max(...bytes)} avg ${Math.round(bytes.reduce((a, b) => a + b, 0) / bytes.length)}`)

const scan = (name, re) => {
  const hits = rows.filter((r) => re.test(r.proposed))
  console.log(`${name}: ${hits.length}${hits.length ? ` (e.g. ${hits[0].sku})` : ''}`)
}
scan('brand "ceo"', /\bceo\b/i)
scan('stopwords (a/an/and/by/for/of/the/with)', /\b(?:a|an|and|by|for|of|the|with)\b/i)
scan('masc tokens', /\b(?:men|mens|man|male|boys?)\b/i)
scan('ungrounded style (cropped|pocket|boxy|oversized|plain|blank|solid)', /\b(?:cropped|crop|pocket|boxy|oversized|oversize|plain|blank|solid)\b/i)
scan('garment contradictions (tank|hoodie|sweatshirt|pullover)', /\b(?:tank|hoodie|sweatshirt|pullover)\b/i)
scan('edge connector dangling', /\b(?:for|with|and|the|of)\s*$/i)
scan('single stray letter', /(?:^|\s)[a-su-z](?:\s|$)/i)   // allows 't'? no — flags ANY single letter except none; review hits manually
scan('design "darlin"', /\bdarlin\b/i)
scan('"country"', /\bcountry\b/i)
scan('"western"', /\bwestern\b/i)

// color leakage: black/white in children whose own SKU is NOT that color
const offColor = rows.filter((r) => /\b(?:black|white)\b/i.test(r.proposed) && !/BLK|WHT|WHITE|BLACK/i.test(r.sku))
console.log(`black/white in non-black/white SKUs: ${offColor.length}${offColor.length ? ` (e.g. ${offColor[0].sku})` : ''}`)

// per-color tails — show 4 samples ends
for (const r of rows.slice(0, 4)) console.log(`  ${r.sku}: …${String(r.proposed).slice(-60)}`)
console.log(`\nfull sample [0] (${bytes[0]}B):\n${proposed[0]}`)
