// Re-verify the byte-fill (normalized tokens + token-by-token append) on the exact production string.
const getByteLength = (s) => Buffer.byteLength(s, 'utf8')
const CAPACITY_RE = /\b(\d{1,4})\s?(t|g)b?\b/i

function fill(keywords, canonicalTitle, poolKeywords, capacityFamily) {
  let out = (keywords || '').trim()
  if (getByteLength(out) >= 244) return out
  const normTok = (t) => t.toLowerCase().replace(/[^a-z0-9]/g, '')
  const have = new Set(out.split(/\s+/).map(normTok).filter(Boolean))
  const candidates = []
  const canonClean = (canonicalTitle ?? '').replace(/(\s+-\s+[A-Za-z][A-Za-z -]{1,24}){1,2}\s*$/, '')
  for (const seg of canonClean.split(/[,\-–—|]/)) {
    const w = seg.toLowerCase().replace(/[^a-z0-9'\s]/g, ' ').split(/\s+/).filter((t) => t.length > 1)
    for (let i = 0; i + 1 < w.length; i++) candidates.push(`${w[i]} ${w[i + 1]}`)
  }
  candidates.push(...poolKeywords.map((k) => k.toLowerCase()))
  for (const cand of candidates) {
    if (capacityFamily && CAPACITY_RE.test(cand)) continue
    for (const raw of cand.split(/\s+/)) {
      const tok = normTok(raw)
      if (tok.length <= 1 || have.has(tok)) continue
      if (getByteLength(`${out} ${tok}`) > 250) continue
      out = `${out} ${tok}`
      have.add(tok)
    }
    if (getByteLength(out) >= 244) break
  }
  return out
}

const real = 'darlin womens comfort colors tshirt solid color shirts for women plain t confort boxy rodeo pocket white cropped blank graphic cowgirl black lightweight cotton custom oversized tall s boss lady female entrepreneur navy blue deep'
const canonical = "Comfort Colors Darlin' T-Shirt - Country Western Graphic Tee, Vintage Rodeo Shirt, Concert Outfit for Men & Women - Bay - XX-Large"
const pool = ['comfort colors t shirts', 'womens western shirts', 'concert outfit women']
const filled = fill(real, canonical, pool, false)
console.log('before:', getByteLength(real), '| after:', getByteLength(filled), 'bytes (cap 250)')
console.log('country:', /\bcountry\b/.test(filled), '| western:', /\bwestern\b/.test(filled), '| vintage:', /\bvintage\b/.test(filled), '| concert:', /\bconcert\b/.test(filled), '| outfit:', /\boutfit\b/.test(filled))
console.log('tail:', JSON.stringify(filled.slice(real.length)))
console.log('no apostrophe junk:', !filled.includes("'"))
