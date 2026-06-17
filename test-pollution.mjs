// Mirror of buildSeedFromTitle + identityTokensOf + keywordIsRelevant — verify against the
// EXACT B0GVW83L1P live failure (61 family/graduation/disney keywords polluting a soccer listing).
const SEED_GENERIC = new Set([
  '2020','2021','2022','2023','2024','2025','2026','2027','2028','2029','2030',
  'personalized','custom','customized','graphic','graphics','vintage','retro','classic',
  'premium','quality','soft','blank','original','novelty','unisex','plain',
  'small','medium','large','xl','2xl','3xl','4xl','5xl','xxl','xxxl',
  'black','white','red','blue','green','navy','gray','grey','yellow','pink','purple','brown','orange','beige',
  'men','mens','women','womens','ladies','kid','kids','toddler','baby','adult','youth',
  'comfort','colors','gildan','jerzees','dickies','carhartt','bella','canvas',
  'for','and','with','the','a','an','of','to','in','on','at','by','or',
])
const APPAREL_WORDS = new Set(['shirt','shirts','tshirt','tshirts','t-shirt','tee','tees','top','tops','hoodie','sweatshirt','tank'])

function buildSeedFromTitle(title) {
  const firstSegment = title.split(/\s*[-–—:]\s*/)[0].trim()
  const all = firstSegment.toLowerCase().replace(/[^a-z0-9'\s]/g, ' ').split(/\s+/).filter(Boolean)
  const distinctive = all.filter((w) => !SEED_GENERIC.has(w) && !APPAREL_WORDS.has(w) && w.length > 1 && !/^\d+$/.test(w))
  const lead = distinctive.slice(0, 2)
  const apparelInTitle = all.find((w) => APPAREL_WORDS.has(w)) || 'tshirt'
  const seed = lead.length > 0 ? `${lead.join(' ')} ${apparelInTitle}` : `${all.slice(0, 2).join(' ')} ${apparelInTitle}`.trim()
  return seed.replace(/\s{2,}/g, ' ').trim()
}

function identityTokensOf(...sources) {
  const out = new Set()
  for (const s of sources) {
    if (!s) continue
    for (const raw of s.toLowerCase().replace(/[^a-z0-9'\s]/g, ' ').split(/\s+/).filter(Boolean)) {
      const w = raw.replace(/s$/, '')
      if (w.length <= 2) continue
      if (SEED_GENERIC.has(w) || APPAREL_WORDS.has(w)) continue
      if (/^\d+$/.test(w)) continue
      out.add(w)
    }
  }
  return out
}

function keywordIsRelevant(keyword, identity) {
  if (identity.size === 0) return true
  for (const raw of keyword.toLowerCase().replace(/[^a-z0-9'\s]/g, ' ').split(/\s+/).filter(Boolean)) {
    const w = raw.replace(/s$/, '')
    if (w.length <= 2) continue
    if (SEED_GENERIC.has(w) || APPAREL_WORDS.has(w)) continue
    if (identity.has(w)) return true
  }
  return false
}

let pass = 0, fail = 0
const eq = (name, got, want) => { if (got === want) { pass++; console.log('  ok  ', name) } else { fail++; console.log('  FAIL', name, '\n    got ', JSON.stringify(got), '\n    want', JSON.stringify(want)) } }

// === SEED EXTRACTION ===
// THE bug: B0GVW83L1P seed was "personalized 2026 tshirt" (soccer dropped!)
const soccerTitle = "Personalized 2026 World Soccer Cup T-Shirt – Fan Tee, USA, Mexico, Canada Host Countries Shirt - 5X-Large - White"
const soccerSeed = buildSeedFromTitle(soccerTitle)
console.log('soccer seed:', soccerSeed)
// NOTE: the seller titles all embed "T-Shirt" (hyphenated), so the brand-prefix split also cuts at
// that hyphen → the apparel word lands in segment 2 and the seed falls back to "tshirt". The seed
// still leads with the DISTINCTIVE design tokens (the whole point) — generics (2026/personalized/
// premium) are dropped. This is the FAILOVER path; the Seed Agent (primary) reads the full title.
eq('soccer seed drops 2026/personalized, keeps soccer', soccerSeed, 'world soccer tshirt')
eq('retirement seed keeps "retired"', buildSeedFromTitle("I Am Retired I Don't Have to T-Shirt – Funny Retirement Graphic Tee"), "am retired tshirt")
eq('faith seed keeps "praise"', buildSeedFromTitle("Comfort Colors I Will Praise Him Every Season T-Shirt – Christian Tee"), 'will praise tshirt')
eq('pure-blank drops "premium", keeps "cotton"', buildSeedFromTitle("Premium Cotton T-Shirt"), 'cotton tshirt')

// === RELEVANCE GATE — using B0GVW83L1P canonical ===
const soccerIdentity = identityTokensOf(soccerTitle)
console.log('\nsoccer identity tokens:', [...soccerIdentity].join(', '))

// The 5 actual soccer keywords from the live pool — ALL should pass
const soccerKws = ['custom soccer jersey','haitian world cup jersey','haitian world cup 2026 t shirt','custom jersey soccer','haitian jersey world cup 2026']
for (const k of soccerKws) eq(`KEEP "${k}"`, keywordIsRelevant(k, soccerIdentity), true)

// The 6 worst pollutants from the live pool — ALL should drop
const pollutants = ['family vacation shirts 2026','family cruise shirts 2026','disney family shirts matching 2026','proud mom of a 2026 graduate shirt','family reunion shirts','custom dad shirt']
for (const k of pollutants) eq(`DROP "${k}"`, keywordIsRelevant(k, soccerIdentity), false)

// Edge: a keyword sharing ONLY "2026" with identity should DROP (year is generic on both sides)
eq('shared-year-only drops', keywordIsRelevant('halloween shirt 2026', identityTokensOf('soccer 2026 shirt')), false)

// Edge: empty identity (no listing data) accepts everything (no over-blocking on a fresh listing)
eq('empty identity → accept all', keywordIsRelevant('anything goes', new Set()), true)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
