// Sanity-test the motif strip + lean regexes against the real failure strings.
const VISUAL = new Set(['heart', 'hearts'])
const strip = (text, trust) => {
  const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
  const bad = [...new Set(words.filter((w) => VISUAL.has(w) && !new RegExp(`\\b${w.replace(/s$/, '')}`, 'i').test(trust)))]
  if (!bad.length) return text
  return text.replace(new RegExp(`\\b(?:${bad.join('|')})\\b`, 'gi'), '').replace(/\s{2,}/g, ' ').replace(/\s+([.,!;:])/g, '$1').trim()
}
const trust = "comfort colors darlin' t-shirt - country western graphic tee, vintage rodeo shirt, concert outfit for men & women darlin'"
console.log('1. strip heart:', JSON.stringify(strip("THE CEO Darlin' T-Shirt, Comfort Colors Heart Graphic Tee for Men and Women", trust)))
console.log('2. keeps real heart design:', JSON.stringify(strip('Sacred Heart Graphic Tee', 'comfort colors sacred heart shirt')))

const FEM = /\bwom[ae]ns?\b|\bladies\b|\bfemale\b|\bgirls?\b/i
const MASC = /\bm[ae]ns?\b|\bmale\b|\bboys?\b/i
console.log('3. FEM("womens comfort colors tshirt"):', FEM.test('womens comfort colors tshirt'), '| MASC same:', MASC.test('womens comfort colors tshirt'))
console.log('4. MASC("mens comfort colors tshirt"):', MASC.test('mens comfort colors tshirt'), '| FEM same:', FEM.test('mens comfort colors tshirt'))
console.log('5. MASC must NOT match "women":', MASC.test('women') === false)
console.log('6. MASC must NOT match "humane":', MASC.test('humane') === false)
