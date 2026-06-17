// PR #210 — calibration variants (real compiled code) + rank lean filter (mirror).
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const ptd = require('./tmp-shape-test2/productTypeDefinitions.js')

let pass = 0, fail = 0
const eq = (name, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; console.log(`  ok  ${name}`) }
  else { fail++; console.log(`  FAIL ${name}\n    got  ${JSON.stringify(got)}\n    want ${JSON.stringify(want)}`) }
}

// neck shape as derived live: path [neck_style, value], lang at the leaf level
const neckShape = { path: ['neck_style', 'value'], languageTagAt: [false, true], hasMarketplaceId: true }
const vars = ptd.buildShapedDetailValueVariants(neckShape, 'Crew Neck', 'MKT')
eq('variant ids', vars.map((v) => v.id), ['shaped', 'shaped-no-lang', 'direct-leaf'])
eq('shaped', vars[0].value, [{ neck_style: { value: 'Crew Neck', language_tag: 'en_US' }, marketplace_id: 'MKT' }])
eq('shaped-no-lang', vars[1].value, [{ neck_style: { value: 'Crew Neck' }, marketplace_id: 'MKT' }])
eq('direct-leaf', vars[2].value, [{ neck_style: 'Crew Neck', marketplace_id: 'MKT' }])

// no-lang shape: shaped == shaped-no-lang deduped away
const sleeveShape = { path: ['length_description', 'value'], languageTagAt: [false, false], hasMarketplaceId: true }
const vars2 = ptd.buildShapedDetailValueVariants(sleeveShape, 'short_sleeve', 'MKT')
eq('sleeve variant ids (deduped)', vars2.map((v) => v.id), ['shaped', 'direct-leaf'])
eq('sleeve direct-leaf', vars2[1].value, [{ length_description: 'short_sleeve', marketplace_id: 'MKT' }])

// single-segment path (direct enum on sub-key): no direct-leaf variant beyond itself
const directShape = { path: ['type'], languageTagAt: [false], hasMarketplaceId: true }
const vars3 = ptd.buildShapedDetailValueVariants(directShape, 'Pull On', 'MKT')
eq('direct shape single variant', vars3.map((v) => v.id), ['shaped'])
eq('direct shape value', vars3[0].value, [{ type: 'Pull On', marketplace_id: 'MKT' }])

// variant index stability across different values (the loop rebuilds per value)
const varsA = ptd.buildShapedDetailValueVariants(neckShape, 'AAA', 'MKT')
const varsB = ptd.buildShapedDetailValueVariants(neckShape, 'BBB', 'MKT')
eq('index-stable across values', varsA.map((v) => v.id), varsB.map((v) => v.id))

// menu ordering: SEO first, noise last
const MENU_SEO_PRIORITY = /occasion|theme|pattern|special_feature|lifestyle|style_name|collar|neck|sleeve|closure|fit_type|material|fabric|care_instructions|age_range|target_gender|department|season|sport|character|team_name|league|item_type_name|top_style|weave|finish|shape/
const MENU_NOISE = /voltage|wattage|batter|compliance|regulat|warrant|hazmat|ghs|safety|unspsc|fcc_|dsa_|epr_|package_(?:weight|dimension|level|quantity)|item_(?:weight|dimension)|country_of_origin|manufacturer|external|gtin|upc|ean/
const band = (k) => (MENU_NOISE.test(k) ? 2 : MENU_SEO_PRIORITY.test(k) ? 0 : 1)
const keys = ['voltage', 'neck', 'wattage', 'occasion', 'lifestyle', 'shirt_size', 'theme', 'compliance_age_range']
const sorted = keys.map((k, i) => [k, i]).sort((a, b) => band(a[0]) - band(b[0])).map((x) => x[0])
eq('seo first noise last', sorted, ['neck', 'occasion', 'lifestyle', 'theme', 'shirt_size', 'voltage', 'wattage', 'compliance_age_range'])

// rank lean filter mirror — the two live offenders die, neutral/female survive
const FEM_RE = /\bwom[ae]ns?\b|\bladies\b|\bfemale\b|\bgirls?\b/i
const MASC_RE = /\bm[ae]ns?\b|\bmale\b|\bboys?\b/i
const leanKeep = (kw, al) => { const f = FEM_RE.test(kw), m = MASC_RE.test(kw); return al === 'female' ? !(m && !f) : !(f && !m) }
eq('drops mens comfort colors tshirt', leanKeep('mens comfort colors tshirt', 'female'), false)
eq('drops plain black tshirt men', leanKeep('plain black tshirt men', 'female'), false)
eq('keeps womens comfort colors tshirt', leanKeep('womens comfort colors tshirt', 'female'), true)
eq('keeps neutral comfort colors t shirts', leanKeep('comfort colors t shirts', 'female'), true)
eq('keeps both-gender shirts for men and women', leanKeep('shirts for men and women', 'female'), true)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
