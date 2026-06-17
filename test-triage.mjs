// PR — golf-tee triage: enforceHardAudience fit-strip + bullet overuse/misspelling + blend dedup.
let pass = 0, fail = 0
const eq = (n, g, w) => { if (JSON.stringify(g) === JSON.stringify(w)) { pass++; console.log('  ok ', n) } else { fail++; console.log('  FAIL', n, '\n    got ', JSON.stringify(g), '\n    want', JSON.stringify(w)) } }

// ── enforceHardAudience (mirror) ──
function enforceHardAudience(text, audience) {
  if (!text) return text
  const GENDER = `(?:men(?:['’]s|s)?|male|males|women(?:['’]s|s)?|female|females)`
  const FITNOUN = `(?:fit|style|cut|sizing|silhouette|cutting)`
  const stripGenderedFit = (s) => s
    .replace(new RegExp(`\\b${GENDER}\\s+(${FITNOUN})\\b`, 'gi'), '$1')
    .replace(new RegExp(`\\b(${FITNOUN})\\s+(?:for\\s+)?${GENDER}\\b`, 'gi'), '$1')
  let out = stripGenderedFit(text)
  if (audience === 'Women') out = out.replace(/\bmen['’]?s\b/gi, "Women's").replace(/\bmens\b/gi, 'Womens').replace(/\bmen\b/gi, 'Women')
  else out = out.replace(/\bwomen['’]?s\b/gi, "Men's").replace(/\bwomens\b/gi, 'Mens').replace(/\bwomen\b/gi, 'Men')
  return out.replace(/\s{2,}/g, ' ').trim()
}
// The exact live offenders — fit must go neutral, audience preserved
eq("men's fit -> fit (apostrophe, the adversarial catch)", enforceHardAudience('relaxed men’s fit', 'Women'), 'relaxed fit')
eq("men's fit straight quote", enforceHardAudience("relaxed men's fit", 'Women'), 'relaxed fit')
eq('RELAXED WOMENS FIT -> RELAXED FIT', enforceHardAudience('RELAXED WOMENS FIT', 'Women'), 'RELAXED FIT')
eq("women's style -> style", enforceHardAudience('a relaxed women’s style that pops', 'Women'), 'a relaxed style that pops')
eq('mens cut -> cut (male lean keeps fit neutral too)', enforceHardAudience('classic mens cut', 'Men'), 'classic cut')
eq('audience "for men" still swaps under female', enforceHardAudience('a tee for men', 'Women'), 'a tee for Women')
eq('"gift for her" untouched under female', enforceHardAudience('great gift for her', 'Women'), 'great gift for her')
eq('non-fit "womens tshirt" left as audience under female', enforceHardAudience('womens comfort colors tshirt', 'Women'), 'womens comfort colors tshirt')
eq('male mirror: womens fit -> fit, women -> Men', enforceHardAudience('womens fit tee for women', 'Men'), 'fit tee for Men')
eq('no fabricated fit when none present', enforceHardAudience('soft ringspun cotton tee', 'Women'), 'soft ringspun cotton tee')

// ── bullet overuse + misspelling (mirror of validateBullets additions) ──
function bulletProblems(bullets) {
  const problems = []
  const joined = bullets.join('  \n  ').toLowerCase()
  const OVERUSE = ['comfort colors', 'comfort color', 'ring spun', 'ring-spun', 'garment dyed', 'garment-dyed']
  for (const p of OVERUSE) {
    const re = new RegExp(`\\b${p.replace(/[-\s]+/g, '[-\\s]?')}\\b`, 'gi')
    const n = (joined.match(re) || []).length
    if (n >= 3) problems.push(`overuse:${p}:${n}`)
  }
  const MISS = [/\bconfort\b/gi, /\btshrit\b/gi, /\bcoton\b/gi]
  for (const re of MISS) { const m = joined.match(re); if (m) problems.push(`typo:${m[0]}`) }
  return problems
}
const LIVE_BULLETS = [
  'BOLD GRAPHIC VIBES - playful statement with the graphic tee.',
  'ALL-DAY SOFTNESS - broken-in feel of this comfort colors tshirt, confort colors t shirt.',
  'RELAXED FIT - this womens comfort colors tshirt (comfort colors tshirt women) drapes.',
  'PREMIUM FABRIC FEEL - authentic Comfort Colors tee, this comfort colors t shirt sturdy.',
  'EASY CARE - pairs with comfort colors t shirts and comfort color tshirts.',
]
const probs = bulletProblems(LIVE_BULLETS)
eq('flags comfort colors overuse (>=3)', probs.some(p => p.startsWith('overuse:comfort colors')), true)
eq('flags the confort typo', probs.some(p => p === 'typo:confort'), true)
eq('comfort (correct) is NOT flagged as confort', bulletProblems(['soft comfort tee']).length, 0)
eq('two mentions OK (no overuse)', bulletProblems(['Comfort Colors tee here', 'and a comfort colors shirt', 'plain stuff']).some(p=>p.startsWith('overuse')), false)

// ── blend dedup (mirror) ──
function dedupBlend(kws) {
  const BLEND = /\b(?:comfort\s*colou?rs?|bella\s*canvas|gildan|next\s*level)\b/i
  const idx = new Map(); const out = []
  for (const k of kws) {
    const m = k.keyword.match(BLEND)
    if (!m) { out.push(k); continue }
    const base = m[0].toLowerCase().replace(/\s+/g, '')
    const at = idx.get(base)
    if (at == null) { idx.set(base, out.length); out.push(k) }
    else if (k.keyword.length < out[at].keyword.length) out[at] = k
  }
  return out.map(k => k.keyword)
}
eq('collapses comfort-colors variants to shortest', dedupBlend([
  { keyword: 'comfort colors tshirt women' }, { keyword: 'comfort colors' }, { keyword: 'comfort colors tee' }, { keyword: 'funny golf shirt' },
]), ['comfort colors', 'funny golf shirt'])
eq('keeps distinct blend brands', dedupBlend([{ keyword: 'comfort colors tee' }, { keyword: 'bella canvas shirt' }]), ['comfort colors tee', 'bella canvas shirt'])

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
