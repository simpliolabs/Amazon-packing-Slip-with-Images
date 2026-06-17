// Verify the #196 guards against the EXACT broken production strings.
const GARMENT = new Set(['sweatshirt','sweatshirts','hoodie','hoodies','pullover','pullovers','fleece','sweater','sweaters','jacket','jackets','coat','coats','tank','tanks','polo','polos','onesie','romper','leggings'])
const stripG = (text, trust) => {
  const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
  const bad = [...new Set(words.filter((w) => GARMENT.has(w) && !new RegExp(`\\b${w.replace(/s$/, '')}`, 'i').test(trust)))]
  if (!bad.length) return text
  return text.replace(new RegExp(`\\b(?:${bad.join('|')})\\b`, 'gi'), '').replace(/\s{2,}/g, ' ').replace(/\s+([.,!;:])/g, '$1').trim()
}
const hardAud = (text, audience) => audience === 'Women'
  ? text.replace(/\bmen'?s\b/gi, "Women's").replace(/\bmens\b/gi, 'Womens').replace(/\bmen\b/gi, 'Women')
  : text.replace(/\bwomen'?s\b/gi, "Men's").replace(/\bwomens\b/gi, 'Mens').replace(/\bwomen\b/gi, 'Men')

const trust = "comfort colors darlin' t-shirt - country western graphic tee, vintage rodeo shirt, concert outfit for men & women darlin' SHIRT".toLowerCase()
const brokenTitle = "THE CEO Darlin' Men's Heavyweight Crewneck Sweatshirt Cotton Blend Pullover"
let t = stripG(brokenTitle, trust)
t = hardAud(t, 'Women')
if (!/\bfor Women\b/i.test(t)) t = `${t} for Women`
console.log('1. broken title  →', JSON.stringify(t))

const b1 = "BOLD GRAPHIC IMPACT - Darlin' headline on THE CEO Darlin' Men's Heavyweight Crewneck Sweatshirt Cotton Blend Pullover; sturdy fleece and crisp print deliver confidence-forward style with ease."
console.log('2. broken bullet →', JSON.stringify(hardAud(stripG(b1, trust), 'Women')))

const b3 = "CLEAN, VERSATILE LOOK - For fans of solid color shirts for women and classic plain t shirts, this men's crew keeps outfits simple"
console.log('3. mens-crew     →', JSON.stringify(hardAud(stripG(b3, trust), 'Women')))

// Legit sweatshirt family survives:
console.log('4. real sweatshirt family kept:', JSON.stringify(stripG('Cozy Crewneck Sweatshirt for Fall', 'comfort colors sweatshirt SWEATSHIRT')))
// "women" never corrupted by the Men swap:
console.log('5. male swap leaves no mangling:', JSON.stringify(hardAud('great for women and womens style', 'Men')))
