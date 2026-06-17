// PR #205 local checks — strip-cleanup + validator logic (mirrored from listingPipeline,
// which is too import-heavy to compile standalone; the mirrors are line-for-line).
let pass = 0, fail = 0
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want)
  if (g === w) { pass++; console.log(`  ok  ${name}`) }
  else { fail++; console.log(`  FAIL ${name}\n    got  ${g}\n    want ${w}`) }
}

function stripOppositeGenderTokens(s, lean) {
  const re = lean === 'female'
    ? /\b(?:men|mens|man|male|boys?)\b/gi
    : /\b(?:women|womens|woman|ladies|female|girls?)\b/gi
  let out = s.replace(re, '').replace(/\s{2,}/g, ' ').trim()
  const EDGE_CONNECTOR = /^(?:for|with|and|or|the|a|an|to|in|on|of)\s+|\s+(?:for|with|and|or|the|a|an|to|in|on|of)$/i
  let prev = ''
  while (prev !== out) { prev = out; out = out.replace(EDGE_CONNECTOR, '').trim() }
  return out
}

// the live failure string: trailing "shirt for" after "men" was stripped
eq('dangling for removed', stripOppositeGenderTokens('cowgirl rodeo shirt for men', 'female'), 'cowgirl rodeo shirt')
eq('double connector tail', stripOppositeGenderTokens('graphic tee for the men', 'female'), 'graphic tee')
eq('leading connector', stripOppositeGenderTokens('mens and womens comfort tee', 'female'), 'womens comfort tee')
eq('interior connectors survive', stripOppositeGenderTokens('gift for her country girl men', 'female'), 'gift for her country girl')
eq('male lean mirror', stripOppositeGenderTokens('boxy tee for women and girls', 'male'), 'boxy tee')
eq('female tokens kept under female', stripOppositeGenderTokens('womens cowgirl boots', 'female'), 'womens cowgirl boots')

const getByteLength = (s) => Buffer.byteLength(s, 'utf8')
function backendOutputProblems(perChild, children, apparel) {
  const problems = []
  if (perChild.length === 0) return ['no per-child keyword rows were generated']
  const minBytes = Math.min(...perChild.map((p) => getByteLength(p.keywords || '')))
  if (minBytes < 190) problems.push(`a child landed at ${minBytes}/250 bytes — degraded keyword pool or failed fill`)
  const distinctColors = new Set(children.map((c) => (c.color || 'default').toLowerCase())).size
  const distinctStrings = new Set(perChild.map((p) => p.keywords)).size
  if (apparel && distinctColors >= 3 && distinctStrings < 2) {
    problems.push(`all ${perChild.length} children share one identical string across ${distinctColors} colors — the per-color tail failed`)
  }
  return problems
}

const SOUP = 'comfort color women cowgirl gift birthday her country girl lover casual ideas fan the ceo darlin colors graphic tee rodeo shirt for'   // 131B, the live failure
const HEALTHY = 'x'.repeat(240)
const kids = [{ color: 'navy' }, { color: 'red' }, { color: 'green' }, { color: 'bay' }]
eq('live failure flagged (both problems)', backendOutputProblems(kids.map((c) => ({ keywords: SOUP })), kids, true).length, 2)
eq('healthy distinct passes', backendOutputProblems(kids.map((c, i) => ({ keywords: HEALTHY + i })), kids, true), [])
eq('identical on 2-color family passes', backendOutputProblems([{ keywords: HEALTHY }, { keywords: HEALTHY }], [{ color: 'a' }, { color: 'b' }], true), [])
eq('non-apparel identical passes', backendOutputProblems(kids.map(() => ({ keywords: HEALTHY })), kids, false), [])
eq('thin bytes flagged alone', backendOutputProblems([{ keywords: 'short string' }], [{ color: 'a' }], true).length, 1)
eq('empty rows flagged', backendOutputProblems([], kids, true), ['no per-child keyword rows were generated'])

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
