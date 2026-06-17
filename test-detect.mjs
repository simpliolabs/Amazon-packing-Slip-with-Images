// Phase 1 Commit 1 — designKeyForSku + detectDesignGroups, mirrored line-for-line.
const SKU_SIZE_RE = /-(?:xxs|xs|s|m|l|xl|2xl|3xl|4xl|5xl|6xl|xxl|xxxl)(?=-|$)/i
function designKeyForSku(sku) {
  let k = (sku || '').trim().toUpperCase()
  k = k.replace(/-(?:FBA|FBM)$/i, '')
  const sz = k.search(SKU_SIZE_RE)
  if (sz >= 0) k = k.slice(0, sz)
  const beforePrefix = k.replace(/\d{3,}.*$/, '').replace(/[-_\s]+$/, '')
  if (beforePrefix) return beforePrefix
  k = k.replace(/^\d{3,}(?:2XL|3XL|4XL|5XL|6XL|XL|XS|L|M|S)?-?/i, '')
  k = k.replace(/^[A-Z]{2,4}-/, '')
  k = k.replace(/-?TS$/i, '')
  return k.replace(/[-_\s]+$/, '').replace(/^[-_\s]+/, '')
}
function detectDesignGroups(children) {
  const m = new Map()
  for (const c of children) { const k = designKeyForSku(c.sku); if (!k) continue; if (!m.has(k)) m.set(k, []); m.get(k).push(c) }
  const groups = [...m.entries()].filter(([, skus]) => skus.length >= 2).map(([key, skus]) => ({ key, skus }))
  return { isMultiDesign: groups.length >= 2, groups }
}
let pass = 0, fail = 0
const eq = (n, g, w) => { if (JSON.stringify(g) === JSON.stringify(w)) { pass++; console.log('  ok ', n) } else { fail++; console.log('  FAIL', n, 'got', JSON.stringify(g), 'want', JSON.stringify(w)) } }

// per-SKU key
eq('FHOSH64000L-BK', designKeyForSku('FHOSH64000L-BK'), 'FHOSH')
eq('FRAF640005XL-BK-FBM', designKeyForSku('FRAF640005XL-BK-FBM'), 'FRAF')
eq('OF64000M-BK-FBM', designKeyForSku('OF64000M-BK-FBM'), 'OF')
eq('FHOSH640002XL-BK-FBA', designKeyForSku('FHOSH640002XL-BK-FBA'), 'FHOSH')
eq('Darlin DAR-CCG-2XL-BAY', designKeyForSku('DAR-CCG-2XL-BAY'), 'DAR-CCG')
eq('Darlin DAR-CCG-L-BLK-FBA', designKeyForSku('DAR-CCG-L-BLK-FBA'), 'DAR-CCG')
eq('parent RA-8EU0-VP6R unchanged', designKeyForSku('RA-8EU0-VP6R'), 'RA-8EU0-VP6R')
// SUFFIX-encoded designs (B0GQVL3K4B) — the gap the PO surfaced
eq("suffix 640002XL-BK-I'M-Retired-TS-FBA", designKeyForSku("640002XL-BK-I'M-Retired-TS-FBA"), "I'M-RETIRED")
eq("suffix 640002XL-GR-I'm-Retired-TS", designKeyForSku("640002XL-GR-I'm-Retired-TS"), "I'M-RETIRED")
eq("suffix 64000L-PK-Too-Young-To-Retire-TS", designKeyForSku('64000L-PK-Too-Young-To-Retire-TS'), 'TOO-YOUNG-TO-RETIRE')
eq('DAR-CCG NOT broken to CCG (the adversarial regression)', designKeyForSku('DAR-CCG-2XL-BAY'), 'DAR-CCG')
// suffix family with 2 designs → multi-design
const retire = ["640002XL-BK-I'M-Retired-TS", "64000L-BK-I'M-Retired-TS", "640002XL-PK-Too-Young-To-Retire-TS", "64000M-PK-Too-Young-To-Retire-TS"].map((sku) => ({ sku, asin: 'x' }))
eq('suffix family isMultiDesign', detectDesignGroups(retire).isMultiDesign, true)
eq('suffix family keys', detectDesignGroups(retire).groups.map((g) => g.key).sort(), ["I'M-RETIRED", 'TOO-YOUNG-TO-RETIRE'])

// the real B0F6QZ34B1 family (all 44 SKUs)
const B0F6 = `FHOSH640002XL-BK FHOSH640003XL-BK FHOSH640005XL-BK FHOSH64000L-BK FHOSH64000M-BK FHOSH64000S-BK FHOSH64000XL-BK FRAF640002XL-BK FRAF640003XL-BK FRAF640004XL-BK FRAF640005XL-BK-FBM FRAF64000L-BK-FBM FRAF64000M-BK-FBM FRAF64000S-BK-FBM FRAF64000XL-BK-FBM OF640002XL-BK-FBM OF640003XL-BK OF640005XL-BK-FBM OF64000L-BK OF64000M-BK-FBM OF64000S-BK-FBM OF64000XL-BK FHOSH640002XL-BK-FBA FHOSH640003XL-BK-FBA FHOSH64000L-BK-FBA FHOSH64000M-BK-FBA FHOSH64000S-BK-FBA FHOSH64000XL-BK-FBA FRAF640002XL-BK-FBM FRAF640003XL-BK-FBM FRAF640004XL-BK-FBM FRAF640005XL-BK FRAF64000L-BK FRAF64000M-BK FRAF64000S-BK FRAF64000XL-BK OF640002XL-BK OF640003XL-BK-FBM OF640005XL-BK OF64000L-BK-FBM OF64000M-BK OF64000S-BK OF64000XL-BK-FBM RA-8EU0-VP6R`.split(/\s+/).map((sku) => ({ sku, asin: 'x' }))
const d = detectDesignGroups(B0F6)
eq('B0F6QZ34B1 isMultiDesign', d.isMultiDesign, true)
eq('B0F6QZ34B1 design keys (parent excluded)', d.groups.map((g) => g.key).sort(), ['FHOSH', 'FRAF', 'OF'])
eq('B0F6QZ34B1 group sizes sum to 43 (44 minus parent singleton)', d.groups.reduce((n, g) => n + g.skus.length, 0), 43)

// single-design family (Darlin, 6 colors x sizes, all DAR-CCG) → NOT multi-design
const darlin = ['DAR-CCG-2XL-BAY', 'DAR-CCG-L-BLK', 'DAR-CCG-M-NVY', 'DAR-CCG-S-RED', 'DAR-CCG-XL-WHT'].map((sku) => ({ sku, asin: 'x' }))
eq('Darlin single-design NOT multi', detectDesignGroups(darlin).isMultiDesign, false)
eq('Darlin one group', detectDesignGroups(darlin).groups.map((g) => g.key), ['DAR-CCG'])

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
