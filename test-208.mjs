// PR #208 — own-brand + stopword ban in the backend token gate (mirrored logic).
let pass = 0, fail = 0
const eq = (name, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; console.log(`  ok  ${name}`) }
  else { fail++; console.log(`  FAIL ${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`) }
}

const ownBrandTokenSet = (b) => new Set(b.toLowerCase().split(/\s+/).filter(Boolean))

function makeBan(brandName, designName) {
  const AMZ_BACKEND_STOPWORDS = new Set(['a', 'an', 'and', 'by', 'for', 'of', 'the', 'with'])
  const brandToks = ownBrandTokenSet(brandName)
  ;(designName || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean).forEach((w) => brandToks.delete(w))
  return (w) => AMZ_BACKEND_STOPWORDS.has(w) || brandToks.has(w)
}

// THE CEO / Darlin' — the live case
const ban = makeBan('THE CEO', "Darlin'")
eq('bans brand token ceo', ban('ceo'), true)
eq('bans brand token the (also a stopword)', ban('the'), true)
eq('bans stopword for', ban('for'), true)
eq('bans stopword with', ban('with'), true)
eq('bans stopword and', ban('and'), true)
eq('keeps design token darlin', ban('darlin'), false)
eq('keeps her (real search token, not a stopword)', ban('her'), false)
eq('keeps cowgirl', ban('cowgirl'), false)
eq('keeps entrepreneur', ban('entrepreneur'), false)

// brand === design overlap: design tokens win the exemption
const ban2 = makeBan('Later Gator', 'Later Gator')
eq('design-overlap keeps later', ban2('later'), false)
eq('design-overlap keeps gator', ban2('gator'), false)

// distinct brand still banned when design differs
const ban3 = makeBan('Simplio Labs', 'Later Gator')
eq('bans simplio', ban3('simplio'), true)
eq('bans labs', ban3('labs'), true)
eq('keeps gator', ban3('gator'), false)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
