// Mirror of containerKeyFallback's logic against fake schemas, proving:
//  (1) SHIRT (container schema) rescues neck_style/sleeve_type/closure_type → neck/sleeve/closure
//  (2) a flat-key schema (neck_style exists) is NEVER rerouted (caller wouldn't even call it,
//      but if it did, base must also be absent → returns null, no false reroute)
//  (3) non-suffixed keys (material, fit_type) return null (no-op)
function containerKeyFallback(schemaKeys, spApiKey) {
  const base = spApiKey.replace(/_(?:style|type|description)$/, '')
  if (base === spApiKey || !base) return null
  return schemaKeys.has(base) ? base : null
}

const SHIRT = new Set(['neck', 'sleeve', 'closure', 'fit_type', 'material', 'department', 'color', 'size', 'style'])
const FLAT = new Set(['neck_style', 'sleeve_type', 'material'])   // hypothetical legacy flat-key apparel type

let pass = 0, fail = 0
const eq = (n, g, w) => { if (g === w) { pass++; console.log('  ok  ', n) } else { fail++; console.log('  FAIL', n, '\n    got ', JSON.stringify(g), '\n    want', JSON.stringify(w)) } }

// (1) SHIRT — the live failure: suffixed keys reroute to containers
eq('SHIRT neck_style -> neck', containerKeyFallback(SHIRT, 'neck_style'), 'neck')
eq('SHIRT sleeve_type -> sleeve', containerKeyFallback(SHIRT, 'sleeve_type'), 'sleeve')
eq('SHIRT closure_type -> closure', containerKeyFallback(SHIRT, 'closure_type'), 'closure')
eq('SHIRT length_description -> (none, no length container)', containerKeyFallback(SHIRT, 'length_description'), null)

// (2) zero-regression: a key that EXISTS is never sent here (caller guards), but if it were,
//     and its base is absent, no false reroute. material has no suffix → null.
eq('SHIRT material (no suffix) -> null', containerKeyFallback(SHIRT, 'material'), null)
eq('SHIRT fit_type base "fit" absent -> null (NOT rerouted to a non-existent "fit")', containerKeyFallback(SHIRT, 'fit_type'), null)

// (3) FLAT-KEY type: caller only calls fallback when the key is ABSENT. neck_style EXISTS in FLAT,
//     so the caller's attributeExistsInSchema(neck_style)=true → fallback NEVER invoked → no reroute.
//     Proven by: the guard. But even if invoked with an absent suffixed key whose base is absent → null.
eq('FLAT type unknown collar_style, base "collar" absent -> null', containerKeyFallback(FLAT, 'collar_style'), null)

// (4) the critical zero-regression assertion: fit_type must NOT reroute to "fit" (would break — "fit" isn't a key)
eq('fit_type never rerouted to bare fit', containerKeyFallback(SHIRT, 'fit_type'), null)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
