import fs from 'fs'
const file = process.argv[2] || './scores-before.json'
const d = JSON.parse(fs.readFileSync(file, 'utf8'))
const arr = d.scores || []
const row = arr.find((r) => r.parent_asin === 'B0G884ZJ27' || r.asin === 'B0G884ZJ27')
if (!row) {
  console.log('B0G884ZJ27 not found. First parents:', arr.slice(0, 8).map((r) => r.parent_asin || r.asin).join(', '))
} else {
  const keys = ['title_score', 'bullet_score', 'keyword_score', 'aplus_score', 'description_score', 'features_score', 'overall_score']
  console.log('B0G884ZJ27 SCORES (raw/25):', keys.filter((k) => k in row).map((k) => `${k}=${row[k]}`).join('  '))
  const iss = row.issues
  if (Array.isArray(iss)) {
    console.log(`ISSUES (${iss.length}):`)
    for (const i of iss) console.log(`  [${i.field}/${i.severity}] ${String(i.message).slice(0, 110)}`)
    const dn = iss.filter((i) => /design name/i.test(i.message || ''))
    console.log('>>> DESIGN-NAME (#92) cohesion issues:', dn.length)
  } else {
    console.log('issues is', typeof iss, '— row keys:', Object.keys(row).join(', '))
  }
}
