// PR #206 — token truth gate, mirrored logic (line-for-line with listingPipeline).
let pass = 0, fail = 0
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want)
  if (g === w) { pass++; console.log(`  ok  ${name}`) }
  else { fail++; console.log(`  FAIL ${name}\n    got  ${g}\n    want ${w}`) }
}

const BASIC_COLOR_RE = /\b(?:black|white|navy|red|blue|green|grey|gray|pink|purple|yellow|orange|brown|tan|teal|maroon|burgundy|charcoal|ivory|beige|olive|mint|coral|lavender|mustard|rust|sage|cream)\b/i
const GARMENT_TYPE_WORDS = new Set(['sweatshirt','sweatshirts','hoodie','hoodies','pullover','pullovers','fleece','sweater','sweaters','jacket','jackets','coat','coats','tank','tanks','polo','polos','onesie','romper','leggings'])
const STYLE_CUT_WORDS = new Set(['cropped','crop','pocket','boxy','oversized','oversize','slim','fitted','muscle','raglan','ringer','sleeveless','henley','longline','flowy','baggy','distressed','bleached','plain','blank','solid','tall','petite','maternity'])

function makeBan(canonicalTitle, repTitle, designName, productType, colorNeutralFamily, lean) {
  const hay = `${canonicalTitle ?? ''} ${repTitle} ${designName} ${(productType ?? '').replace(/_/g, ' ')}`.toLowerCase()
  return (w) => {
    if (w.length === 1 && !/\d/.test(w)) return true
    if (colorNeutralFamily && BASIC_COLOR_RE.test(w)) return true
    if ((STYLE_CUT_WORDS.has(w) || GARMENT_TYPE_WORDS.has(w)) && !new RegExp(`\\b${w}\\b`, 'i').test(hay)) return true
    if (lean === 'female' && /^(?:men|mens|man|male|boys?)$/i.test(w)) return true
    if (lean === 'male' && /^(?:women|womens|woman|ladies|female|girls?)$/i.test(w)) return true
    return false
  }
}

// The Darlin' setup: female lean, multi-color apparel, canonical without style words
const ban = makeBan(
  "THE CEO Darlin' Womens Comfort Colors Graphic Tee, Country Western Cowgirl Rodeo Shirt for Women",
  "THE CEO Darlin' Womens Comfort Colors Graphic Tee - Bay - 2XL",
  "Darlin'", 'SHIRT', true, 'female',
)
// every token the PO flagged as "Super BAD" must be banned
for (const w of ['cropped', 'pocket', 'solid', 'plain', 'black', 'oversized', 'blank', 'boxy', 'white']) {
  eq(`bans "${w}"`, ban(w), true)
}
eq('bans stray single letter t', ban('t'), true)
eq('bans opposite gender men', ban('men'), true)
eq('bans mens', ban('mens'), true)
// grounded + neutral words must survive
for (const w of ['graphic', 'tee', 'cotton', 'lightweight', 'cowgirl', 'country', 'western', 'rodeo', 'women', 'womens', 'darlin', 'vintage', 'gift']) {
  eq(`keeps "${w}"`, ban(w), false)
}

// grounding works: a family whose canonical SAYS "Oversized Boxy" keeps those words
const ban2 = makeBan('Brand Oversized Boxy Tee Black', 'rep', 'Design', 'SHIRT', false, null)
eq('grounded oversized kept', ban2('oversized'), false)
eq('grounded boxy kept', ban2('boxy'), false)
eq('single-color family keeps black', ban2('black'), false)
eq('ungrounded cropped still banned', ban2('cropped'), true)

// garment gate: tank banned on a tee, kept on a tank family
eq('tank banned on tee family', ban('tank'), true)
const ban3 = makeBan('Brand Racerback Tank Top', 'rep', 'D', 'SHIRT', false, null)
eq('tank kept on tank family', ban3('tank'), false)

// male-lean mirror
const ban4 = makeBan('canonical', 'rep', 'D', 'SHIRT', false, 'male')
eq('male lean bans womens', ban4('womens'), true)
eq('male lean keeps men', ban4('men'), false)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
