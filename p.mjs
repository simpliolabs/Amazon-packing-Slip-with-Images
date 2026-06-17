import { readFileSync } from 'node:fs'
const j = JSON.parse(readFileSync('vf-b0fr-sleeve.json', 'utf8'))
if (j.error) { console.log('ERROR', j.error) }
else {
  console.log(`Sleeve: matched ${j.matched} / stale ${j.stale} / total ${j.total} (attr ${j.attribute_key})`)
  for (const r of (j.results || []).slice(0, 4)) console.log(`  ${r.sku}: live="${r.currentLive}" expected="${r.expected}" matches=${r.matches}`)
}
