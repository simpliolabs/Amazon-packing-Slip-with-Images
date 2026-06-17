import { readFileSync } from 'node:fs'
const j = JSON.parse(readFileSync('rank-fr.json', 'utf8'))
console.log(`rank: analyzed=${j.analyzed} stale=${j.stale} rows=${(j.rows || []).length} coverage=${JSON.stringify(j.coverage)}`)
const gaps = (j.rows || []).filter((r) => !r.youCover)
console.log(`uncovered gaps (${gaps.length}):`)
for (const r of gaps.slice(0, 10)) console.log(`  ${r.actionType} "${r.keyword}" coveredIn=${JSON.stringify(r.coveredIn || [])}`)
const masc = gaps.filter((r) => /\bmens?\b/i.test(r.keyword) && !/\bwom/i.test(r.keyword))
console.log(`MASC-only gaps on this FEMALE listing: ${masc.length} ${JSON.stringify(masc.map((r) => r.keyword))}`)
const rec = JSON.parse(readFileSync('rec-fr2.json', 'utf8')).recommendations
console.log('field_pushed_at:', JSON.stringify(rec && rec.field_pushed_at || {}))
// is "comfort color tshirts" actually in the bullets? (the false-gap check)
const b = (rec?.recommended_bullets || []).join(' || ')
console.log('bullets contain "comfort color":', /comfort colou?r/i.test(b))
