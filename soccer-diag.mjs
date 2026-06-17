import { readFileSync } from 'node:fs'
const intel = JSON.parse(readFileSync('pool-soccer.json', 'utf8'))
const src = JSON.parse(readFileSync('src-soccer.json', 'utf8'))

console.log('=== B0GVW83L1P design sources ===')
console.log('canonical_title:', src.canonical_title)
console.log('vision_identity:', JSON.stringify(src.vision_identity, null, 2))

const kws = intel.allKeywords || []
console.log(`\n=== Intelligence pool: ${kws.length} keywords total ===`)
const counts = {}
for (const k of kws) counts[k.actionType] = (counts[k.actionType] || 0) + 1
console.log('actionType counts:', JSON.stringify(counts))

// Categorize by theme
const isSoccer = (s) => /soccer|world cup|cup|football|f[uú]tbol|fifa/i.test(s)
const is2026Family = (s) => /family|reunion|cruise|vacation|disney|matching|graduate|graduation|dad|mom|holiday|christmas|easter|halloween|thanksgiving/i.test(s) && !isSoccer(s)

const soccer = kws.filter((k) => isSoccer(k.keyword))
const polluted = kws.filter((k) => is2026Family(k.keyword))
const other = kws.filter((k) => !isSoccer(k.keyword) && !is2026Family(k.keyword))

console.log(`\nSOCCER-themed (correct): ${soccer.length}`)
soccer.slice(0, 6).forEach((k) => console.log(`  "${k.keyword}" vol=${k.searchVolume} action=${k.actionType}`))
console.log(`\nFAMILY/2026-graduate POLLUTION: ${polluted.length}`)
polluted.slice(0, 12).forEach((k) => console.log(`  "${k.keyword}" vol=${k.searchVolume} action=${k.actionType}`))
console.log(`\nOTHER (${other.length}):`)
other.slice(0, 8).forEach((k) => console.log(`  "${k.keyword}" vol=${k.searchVolume} action=${k.actionType}`))
