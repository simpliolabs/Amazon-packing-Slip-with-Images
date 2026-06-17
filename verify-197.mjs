// Verify the title-fill backstop against the EXACT 61/75 production title + real candidates.
const BKW_STOP = new Set(['for','the','a','an','and','with','of','to','in','on','your','you','that','this'])
const bulletTokens = (s) => (s||'').toLowerCase().replace(/[^a-z0-9\s]/g,' ').split(/\s+/)
  .flatMap((t)=>{const m=t.match(/^(\d+)([a-z]+)$/)||t.match(/^([a-z]+)(\d+)$/);return m?[m[1],m[2]]:[t]})
  .filter((t)=>t.length>1&&!BKW_STOP.has(t))

const finalTitle0 = "THE CEO Darlin' T-Shirt, Comfort Colors Graphic Tee for Women"
// real candidate keywords for this family (female-leaned order)
const candidates = ['womens comfort colors tshirt','solid color shirts for women','plain t shirts','comfort colors t-shirts','vintage rodeo shirt','country western graphic tee']

let finalTitle = finalTitle0
if (finalTitle.length < 70) {
  const tailMatch = finalTitle.match(/\s+for\s+(?:men(?:\s+and\s+women)?|women(?:\s+and\s+men)?)\s*$/i)
  const tail = tailMatch ? tailMatch[0] : ''
  let head = tail ? finalTitle.slice(0, finalTitle.length - tail.length) : finalTitle
  const headToks = new Set(bulletTokens(head))
  const tc = (s) => s.replace(/\b\w/g, (c) => c.toUpperCase())
  for (const kw of candidates) {
    const toks = bulletTokens(kw)
    if (toks.length === 0 || toks.every((t) => headToks.has(t))) continue
    const next = `${head}, ${tc(kw)}`
    if ((next + tail).length > 75) continue
    head = next
    for (const t of toks) headToks.add(t)
    if ((head + tail).length >= 70) break
  }
  finalTitle = `${head}${tail}`
}
console.log('filled:', JSON.stringify(finalTitle))
console.log('length:', finalTitle.length, '/75')
console.log('ends for Women:', /for Women$/.test(finalTitle))
