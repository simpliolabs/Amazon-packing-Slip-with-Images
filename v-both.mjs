import { readFileSync } from 'node:fs'
const s = JSON.parse(readFileSync('score-gator2.json', 'utf8'))
console.log('=== SCORE-TITLE (typed 74c draft) ===')
console.log(`titleScore=${s.titleScore}/25 overall=${s.overallScore} len=${s.length} suppressionRisk=${s.suppressionRisk}`)
console.log('ruleProblems:', JSON.stringify(s.ruleProblems))
for (const i of s.titleIssues ?? []) console.log(' issue:', i.severity, '|', String(i.message).slice(0, 140))
if (!(s.titleIssues ?? []).length) console.log(' issues: none')

const v = JSON.parse(readFileSync('v-fit2.json', 'utf8'))
console.log('\n=== VERIFY-PUSH (Fit Type) ===')
console.log(`matched=${v.matched}/${v.total} stale=${v.stale} unknown=${v.unknown}`)
const bySrc = {}
for (const r of v.results ?? []) {
  const k = `${r.matches ? 'MATCH' : r.expected ? 'stale' : 'no-expectation'} src=${r.expectedSource} live="${String(r.currentLive).slice(0, 20)}" exp="${String(r.expected).slice(0, 20)}"`
  bySrc[k] = (bySrc[k] ?? 0) + 1
}
for (const [k, n] of Object.entries(bySrc)) console.log(`  ${n} SKUs -> ${k}`)
