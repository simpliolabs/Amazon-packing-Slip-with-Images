/**
 * Local stress test for src/lib/fba/productDetailAttrs.ts — run with:
 *   npx tsx scripts/stress-product-detail-attrs.ts
 *
 * Mirrors how the push-content route uses the helpers (resolve friendly name → SP-API key
 * → patch value entry → patch path) over synthetic data, so a green run means the detail
 * resolver is correct without touching Amazon or Supabase.
 */
import {
  resolveDetailAttribute, isPushableDetail, unpushableReason,
  normalizeFieldName, buildDetailPatchValue, currentDetailValue,
} from '../src/lib/fba/productDetailAttrs'

let pass = 0, fail = 0
const fails: string[] = []
function ok(cond: boolean, msg: string) {
  if (cond) { pass++ } else { fail++; fails.push(msg); console.error('  ✗ ' + msg) }
}
function eq<T>(a: T, b: T, msg: string) {
  const A = JSON.stringify(a), B = JSON.stringify(b)
  ok(A === B, `${msg}  (got ${A}  expected ${B})`)
}

const MP = 'ATVPDKIKX0DER'

console.log('[1] Normalization handles real-world friendly names')
eq(normalizeFieldName('Material'),       'material',  '"Material" → "material"')
eq(normalizeFieldName('Fit_Type'),       'fit type',  '"Fit_Type" → "fit type"')
eq(normalizeFieldName('Fit-Type'),       'fit type',  '"Fit-Type" → "fit type"')
eq(normalizeFieldName('  Fit   Type  '), 'fit type',  'whitespace collapse')
eq(normalizeFieldName('FABRIC TYPE'),    'fabric type', 'all-caps')
eq(normalizeFieldName(''),               '',          'empty stays empty')

console.log('[2] Broadcast-safe attributes resolve and are pushable')
const broadcast = ['Material', 'Brand', 'Fit Type', 'Fabric Type', 'Style', 'Pattern',
  'Care Instructions', 'Country of Origin', 'Department', 'Target Gender',
  'Connectivity Technology', 'Hardware Interface', 'Manufacturer', 'Theme']
for (const f of broadcast) {
  const a = resolveDetailAttribute(f)
  ok(!!a && a.scope === 'broadcast', `${f} resolves as broadcast`)
  ok(isPushableDetail(f), `${f} is pushable`)
  ok(unpushableReason(f) === null, `${f} has no block reason`)
}

console.log('[3] Per-variant attributes are recognized but BLOCKED')
const perVariant = ['Color', 'Size', 'Capacity', 'Storage Capacity', 'Read Speed',
  'Write Speed', 'Item Dimensions', 'Flash Memory Storage Capacity']
for (const f of perVariant) {
  const a = resolveDetailAttribute(f)
  ok(!!a && a.scope === 'per-variant', `${f} resolves as per-variant`)
  ok(!isPushableDetail(f), `${f} is NOT pushable from parent-level`)
  const r = unpushableReason(f)
  ok(typeof r === 'string' && /per-variant/i.test(r), `${f} explains why blocked`)
}

console.log('[4] Unknown friendly name falls back to manual')
const unknown = 'Some Made Up Attribute'
eq(resolveDetailAttribute(unknown), null, `${unknown} → null`)
ok(!isPushableDetail(unknown), `${unknown} is NOT pushable`)
const ukReason = unpushableReason(unknown)
ok(typeof ukReason === 'string' && /Seller Central/.test(ukReason), `${unknown} explains fallback`)

console.log('[5] Friendly → SP-API key mapping covers the canonical cases')
eq(resolveDetailAttribute('Material')?.spApiKey,            'material',                       'Material → material')
eq(resolveDetailAttribute('Brand')?.spApiKey,               'brand',                          'Brand → brand')
eq(resolveDetailAttribute('Fit Type')?.spApiKey,            'fit_type',                       'Fit Type → fit_type')
eq(resolveDetailAttribute('Care Instructions')?.spApiKey,   'care_instructions',              'Care Instructions → care_instructions')
eq(resolveDetailAttribute('Country of Origin')?.spApiKey,   'country_of_origin',              'Country of Origin → country_of_origin')
eq(resolveDetailAttribute('Hardware Interface')?.spApiKey,  'hardware_interface',             'Hardware Interface → hardware_interface')
eq(resolveDetailAttribute('Capacity')?.spApiKey,            'flash_memory_storage_capacity',  'Capacity → flash_memory_storage_capacity')
eq(resolveDetailAttribute('Storage Capacity')?.spApiKey,    'flash_memory_storage_capacity',  'Storage Capacity → flash_memory_storage_capacity')

