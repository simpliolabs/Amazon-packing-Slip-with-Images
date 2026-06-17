// From-fact proof for the PO: run the VERBATIM checkPresence predicate (copied from
// src/lib/keyword-engine/checkPresence.ts) against the LIVE content fetched from prod
// (cc-title.json / cc-kw.json) for the exact keywords in the screenshot — showing what
// the Present-In column will display once the twin-row fix deploys.
import { readFileSync } from 'node:fs'

function tokenize(text) {
  const lower = text.toLowerCase()
  const standard = lower.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean)
  const collapsed = lower.split(/\s+/).filter(Boolean).flatMap(w => w.includes('-') ? [w.replace(/-/g, '')] : [])
  return new Set([...standard, ...collapsed])
}
function containsKeyword(text, kwTokens) {
  if (!text || kwTokens.length === 0) return false
  const tt = tokenize(text)
  return kwTokens.every(t => tt.has(t))
}

const title = JSON.parse(readFileSync('cc-title.json', 'utf8')).diff[0].current
const backend = JSON.parse(readFileSync('cc-kw.json', 'utf8')).diff[0].current

const KEYWORDS = [
  'comfort colors tshirt women', 'comfort colors t shirt', 'comfort colors t-shirts',
  'color comfort t shirts', 'plain t shirts', 'comfort tees', 'mens comfort colors tshirt',
  'comfort colors boxy', 'womens comfort colors tshirt',
]
console.log('LIVE TITLE  :', title)
console.log('LIVE BACKEND:', backend.slice(0, 120) + '…')
console.log('')
for (const kw of KEYWORDS) {
  const toks = Array.from(tokenize(kw))
  const t = containsKeyword(title, toks)
  const k = containsKeyword(backend, toks)
  console.log(`${kw.padEnd(30)} → inTitle=${t ? 'T✓' : ' ✗'}  inBackend=${k ? 'K✓' : ' ✗'}`)
}
