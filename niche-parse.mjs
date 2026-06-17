import { readFileSync } from 'node:fs'
const j = JSON.parse(readFileSync('niche-test.json', 'utf8'))
console.log('=== nicheEnrich result ===')
console.log(JSON.stringify(j.nicheEnrich, null, 2))
const kws = j.allKeywords || j.topOpportunities || []
console.log(`\n=== total keywords returned: ${kws.length} ===`)
const faith = kws.filter((k) => /christ|faith|bible|psalm|praise|jesus|god|religi|verse|scripture|blessed/i.test(k.keyword))
console.log(`FAITH/CHRISTIAN keywords now present: ${faith.length}`)
faith.slice(0, 25).forEach((k) => console.log(`  "${k.keyword}" vol=${k.searchVolume ?? k.volume ?? '?'} action=${k.actionType ?? '?'}`))
if (faith.length === 0) {
  console.log('  (none — sample of what IS there:)')
  kws.slice(0, 10).forEach((k) => console.log(`  "${k.keyword}"`))
}
