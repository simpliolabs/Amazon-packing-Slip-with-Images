import { readFileSync } from 'node:fs'

// ── new keyword diff after the PO's partial regen ──
const j = JSON.parse(readFileSync('kw-after-regen.json', 'utf8'))
const rows = j.diff ?? []
console.log(`kw diff: rows=${rows.length} changed=${j.changed}`)
const proposed = rows.map((r) => r.proposed ?? '')
const uniq = [...new Set(proposed)]
console.log(`unique proposed strings: ${uniq.length}`)
const bytes = proposed.map((p) => Buffer.byteLength(p, 'utf8'))
console.log(`proposed bytes: min=${Math.min(...bytes)} max=${Math.max(...bytes)} avg=${Math.round(bytes.reduce((a, b) => a + b, 0) / bytes.length)}`)
console.log(`sample [0] (${bytes[0]}B): "${proposed[0]}"`)
if (uniq.length > 1) console.log(`sample other: "${uniq[1].slice(0, 160)}"`)
const masc = proposed.filter((p) => /\bm[ae]ns?\b|\bmale\b|\bboys?\b/i.test(p)).length
const fem = proposed.filter((p) => /\bwom[ae]ns?\b|\bgirls?\b|\bher\b|\bladies\b/i.test(p)).length
const country = proposed.filter((p) => /country/i.test(p)).length
const danglingFor = proposed.filter((p) => /\bfor\s*$/i.test(p)).length
console.log(`masc=${masc} fem=${fem} country=${country} endsWithFor=${danglingForCount(proposed)}`)
function danglingForCount(arr) { return arr.filter((p) => /\b(?:for|with|and|the)\s*$/i.test(p)).length }

// ── post-deploy composite shape checks ──
for (const f of ['dbg-neck2.json', 'dbg-closure2.json', 'dbg-sleeve2.json']) {
  try {
    const d = JSON.parse(readFileSync(f, 'utf8'))
    console.log(`\n${f}: ${d.detailField} -> ${d.spApiKey} (via ${d.resolvedVia})`)
    console.log(`  valueShape: ${JSON.stringify(d.valueShape)}`)
    console.log(`  samplePatchValue: ${JSON.stringify(d.samplePatchValue)}`)
    console.log(`  enum values: ${JSON.stringify((d.result?.values ?? []).slice(0, 8))}`)
    console.log(`  enum names:  ${JSON.stringify((d.result?.names ?? []).slice(0, 8))}`)
  } catch (e) { console.log(`${f}: unreadable — ${String(e).slice(0, 120)}`) }
}
