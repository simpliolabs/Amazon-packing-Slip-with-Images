// Mirror of leadingDesignPhrase with the apostrophe fix — verify the B0GQVL3K4B case.
function leadingDesignPhrase(title, brandName) {
  const STOP = /^(?:vintage|retro|classic|\d{2,4}s?|t|tshirt|tshirts|tee|tees|shirt|shirts|hoodie|hoodies|sweatshirt|sweater|tank|top|tops|comfort|color|colors|graphic|graphics|soft|premium|quality|unisex|man|mans|men|mens|woman|womans|women|womens|ladies|youth|adult|kid|kids|toddler|baby|for|gift|gifts|funny|cute|cool|novelty|design|designs|apparel|clothing|crewneck|crew|long|short|sleeve|sleeves|cotton|ringspun|the|a|an|and|with|by|ideal|perfect|great)$/i
  let t = (title || '').replace(/[’‘]/g, "'").trim()
  if (brandName && t.toLowerCase().startsWith(brandName.toLowerCase())) t = t.slice(brandName.length).trim()
  const words = t.replace(/[—–]+/g, ' ').split(/[\s\-]+/).filter(Boolean)
  const lead = []
  for (const w of words) {
    const clean = w.replace(/[^A-Za-z0-9']/g, '')
    if (!clean || STOP.test(clean)) { if (lead.length === 0) continue; break }
    lead.push(clean)
    if (lead.length >= 8) break
  }
  return lead.join(' ').trim()
}

// Mirror of accept's haystack check — uses normApos which converts curly→straight.
function inSource(designName, source) {
  const norm = (s) => s.toLowerCase().replace(/[’‘]/g, "'")
  return norm(source).includes(norm(designName))
}

let pass = 0, fail = 0
const eq = (name, got, want) => { if (got === want) { pass++; console.log('  ok  ', name) } else { fail++; console.log('  FAIL', name, '\n    got ', JSON.stringify(got), '\n    want', JSON.stringify(want)) } }

// THE bug: B0GQVL3K4B canonical title with curly apostrophe in "Don’t"
const canonicalCurly = "I Am Retired I Don’t Have to T-Shirt – Funny Retirement Graphic Tee for Men & Women, Humorous Saying Shirt, Retirement Gift for Him & Her - 3X-Large - Black"
const leadCurly = leadingDesignPhrase(canonicalCurly, 'THE CEO')
console.log('  leadingDesignPhrase(curly) =', JSON.stringify(leadCurly))
eq('lead preserves the apostrophe', leadCurly, "I Am Retired I Don't Have to")
eq('lead is found IN the source (haystack match)', inSource(leadCurly, canonicalCurly), true)

// Straight-apostrophe equivalent still works (no regression)
const canonicalStraight = "I Am Retired I Don't Have to T-Shirt - Funny Retirement Graphic Tee"
eq('straight-apostrophe still extracts', leadingDesignPhrase(canonicalStraight, 'THE CEO'), "I Am Retired I Don't Have to")

// Generic blank title yields empty lead (no STOP-bounded distinctive phrase)
eq('generic blank tee → empty lead', leadingDesignPhrase("Comfort Colors T-Shirt for Women", 'THE CEO'), '')

// Already-working slogan case (no apostrophe) — make sure nothing regressed
eq('faith slogan extracts', leadingDesignPhrase("I Will Praise Him in Every Season T-Shirt", 'THE CEO'), 'I Will Praise Him in Every Season')

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
