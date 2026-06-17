let pass = 0, fail = 0
const eq = (n, g, w) => { if (g === w) { pass++; console.log('  ok ', n) } else { fail++; console.log('  FAIL', n, '\n    got  ', JSON.stringify(g), '\n    want ', JSON.stringify(w)) } }

// ── leadingDesignPhrase with the raised 8-word cap ──
const STOP = /^(?:vintage|retro|classic|\d{2,4}s?|t|tshirt|tshirts|tee|tees|shirt|shirts|hoodie|hoodies|sweatshirt|sweater|tank|top|tops|comfort|color|colors|graphic|graphics|soft|premium|quality|unisex|man|mans|men|mens|woman|womans|women|womens|ladies|youth|adult|kid|kids|toddler|baby|for|gift|gifts|funny|cute|cool|novelty|design|designs|apparel|clothing|crewneck|crew|long|short|sleeve|sleeves|cotton|ringspun|the|a|an|and|with|by|ideal|perfect|great)$/i
function leadingDesignPhrase(title, brandName) {
  let t = (title || '').trim()
  if (brandName && t.toLowerCase().startsWith(brandName.toLowerCase())) t = t.slice(brandName.length).trim()
  const words = t.replace(/[—–]+/g, ' ').split(/[\s\-]+/).filter(Boolean)
  const lead = []
  for (const w of words) {
    const clean = w.replace(/[^A-Za-z0-9']/g, '')
    if (!clean || STOP.test(clean)) { if (lead.length === 0) continue; break }
    lead.push(clean); if (lead.length >= 8) break
  }
  return lead.join(' ').trim()
}
eq('full 7-word slogan survives (was cut at 5 to "...in")',
  leadingDesignPhrase('Comfort Colors I Will Praise Him in Every Season T-Shirt – Christian Tee', 'THE CEO'),
  'I Will Praise Him in Every Season')

// ── attributePin dedup ──
function dedupPin(finalTitle, pin) {
  const re = new RegExp(`\\b${pin.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi')
  let seen = 0
  return finalTitle.replace(re, (m) => (++seen === 1 ? m : '')).replace(/\s{2,}/g, ' ').replace(/\s+,/g, ',').replace(/,\s*,/g, ',').replace(/[\s,]+$/g, '').trim()
}
eq('Comfort Colors deduped to once',
  dedupPin('THE CEO I Will Praise Him in Comfort Colors Tshirt Comfort Colors Christian', 'Comfort Colors'),
  'THE CEO I Will Praise Him in Comfort Colors Tshirt Christian')
eq('single occurrence untouched', dedupPin('THE CEO Darlin Comfort Colors Tee for Women', 'Comfort Colors'), 'THE CEO Darlin Comfort Colors Tee for Women')

// ── stripCompetitorBlanks ──
const OTHER_BLANK_BRANDS_RE = /\b(?:gild[ae]n|guildan|bella\s*\+?\s*canvas|bella\s*convas|american\s*apparel|fruit\s*of\s*the\s*loom|dickies|carhartt|jerzees)\b(?:\s+(?:soft\s*style|softstyle))?/gi
function stripCompetitorBlanks(text, ownBlank) {
  if (!text) return text
  const own = (ownBlank || '').toLowerCase().replace(/[^a-z0-9]/g, '')
  return text
    .replace(OTHER_BLANK_BRANDS_RE, (m) => (own && m.toLowerCase().replace(/[^a-z0-9]/g, '').startsWith(own.slice(0, 6)) ? m : ''))
    .replace(/\s{2,}/g, ' ').replace(/\s+([,.;])/g, '$1').replace(/,\s*,/g, ',').replace(/[,\s]+\.(?=\s|$)/g, '.').replace(/[,\s]+$/g, '').trim()
}
eq('gildan softstyle removed', stripCompetitorBlanks('Enjoy comfort, gildan softstyle.', 'Comfort Colors'), 'Enjoy comfort.')
eq('gilden (misspelling) softstyle tshirts removed', stripCompetitorBlanks('made on gilden softstyle tshirts here', 'Comfort Colors'), 'made on tshirts here')
eq('dickies t shirt → t shirt', stripCompetitorBlanks('pairs with dickies t shirt lovers', 'Comfort Colors'), 'pairs with t shirt lovers')
eq('the product OWN blank Comfort Colors is KEPT', stripCompetitorBlanks('authentic Comfort Colors tee', 'Comfort Colors'), 'authentic Comfort Colors tee')
eq('Gildan KEPT when it IS the product blank', stripCompetitorBlanks('soft Gildan tee', 'Gildan'), 'soft Gildan tee')
eq('no competitor → untouched', stripCompetitorBlanks('soft garment-dyed cotton tee', 'Comfort Colors'), 'soft garment-dyed cotton tee')

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
