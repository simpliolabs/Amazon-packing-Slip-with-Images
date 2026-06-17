import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const ptd = require('./tmp-shape-test2/productTypeDefinitions.js')

let pass = 0, fail = 0
const eq = (name, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; console.log(`  ok  ${name}`) }
  else { fail++; console.log(`  FAIL ${name}\n    got  ${JSON.stringify(got)}\n    want ${JSON.stringify(want)}`) }
}

// ── The EXACT SHIRT `neck` subschema Amazon returned (2026-06-12) ──
const neckNode = {
  type: 'array',
  items: {
    type: 'object', required: [],
    properties: {
      neck_style: {
        type: 'array', minItems: 1, selectors: ['language_tag'],
        items: {
          type: 'object', required: ['language_tag', 'value'],
          properties: {
            value: { type: 'string', anyOf: [{ type: 'string' }, { enum: ['Crew Neck', 'V-Neck'], type: 'string', enumNames: ['Crew Neck', 'V-Neck'] }], title: 'Neck Style' },
            language_tag: { $ref: '#/$defs/language_tag' },
          },
          additionalProperties: false,
        },
        title: 'Neck Style',
      },
      marketplace_id: { $ref: '#/$defs/marketplace_id' },
    },
    additionalProperties: false,
  },
  title: 'Neck', selectors: ['marketplace_id'],
}

const shape = ptd.analyzeDetailValueShape(neckNode)
console.log('derived shape:', JSON.stringify(shape))
eq('path', shape.path, ['neck_style', 'value'])
eq('languageTagAt', shape.languageTagAt, [false, true])
eq('isArrayAt (neck_style is array)', shape.isArrayAt, [true, false])
eq('hasMarketplaceId', shape.hasMarketplaceId, true)

// THE payload that must match Amazon's schema exactly:
eq('built payload', ptd.buildShapedDetailValue(shape, 'Crew Neck', 'ATVPDKIKX0DER'),
  [{ neck_style: [{ value: 'Crew Neck', language_tag: 'en_US' }], marketplace_id: 'ATVPDKIKX0DER' }])

// Variants — shaped (correct array form) first; old object form last
const vars = ptd.buildShapedDetailValueVariants(shape, 'Crew Neck', 'ATVPDKIKX0DER')
console.log('\nvariant forms:')
for (const v of vars) console.log(`  ${v.id}: ${JSON.stringify(v.value)}`)
eq('shaped is the correct array form (first)', vars[0].value,
  [{ neck_style: [{ value: 'Crew Neck', language_tag: 'en_US' }], marketplace_id: 'ATVPDKIKX0DER' }])
eq('all variant ids', vars.map((v) => v.id), ['shaped', 'shaped-no-lang', 'direct-leaf', 'no-array'])
eq('direct-leaf is array of bare value', vars.find((v) => v.id === 'direct-leaf').value,
  [{ neck_style: ['Crew Neck'], marketplace_id: 'ATVPDKIKX0DER' }])
eq('no-array is the old (rejected) object form', vars.find((v) => v.id === 'no-array').value,
  [{ neck_style: { value: 'Crew Neck', language_tag: 'en_US' }, marketplace_id: 'ATVPDKIKX0DER' }])

// ── A FLAT attr (fit_type): value directly in the array item, no intermediate array ──
const fitNode = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      value: { type: 'string', enum: ['Relaxed', 'Slim'] },
      marketplace_id: { $ref: '#/$defs/marketplace_id' },
      language_tag: { $ref: '#/$defs/language_tag' },
    },
  },
}
const fitShape = ptd.analyzeDetailValueShape(fitNode)
eq('flat path [value]', fitShape.path, ['value'])
eq('flat isArrayAt [false]', fitShape.isArrayAt, [false])

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
