// Unit test: composite-attribute shape derivation + nested patch build + deep read.
// Runs against the COMPILED real code (tmp-shape-test), not a reimplementation.
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const ptd = require('./tmp-shape-test/productTypeDefinitions.js')
const pda = require('./tmp-shape-test/productDetailAttrs.js')

let pass = 0, fail = 0
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want)
  if (g === w) { pass++; console.log(`  ok  ${name}`) }
  else { fail++; console.log(`  FAIL ${name}\n    got  ${g}\n    want ${w}`) }
}

// ── 1. SHIRT-style `neck`: composite, enum nested under neck_style.value ──
const neckSchema = {
  type: 'array',
  items: {
    type: 'object',
    required: ['marketplace_id'],
    properties: {
      marketplace_id: { type: 'string' },
      neck_size: { type: 'object', properties: { value: { type: 'number' }, unit: { type: 'string', enum: ['inches', 'centimeters'] } } },
      neck_style: { type: 'object', properties: { value: { type: 'string', enum: ['Crew Neck', 'V Neck'], enumNames: [] }, language_tag: { type: 'string' } } },
    },
  },
}
const neckShape = ptd.analyzeDetailValueShape(neckSchema)
eq('neck path', neckShape.path, ['neck_style', 'value'])
eq('neck languageTagAt', neckShape.languageTagAt, [false, true])
eq('neck hasMarketplaceId', neckShape.hasMarketplaceId, true)
eq('neck built patch', ptd.buildShapedDetailValue(neckShape, 'Crew Neck', 'ATVPDKIKX0DER'),
  [{ neck_style: { value: 'Crew Neck', language_tag: 'en_US' }, marketplace_id: 'ATVPDKIKX0DER' }])

// neck_size listed FIRST must not steal the path (number value skipped, unit enum skipped)
const neckSchemaReordered = JSON.parse(JSON.stringify(neckSchema))
neckSchemaReordered.items.properties = {
  neck_size: neckSchema.items.properties.neck_size,
  neck_style: neckSchema.items.properties.neck_style,
  marketplace_id: { type: 'string' },
}
eq('neck path (size first)', ptd.analyzeDetailValueShape(neckSchemaReordered).path, ['neck_style', 'value'])

// ── 2. sleeve variant: enum directly on `type` (no value wrapper) ──
const sleeveSchema = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      marketplace_id: { type: 'string' },
      type: { type: 'string', enum: ['short_sleeve', 'long_sleeve', '3_4_sleeve'] },
    },
  },
}
const sleeveShape = ptd.analyzeDetailValueShape(sleeveSchema)
eq('sleeve path', sleeveShape.path, ['type'])
eq('sleeve built patch', ptd.buildShapedDetailValue(sleeveShape, 'short_sleeve', 'ATVPDKIKX0DER'),
  [{ type: 'short_sleeve', marketplace_id: 'ATVPDKIKX0DER' }])

// sleeve with nested type.value (the other common layout)
const sleeveSchema2 = {
  type: 'array',
  items: { type: 'object', properties: {
    marketplace_id: { type: 'string' },
    type: { type: 'object', properties: { value: { type: 'string', enum: ['short_sleeve'] }, language_tag: { type: 'string' } } },
  } },
}
eq('sleeve2 built patch', ptd.buildShapedDetailValue(ptd.analyzeDetailValueShape(sleeveSchema2), 'short_sleeve', 'M'),
  [{ type: { value: 'short_sleeve', language_tag: 'en_US' }, marketplace_id: 'M' }])

// ── 3. flat attribute (fit_type): path must be ['value'] → callers bypass to legacy ──
const fitSchema = {
  type: 'array',
  items: { type: 'object', properties: {
    value: { type: 'string', enum: ['Relaxed', 'Slim'] },
    marketplace_id: { type: 'string' }, language_tag: { type: 'string' },
  } },
}
eq('flat path is [value]', ptd.analyzeDetailValueShape(fitSchema).path, ['value'])

// ── 4. deep read: currentDetailValue sees nested + flat + plumbing-only ──
eq('read flat', pda.currentDetailValue({ fit_type: [{ value: 'Relaxed' }] }, 'fit_type'), 'Relaxed')
eq('read nested value', pda.currentDetailValue({ neck: [{ neck_style: { value: 'Crew Neck' }, marketplace_id: 'X' }] }, 'neck'), 'Crew Neck')
eq('read direct sub-string', pda.currentDetailValue({ sleeve: [{ type: 'short_sleeve', marketplace_id: 'X' }] }, 'sleeve'), 'short_sleeve')
eq('read plumbing-only is empty', pda.currentDetailValue({ neck: [{ marketplace_id: 'ATVPDKIKX0DER', language_tag: 'en_US' }] }, 'neck'), '')
eq('read absent', pda.currentDetailValue({}, 'neck'), '')
eq('read nested with unit noise', pda.currentDetailValue({ neck: [{ neck_size: { value: '16', unit: 'inches' }, neck_style: { value: 'Crew Neck' } }] }, 'neck'), '16')

// ── 5. display prettifier (mirror of page.tsx helper) ──
function prettyDetailValue(value, accepted) {
  const v = (value ?? '').trim()
  if (!v || !/^[a-z0-9]+(?:_[a-z0-9]+)+$/.test(v)) return v
  const squash = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
  const hit = (accepted ?? []).find((a) => squash(a) === squash(v))
  if (hit) return hit
  return v.split('_').map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(' ')
}
eq('pretty exact label', prettyDetailValue('short_sleeve', ['Long Sleeve', 'Short Sleeve']), 'Short Sleeve')
eq('pretty slash label', prettyDetailValue('3_4_sleeve', ['3/4 Sleeve']), '3/4 Sleeve')
eq('pretty fallback titlecase', prettyDetailValue('short_sleeve'), 'Short Sleeve')
eq('pretty human passthrough', prettyDetailValue('Pull On', ['Pull On']), 'Pull On')
eq('pretty single word passthrough', prettyDetailValue('polyester'), 'polyester')

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
