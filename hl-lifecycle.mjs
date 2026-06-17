// Item Highlight full lifecycle on B0F86LPSHZ: parse regen -> preview -> PUSH -> verify.
import { readFileSync } from 'node:fs'
const BASE = 'https://slip.theceo.store/api/fba/listing-optimizer'
const ASIN = 'B0F86LPSHZ'

// 1) The regen's highlight row (deterministic post-#169).
let result = null
for (const l of readFileSync('regen-169-sn.ndjson', 'utf8').split('\n').filter(Boolean)) {
  try { const o = JSON.parse(l); if (o.type === 'result') result = o } catch {}
}
const r = result?.recommendations ?? result ?? {}
const title = r.recommended_title ?? ''
console.log(`TITLE (${title.length}c): ${title}`)
const pdi = r.product_details_improvements ?? []
const hl = pdi.find((p) => /highlight|differentiation/i.test(String(p.field_name)))
if (!hl) { console.log('NO HIGHLIGHT ROW. rows:', pdi.map((p) => p.field_name).join(' | ')); process.exit(1) }
console.log(`HL ROW: field=[${hl.field_name}] key=${hl.sp_api_key} pushable=${hl.pushable} len=${String(hl.recommended_value).length}`)
console.log(`HL VALUE: ${hl.recommended_value}`)
const COMMA_FORMAT = /^[^;]+(, [^;]+)+$/.test(String(hl.recommended_value))
console.log(`comma-separated (no semicolons): ${COMMA_FORMAT}`)

// 2) Read-only preview through the real push GET.
const pv = await fetch(`${BASE}/push-content?parent_asin=${ASIN}&field=details&detail_field=${encodeURIComponent(hl.field_name)}`)
const pvj = await pv.json().catch(() => ({}))
console.log(`\nPREVIEW HTTP ${pv.status}: proposed="${(pvj.proposedValue ?? '').toString().slice(0, 130)}" changed=${pvj.changed ?? pvj.diff?.length ?? '?'}${pvj.error ? ' ERROR=' + pvj.error : ''}`)
if (!pv.ok) process.exit(2)

// 3) PUSH (PO-authorized this turn: "PUSH & verify for the new highlights field").
const resp = await fetch(`${BASE}/push-content`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ parent_asin: ASIN, field: 'details', detail_field: hl.field_name, confirm: true }),
})
const text = await resp.text()
let final = null; const errs = []
for (const l of text.split('\n').filter(Boolean)) {
  try { const o = JSON.parse(l); if (o.type === 'result') final = o; if (o.type === 'error') errs.push(o.error) } catch {}
}
console.log(`\nPUSH: ${final ? `pushed=${final.pushed}/${final.total} failed=${final.failed} — ${final.message}` : 'NO RESULT'}${errs.length ? ' | errors: ' + errs.join(' ; ').slice(0, 300) : ''}`)

// 4) VERIFY — read the live value back from Amazon.
const v = await fetch(`${BASE}/verify-push?parent_asin=${ASIN}&field=details&detail_field=${encodeURIComponent(hl.field_name)}`)
const vj = await v.json().catch(() => ({}))
console.log(`\nVERIFY HTTP ${v.status}: key=${vj.attribute_key} matched=${vj.matched}/${vj.total} stale=${vj.stale}`)
for (const row of (vj.results ?? []).slice(0, 12)) {
  console.log(`  ${row.sku}: live="${String(row.currentLive ?? '').slice(0, 90)}" match=${row.matches}`)
}