console.log('[6] buildDetailPatchValue produces the SP-API shape')
const matAttr = resolveDetailAttribute('Material')!
const vals = buildDetailPatchValue(matAttr, '100% Cotton', MP)
eq(vals.length, 1, 'one entry')
eq(vals[0].value, '100% Cotton', 'value preserved')
eq(vals[0].marketplace_id, MP, 'marketplace_id set')
eq(vals[0].language_tag, 'en_US', 'language_tag defaults en_US')

// Empty values are dropped so callers can early-return without sending a no-op patch.
eq(buildDetailPatchValue(matAttr, '',    MP).length, 0, 'empty string yields no entries')
eq(buildDetailPatchValue(matAttr, '   ', MP).length, 0, 'whitespace-only yields no entries')
eq(buildDetailPatchValue(matAttr, '   100% Cotton   ', MP)[0].value, '100% Cotton', 'trims whitespace')

// Custom language tag still works (not exercised today but supported).
const ja = buildDetailPatchValue(matAttr, 'コットン', MP, 'ja_JP')
eq(ja[0].language_tag, 'ja_JP', 'custom language_tag honored')

console.log('[7] currentDetailValue parses a Listings Items attributes blob')
const blob = { material: [{ value: 'Polyester', marketplace_id: MP, language_tag: 'en_US' }] }
eq(currentDetailValue(blob, 'material'), 'Polyester',  'reads first {value}')
eq(currentDetailValue(blob, 'brand'),    '',           'missing key → empty')
eq(currentDetailValue(null,  'material'), '',          'null blob → empty')
eq(currentDetailValue({},    'material'), '',          'empty blob → empty')
eq(currentDetailValue({ material: [] },    'material'), '', 'empty array → empty')
eq(currentDetailValue({ material: [{}] },  'material'), '', 'missing value field → empty')

// SP-API sometimes returns numeric values for quantity attributes. We stringify so the
// "current vs proposed" comparison in the diff modal works without type juggling.
const numBlob = { number_of_items: [{ value: 3, marketplace_id: MP }] }
eq(currentDetailValue(numBlob, 'number_of_items'), '3', 'coerces number to string')

console.log('[8] End-to-end audit-row simulation (parent shared + per-variant mix)')
// Simulates what the audit emits for a real SD-card listing — a mix of pushable (Brand,
// Hardware Interface, Connectivity Technology) and per-variant (Capacity, Read Speed).
const auditOutput = [
  { field_name: 'Brand',                     recommended_value: 'DAFEI' },
  { field_name: 'Hardware Interface',        recommended_value: 'microSDXC' },
  { field_name: 'Connectivity Technology',   recommended_value: 'USB' },
  { field_name: 'Capacity',                  recommended_value: '128 GB' },          // per-variant
  { field_name: 'Read Speed',                recommended_value: '170 MB/s' },        // per-variant
  { field_name: 'Item Warranty Description', recommended_value: '1-year limited' },  // unmapped
]
const pushable = auditOutput.filter((d) => isPushableDetail(d.field_name))
const blocked = auditOutput.filter((d) => !isPushableDetail(d.field_name))
eq(pushable.length, 3, 'Brand + Hardware Interface + Connectivity Technology are pushable')
eq(blocked.length, 3,  'Capacity + Read Speed + Warranty Description are blocked')
ok(pushable.every((d) => unpushableReason(d.field_name) === null), 'pushable rows: no reason')
ok(blocked.every((d) => unpushableReason(d.field_name) !== null), 'blocked rows: every one has a reason')

// Each pushable row should produce a complete SP-API patch path + value array.
for (const row of pushable) {
  const attr = resolveDetailAttribute(row.field_name)!
  const v = buildDetailPatchValue(attr, row.recommended_value, MP)
  ok(v.length === 1 && v[0].value === row.recommended_value, `${row.field_name}: patch entry built`)
  ok(attr.spApiKey.length > 0 && /^[a-z_]+$/.test(attr.spApiKey), `${row.field_name}: spApiKey looks like a real SP-API key`)
}

console.log(`\n→ ${pass} passed, ${fail} failed`)
if (fail > 0) {
  console.error('\nFAILURES:')
  for (const f of fails) console.error('  - ' + f)
  process.exit(1)
}
