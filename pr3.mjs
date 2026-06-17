import { readFileSync } from 'node:fs'
const r = JSON.parse(readFileSync('rec-praise2.json', 'utf8')).recommendations
console.log('TITLE:', r?.recommended_title)
console.log('len:', (r?.recommended_title || '').length)
console.log('B1:', (r?.recommended_bullets || [])[0])
console.log('B2:', (r?.recommended_bullets || [])[1])
console.log('design source?', JSON.stringify(r?.titleDebug || 'none'))
