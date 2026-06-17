import fs from 'fs'
const r = JSON.parse(fs.readFileSync('./regen-161.ndjson', 'utf8').split('\n').filter(Boolean).reverse().find(l => { try { return JSON.parse(l).type === 'result' } catch { return 0 } })).recommendations
const pdi = r.product_details_improvements || []
const empty = (v) => !v || !String(v).trim()
const trueGaps = pdi.filter(p => empty(p.current_value) || (p.is_enum === true && p.enum_valid === false))
console.log('=== FEATURES MATERIALITY (#85/#160) fact-check ===')
console.log('total product_details_improvements:', pdi.length)
console.log('TRUE gaps (empty current_value OR enum-invalid):', trueGaps.length)
console.log('  → already-filled (NOT a gap):', pdi.length - trueGaps.length)
console.log('\nper-field:')
for (const p of pdi) {
  const gap = empty(p.current_value) || (p.is_enum === true && p.enum_valid === false)
  console.log(`  ${gap ? 'GAP ' : 'set '} ${p.field_name}: current=${JSON.stringify(p.current_value)} ${p.is_enum ? `[enum valid=${p.enum_valid}]` : ''}`)
}
