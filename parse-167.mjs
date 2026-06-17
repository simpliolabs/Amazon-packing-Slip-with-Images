import { readFileSync } from 'node:fs'
const APPAREL = /\b(t-?shirts?|tees?|graphic tee|hoodie|sweatshirt|apparel|clothing|comfort colors|unisex)\b/i
for (const [label, file, wantApparel] of [['STICKY B0F86LPSHZ', 'regen-167-sn.ndjson', false], ['GATOR B0G884ZJ27', 'regen-167-gator.ndjson', true]]) {
  console.log('==== ' + label + ' ====')
  let result = null
  const errors = []
  for (const l of readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
    try { const o = JSON.parse(l); if (o.type === 'result') result = o; if (o.type === 'error') errors.push(o.message ?? JSON.stringify(o)) } catch {}
  }
  if (!result) { console.log('NO RESULT; errors:', errors.join(' | ').slice(0, 300)); continue }
  const r = result.recommendations ?? result
  const title = r.recommended_title ?? ''
  console.log(`TITLE (${title.length} chars, limit 75): ${title}`)
  console.log(`  over75=${title.length > 75} | apparel-terms=${APPAREL.test(title)} (expected ${wantApparel})`)
  const pct = r.per_child_titles ?? []
  if (pct.length) {
    const over = pct.filter((p) => (p.title ?? '').length > 75)
    console.log(`  per-child titles: ${pct.length}, over75: ${over.length}${over.length ? ' -> ' + over.map((p) => p.sku + ':' + p.title.length).join(', ') : ''}`)
  }
  const pdi = r.product_details_improvements ?? []
  const hl = pdi.find((p) => /highlight/i.test(String(p.field_name)))
  console.log(`  details rows: ${pdi.length} | item-highlights row: ${hl ? 'PRESENT val="' + String(hl.recommended_value).slice(0, 80) + '"' : 'absent (correct until Amazon ships the attr)'}`)
  const bullets = r.recommended_bullets ?? []
  console.log(`  bullets: ${bullets.length}, contaminated: ${bullets.filter((b) => !wantApparel && APPAREL.test(b)).length}`)
  console.log(`  designName: ${r.debug?.designName} | titleProblems: ${JSON.stringify(r.debug?.titleProblems ?? [])}`)
  console.log('')
}
