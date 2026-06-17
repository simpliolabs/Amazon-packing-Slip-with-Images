import fs from 'fs'
function bulletsMsg(file) {
  const d = JSON.parse(fs.readFileSync(file, 'utf8'))
  const row = (d.scores || []).find((r) => r.parent_asin === 'B0G884ZJ27' || r.asin === 'B0G884ZJ27')
  const iss = (row?.issues || []).find((i) => i.field === 'bullets' && /high-opportunity/.test(i.message || ''))
  return iss ? iss.message : '(no bullets opportunity issue)'
}
console.log('BEFORE (#160 legacy DB set):\n ', bulletsMsg('./scores-before.json'))
console.log('\nAFTER (#161 plan set):\n ', bulletsMsg('./scores-after.json'))
