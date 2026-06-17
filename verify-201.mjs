// Verify the backend byte-fill on the EXACT 228-byte production string + the real canonical title.
const getByteLength = (s) => Buffer.byteLength(s, 'utf8')
const CAPACITY_RE = /\b(\d{1,4})\s?(t|g)b?\b/i
const findThirdPartyBrands = () => [] // none in these candidates

function fill(keywords, canonicalTitle, poolKeywords, capacityFamily) {
  let out = (keywords || '').trim()
  if (getByteLength(out) >= 244) return out
  const have = new Set(out.toLowerCase().split(/\s+/).filter(Boolean))
  const candidates = []
  const canonClean = (canonicalTitle ?? '').replace(/(\s+-\s+[A-Za-z][A-Za-z -]{1,24}){1,2}\s*$/, '')
  for (const seg of canonClean.split(/[,\-–—|]/)) {
    const w = seg.toLowerCase().replace(/[^a-z0-9'\s]/g, ' ').split(/\s+/).filter((t) => t.length > 1)
    for (let i = 0; i + 1 < w.length; i++) candidates.push(`${w[i]} ${w[i + 1]}`)
  }
  candidates.push(...poolKeywords.map((k) => k.toLowerCase()))
  for (const cand of candidates) {
    if (capacityFamily && CAPACITY_RE.test(cand)) continue
    if (findThirdPartyBrands(cand).length > 0) continue
    const novel = cand.split(/\s+/).filter((t) => t.length > 1 && !have.has(t))
    if (novel.length === 0) continue
    const addition = novel.join(' ')
    if (getByteLength(`${out} ${addition}`) > 250) continue
    out = `${out} ${addition}`
    for (const t of novel) have.add(t)
    if (getByteLength(out) >= 244) break
  }
  return out
}

const real = 'darlin womens comfort colors tshirt solid color shirts for women plain t confort boxy rodeo pocket white cropped blank graphic cowgirl black lightweight cotton custom oversized tall s boss lady female entrepreneur navy blue deep'
const canonical = "Comfort Colors Darlin' T-Shirt - Country Western Graphic Tee, Vintage Rodeo Shirt, Concert Outfit for Men & Women - Bay - XX-Large"
const pool = ['comfort colors t shirts', 'womens western shirts', 'concert outfit women']
const filled = fill(real, canonical, pool, false)
console.log('before:', getByteLength(real), 'bytes')
console.log('after :', getByteLength(filled), 'bytes (cap 250)')
console.log('contains country:', /\bcountry\b/.test(filled), '| western:', /\bwestern\b/.test(filled), '| vintage:', /\bvintage\b/.test(filled), '| concert:', /\bconcert\b/.test(filled))
console.log('tail:', JSON.stringify(filled.slice(real.length)))
