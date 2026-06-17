// Fill backstop with canonical-descriptor bigrams — both the real 61-char case and a short 50-char case.
const BKW_STOP = new Set(['for','the','a','an','and','with','of','to','in','on','your','you','that','this'])
const bulletTokens = (s) => (s||'').toLowerCase().replace(/[^a-z0-9\s]/g,' ').split(/\s+/)
  .flatMap((t)=>{const m=t.match(/^(\d+)([a-z]+)$/)||t.match(/^([a-z]+)(\d+)$/);return m?[m[1],m[2]]:[t]})
  .filter((t)=>t.length>1&&!BKW_STOP.has(t))

const canonical = "Comfort Colors Darlin' T-Shirt - Country Western Graphic Tee, Vintage Rodeo Shirt, Concert Outfit for Men & Women - Bay - XX-Large"
const candidates = ['womens comfort colors tshirt','solid color shirts for women','plain t shirts','comfort colors t-shirts']

function fill(finalTitle) {
  if (finalTitle.length >= 70) return finalTitle
  const tailMatch = finalTitle.match(/\s+for\s+(?:men(?:\s+and\s+women)?|women(?:\s+and\s+men)?)\s*$/i)
  const tail = tailMatch ? tailMatch[0] : ''
  let head = tail ? finalTitle.slice(0, finalTitle.length - tail.length) : finalTitle
  const headToks = new Set(bulletTokens(head))
  const tc = (s) => s.replace(/\b\w/g, (c) => c.toUpperCase())
  const canonPhrases = []
  const canonClean = canonical.replace(/(\s+-\s+[A-Za-z][A-Za-z -]{1,24}){1,2}\s*$/, '')
  const canonWords = canonClean.replace(/[^A-Za-z0-9'\s]/g, ' ').split(/\s+/).filter(Boolean)
  for (let i = 0; i + 1 < canonWords.length; i++) {
    const big = `${canonWords[i]} ${canonWords[i+1]}`
    if (bulletTokens(big).length === 2) canonPhrases.push(big)
  }
  for (const kw of [...candidates, ...canonPhrases]) {
    const toks = bulletTokens(kw)
    if (toks.length === 0 || toks.every((t) => headToks.has(t))) continue
    const next = `${head}, ${tc(kw)}`
    if ((next + tail).length > 75) continue
    head = next
    for (const t of toks) headToks.add(t)
    if ((head + tail).length >= 70) break
  }
  return `${head}${tail}`
}

const real = fill("THE CEO Darlin' T-Shirt, Comfort Colors Graphic Tee for Women")
console.log('1. real 61-char case →', JSON.stringify(real), `(${real.length}/75)`)
const short = fill("THE CEO Darlin' T-Shirt, Comfort Colors Tee for Women")
console.log('2. short 54-char case →', JSON.stringify(short), `(${short.length}/75)`)
