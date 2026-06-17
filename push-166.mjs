const BASE = 'https://slip.theceo.store/api/fba/listing-optimizer'
const ASIN = 'B0F86LPSHZ'
const FIELDS = ['Package Level', 'Package Contains SKU', 'Model Number', 'Special Features', 'Item Shape', 'Package Quantity']

const out = []
for (const f of FIELDS) {
  const row = { field: f, push: null, error: null, verify: null }
  try {
    const r = await fetch(`${BASE}/push-content`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parent_asin: ASIN, field: 'details', detail_field: f, confirm: true }),
    })
    const text = await r.text()
    const lines = text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
    const result = lines.find((o) => o.type === 'result') ?? null
    const errs = lines.filter((o) => o.type === 'error')
    row.push = result ? { ok: result.ok ?? true, pushed: result.pushed ?? result.success_count ?? null, failed: result.failed ?? result.fail_count ?? null, summary: result.summary ?? result.message ?? null } : null
    if (!result && !errs.length) row.push = { raw: text.slice(0, 300), status: r.status }
    if (errs.length) row.error = errs.map((e) => e.message ?? JSON.stringify(e)).join(' | ').slice(0, 300)
  } catch (e) { row.error = String(e).slice(0, 200) }
  out.push(row)
  console.log(`pushed: ${f} -> ${row.error ? 'ERROR ' + row.error : JSON.stringify(row.push)}`)
}

// Verify each against LIVE Amazon (listings API read) after all pushes.
for (const row of out) {
  try {
    const u = `${BASE}/verify-push?parent_asin=${ASIN}&field=details&detail_field=${encodeURIComponent(row.field)}`
    const r = await fetch(u)
    const j = await r.json()
    row.verify = { status: r.status, attribute_key: j.attribute_key ?? null, expected: (j.expected ?? '').toString().slice(0, 60), results: (j.results ?? j.skus ?? []).slice(0, 12).map((s) => ({ sku: s.sku, match: s.match ?? s.matches ?? null, live: String(s.current_live ?? s.live ?? '').slice(0, 40) })) }
  } catch (e) { row.verify = { error: String(e).slice(0, 200) } }
}
console.log('\n=== VERIFY (live Amazon read) ===')
for (const row of out) console.log(`${row.field}: ${JSON.stringify(row.verify)}`)
