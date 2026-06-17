import { readFileSync } from 'node:fs'
const faith = JSON.parse(readFileSync('ver-faith.json', 'utf8')).recommendations
console.log('=== B0FKKN8XKV (ship-dates discriminator) ===')
console.log('field_pushed_at:', JSON.stringify(faith?.field_pushed_at ?? {}))
console.log('  → keys present:', Object.keys(faith?.field_pushed_at ?? {}).join(', ') || '(NONE — all fields empty)')

const retire = JSON.parse(readFileSync('ver-retire.json', 'utf8')).recommendations
console.log('\n=== B0GQVL3K4B (wrong-wording) ===')
console.log('recommended_title:', retire?.recommended_title)

const intel = JSON.parse(readFileSync('ver-retire-intel.json', 'utf8'))
const kws = intel.allKeywords || intel.topOpportunities || []
console.log('\n=== B0GQVL3K4B intelligence (pollution check) ===')
console.log('total keywords:', kws.length)
const counts = {}
for (const k of kws) counts[k.actionType] = (counts[k.actionType] || 0) + 1
console.log('actionType counts:', JSON.stringify(counts))
const polluted = kws.filter((k) => /star wars|father|vader|luke|your father/i.test(k.keyword))
console.log('STAR-WARS/FATHER pollutants:', polluted.length)
polluted.slice(0, 12).forEach((k) => console.log(`  "${k.keyword}" vol=${k.searchVolume ?? '?'} action=${k.actionType}`))
const retireThemed = kws.filter((k) => /retire|retirement|quit|young|poor/i.test(k.keyword))
console.log('RETIRE-themed (correct):', retireThemed.length)
retireThemed.slice(0, 6).forEach((k) => console.log(`  "${k.keyword}" vol=${k.searchVolume ?? '?'} action=${k.actionType}`))
