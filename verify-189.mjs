// Verify the three PR-#189 fixes against the REAL production data fetched earlier.
const STOP = /^(?:vintage|retro|classic|\d{2,4}s?|t|tshirt|tshirts|tee|tees|shirt|shirts|hoodie|hoodies|sweatshirt|sweater|tank|top|tops|comfort|color|colors|graphic|graphics|soft|premium|quality|unisex|man|mans|men|mens|woman|womans|women|womens|ladies|youth|adult|kid|kids|toddler|baby|for|gift|gifts|funny|cute|cool|novelty|design|designs|apparel|clothing|crewneck|crew|long|short|sleeve|sleeves|cotton|ringspun|the|a|an|and|with|by|ideal|perfect|great)$/i

// leadingDesignPhrase WITH the skip-leading-generics fix (verbatim logic)
const lead2 = (title, brandName) => {
  let t = (title || '').trim()
  if (brandName && t.toLowerCase().startsWith(brandName.toLowerCase())) t = t.slice(brandName.length).trim()
  const words = t.replace(/[—–]+/g, ' ').split(/[\s\-]+/).filter(Boolean)
  const lead = []
  for (const w of words) {
    const clean = w.replace(/[^A-Za-z0-9']/g, '')
    if (!clean || STOP.test(clean)) { if (lead.length === 0) continue; break }
    lead.push(clean)
    if (lead.length >= 5) break
  }
  return lead.join(' ').trim()
}

const canonical = 'Comfort Colors Darlin’ T-Shirt - Country Western Graphic Tee, Vintage Rodeo Shirt, Concert Outfit for Men & Women - Bay - XX-Large'
console.log('1. leadingDesignPhrase (fixed):', JSON.stringify(lead2(canonical, 'THE CEO')))

// accept() apostrophe normalization
const normApos = (s) => s.replace(/[’‘]/g, "'")
const haystack = normApos((' ' + canonical).toLowerCase())
console.log('2. straight-apostrophe LLM answer "Darlin\'" now matches curly haystack:', haystack.includes(normApos("darlin'")))

// tokenizer digit-letter bridge (verbatim new logic)
const tok = (s) => {
  const lower = s.toLowerCase()
  return new Set(lower.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean).flatMap((t) => {
    const m = t.match(/^(\d+)([a-z]+)$/) || t.match(/^([a-z]+)(\d+)$/)
    return m ? [m[1], m[2]] : [t]
  }))
}
const title = 'THE CEO SD Card for Camera 128GB Class 10 Memory Card UHS-I Compatible'
const tt = tok(title)
for (const kw of ['128 gb sd card', '128 gb sd card for camera', 'standard sd card 128gb', 'sd card 128gb sandisk cards']) {
  const toks = [...tok(kw)]
  console.log(`3. "${kw}" in 128GB child title:`, toks.every((t) => tt.has(t)))
}

// color filter sanity
const BASIC_COLOR_RE = /\b(?:black|white|navy|red|blue|green|grey|gray|pink|purple|yellow|orange|brown|tan|teal|maroon|burgundy|charcoal|ivory|beige|olive|mint|coral|lavender|mustard|rust|sage|cream)\b/i
console.log('4. color filter drops "plain black tshirt men":', BASIC_COLOR_RE.test('plain black tshirt men'),
  '| keeps "comfort colors t shirts":', !BASIC_COLOR_RE.test('comfort colors t shirts'))
