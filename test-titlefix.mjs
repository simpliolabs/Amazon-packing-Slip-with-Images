// Mirror of capTitle75 + the two new backstops (brand-front + design-anchor).
function capTitle75(t) {
  if (t.length <= 75) return t.trim()
  let cut = t.slice(0, 76)
  const lastSpace = cut.lastIndexOf(' ')
  cut = (lastSpace > 0 ? cut.slice(0, lastSpace) : cut.slice(0, 75)).trim()
  for (let guard = 0; guard < 6; guard++) {
    const tidied = cut.replace(/[\s,;:&\-–—]+$/g, '').replace(/\s(?:for|and|with|in|of|to|a|an|the|or|by)$/i, '').trim()
    if (tidied === cut) break
    cut = tidied
  }
  return cut
}

function fixTitle(finalTitle, brandName, attributePinFinal, designName) {
  // dedup pin
  if (attributePinFinal && finalTitle) {
    const re = new RegExp(`\\b${attributePinFinal.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi')
    let seen = 0
    finalTitle = finalTitle.replace(re, (m) => (++seen === 1 ? m : '')).replace(/\s{2,}/g, ' ').replace(/\s+,/g, ',').replace(/,\s*,/g, ',').replace(/[\s,]+$/g, '').trim()
  }
  // brand-front
  if (brandName && finalTitle) {
    const brandRe = new RegExp(`\\b${brandName.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')
    const m = finalTitle.match(brandRe)
    if (m && m.index !== undefined && m.index > 0) {
      const without = (finalTitle.slice(0, m.index) + finalTitle.slice(m.index + m[0].length)).replace(/\s{2,}/g, ' ').replace(/\s+,/g, ',').replace(/,\s*,/g, ',').replace(/^[,\s]+|[,\s]+$/g, '').trim()
      finalTitle = capTitle75(`${m[0]} ${without}`)
    }
  }
  // design re-anchor
  if (designName && designName.split(/\s+/).length >= 3 && finalTitle && !new RegExp(`\\b${designName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(finalTitle)) {
    const brandMatch = brandName ? finalTitle.match(new RegExp(`^\\s*${brandName.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*`, 'i')) : null
    const head = brandMatch ? brandMatch[0].trim() : ''
    const tailMatch = finalTitle.match(/\s+for\s+(?:men(?:\s+and\s+women)?|women(?:\s+and\s+men)?)\s*$/i)
    const tail = tailMatch ? tailMatch[0] : ''
    const rest = finalTitle.slice(head.length).slice(0, finalTitle.length - head.length - tail.length).trim()
    finalTitle = capTitle75(`${head} ${designName}, ${rest}${tail}`.replace(/,\s*,/g, ',').replace(/\s+,/g, ','))
  }
  return finalTitle
}

let pass = 0, fail = 0
const eq = (n, g, w) => { if (g === w) { pass++; console.log('  ok ', n) } else { fail++; console.log('  FAIL', n, '\n    got  ', JSON.stringify(g), '\n    want ', JSON.stringify(w)) } }

// THE live failure on B0FKKN8XKV — brand "THE CEO" mid-title, pin doubled, slogan truncated to "I Will"
const bad = 'Comfort Colors Tshirt Comfort Colors Christian Graphic Tees THE CEO I Will'
const fixed = fixTitle(bad, 'THE CEO', 'Comfort Colors', 'I Will Praise Him in Every Season')
console.log('fixed:', fixed)
eq('starts with brand', fixed.startsWith('THE CEO'), true)
eq('single Comfort Colors', (fixed.match(/Comfort Colors/g) || []).length, 1)
eq('contains full slogan', /I Will Praise Him in Every Season/i.test(fixed), true)
eq('within 75 chars', fixed.length <= 75, true)

// Reasonable case — single Comfort Colors, brand at front, slogan present → untouched
const good = 'THE CEO I Will Praise Him in Every Season Comfort Colors Christian T-Shirt'
eq('good title stays the same', fixTitle(good, 'THE CEO', 'Comfort Colors', 'I Will Praise Him in Every Season'), good)

// Short slogan (≤2 words) — design re-anchor must NOT fire for it (avoids touching short anchor cases)
const shortDesign = 'THE CEO Darlin Comfort Colors Tee for Women'
eq('short design not re-anchored', fixTitle(shortDesign, 'THE CEO', 'Comfort Colors', 'Darlin'), shortDesign)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
