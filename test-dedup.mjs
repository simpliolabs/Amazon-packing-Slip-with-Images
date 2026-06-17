function dedupeTokenSoup(s) {
  const seen = new Set(); const out = []
  for (const raw of (s || '').split(/\s+/)) {
    const norm = raw.toLowerCase().replace(/[^a-z0-9]/g, '')
    if (!norm || seen.has(norm)) continue
    seen.add(norm); out.push(raw)
  }
  return out.join(' ')
}
let pass = 0, fail = 0
const eq = (n, g, w) => { if (JSON.stringify(g) === JSON.stringify(w)) { pass++; console.log('  ok ', n) } else { fail++; console.log('  FAIL', n, '\n    got ', JSON.stringify(g), '\n    want', JSON.stringify(w)) } }

const live = 'i could be meaner comfort colors tshirt shirts color women womens mens could be meaner men brand graphic'
const out = dedupeTokenSoup(live)
eq('design lead intact', out.startsWith('i could be meaner comfort colors'), true)
eq('could once', (out.match(/\bcould\b/g) || []).length, 1)
eq('meaner once', (out.match(/\bmeaner\b/g) || []).length, 1)
eq('be once', (out.match(/\bbe\b/g) || []).length, 1)
eq('men once (not men inside meaner)', (out.match(/\bmen\b/g) || []).length, 1)
eq('women + womens both survive (distinct tokens)', /\bwomen\b/.test(out) && /\bwomens\b/.test(out), true)
eq("apostrophe collapses darlin' == darlin", dedupeTokenSoup("darlin' darlin western"), "darlin' western")
eq('empty safe', dedupeTokenSoup(''), '')
eq('no tokens lost when unique', dedupeTokenSoup('alpha beta gamma'), 'alpha beta gamma')
console.log(`tokens ${live.split(/\s+/).length} -> ${out.split(/\s+/).length}`)
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
