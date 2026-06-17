import { readFileSync } from 'node:fs'

for (const f of ['verify-neck.json', 'verify-closure.json', 'verify-sleeve.json']) {
  let j
  try { j = JSON.parse(readFileSync(f, 'utf8')) } catch (e) { console.log(`${f}: UNPARSEABLE — ${readFileSync(f, 'utf8').slice(0, 200)}`); continue }
  if (j.error) { console.log(`${f}: ERROR ${j.error}`); continue }
  console.log(`\n=== ${f} — field "${j.detail_field}" -> attribute_key "${j.attribute_key}" ===`)
  console.log(`total ${j.total} | matched ${j.matched} | stale ${j.stale} | unknown ${j.unknown}`)
  const rs = j.results ?? []
  const parent = rs.find((r) => r.isParent)
  if (parent) console.log(`PARENT ${parent.sku}: live="${parent.currentLive}" expected="${parent.expected}" matches=${parent.matches} lastUpdated=${parent.lastUpdatedDate}`)
  const liveVals = {}
  for (const r of rs) { const k = r.currentLive || '(empty)'; liveVals[k] = (liveVals[k] ?? 0) + 1 }
  console.log('live value distribution:', JSON.stringify(liveVals))
  const expectedVals = [...new Set(rs.map((r) => r.expected))]
  console.log('expected value(s):', JSON.stringify(expectedVals))
  // sample 3 non-matching children
  const bad = rs.filter((r) => !r.matches && !r.isParent).slice(0, 3)
  for (const b of bad) console.log(`  child ${b.sku}: live="${b.currentLive}" lastUpdated=${b.lastUpdatedDate}`)
}
